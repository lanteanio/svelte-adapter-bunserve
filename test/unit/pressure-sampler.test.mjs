import { test } from 'node:test';
import assert from 'node:assert/strict';

// The SAMPLER itself, driven end to end. samplePressure is module-private and
// only ever reached through the 1 Hz timer, so these tests install a runtime
// env whose interval timer hands the callback back instead of scheduling it -
// the seam exists precisely so the fold can be driven a tick at a time.
//
// Everything the surface promises lives here: rates computed over the window,
// the window drained, onPressure firing ONLY on reason transitions, an
// onPublishRate listener replacing the default warning, the saturation peak
// decaying, the posture ticking on the BASE reason while the snapshot carries
// the layered one, and listener throws staying contained.

globalThis.ENV_PREFIX ??= '';
globalThis.WS_OPTIONS ??= null;
globalThis.WS_PATH ??= '/ws';

const {
	grantSizeFor, resolvePressureThresholds, startPressureSampling, stopPressureSampling
} = await import('../../src/runtime/handler/pressure-metrics.js');
const {
	lastPublishWarnAt, pressureListeners, pressureSnapshot, publishRateListeners,
	topicPublishStats, wsConnections, wsCounters
} = await import('../../src/runtime/handler/ws-state.js');
const { setRuntimeEnv, resetRuntimeEnv } = await import('../../src/runtime/runtime.js');
const { leaseGrantSize } = await import('../../src/runtime/utils/lease.js');

/**
 * Start the sampler against a captured interval timer and return a `tick()`
 * that runs exactly one sample. Also resets every piece of state the sampler
 * reads or writes, so tests cannot contaminate each other.
 */
function sampler(opts) {
	wsConnections.clear();
	topicPublishStats.clear();
	lastPublishWarnAt.clear();
	pressureListeners.clear();
	publishRateListeners.clear();
	wsCounters.publishCountWindow = 0;
	wsCounters.lastPublishCount = 0;
	wsCounters.totalSubscriptions = 0;
	wsCounters.leaseSaturationPeak = 0;
	wsCounters.activePosture = null;
	wsCounters.metricsSampleHook = null;
	wsCounters.postureExportHook = null;
	wsCounters.lastSampleWallMs = 0;
	pressureSnapshot.reason = 'NONE';
	pressureSnapshot.active = false;
	pressureSnapshot.topPublishers = [];

	let captured = null;
	let cleared = 0;
	setRuntimeEnv({
		timers: {
			setInterval: (cb) => { captured = cb; return { unref() {} }; },
			clearInterval: () => { cleared++; }
		}
	}, { force: true });
	startPressureSampling(opts);
	return { tick: () => captured(), clearedCount: () => cleared };
}

function done() {
	stopPressureSampling();
	resetRuntimeEnv();
}

/** Thresholds that keep every process-local signal quiet unless a test asks. */
const QUIET = {
	memoryHeapUsedRatio: false, publishRatePerSec: false, subscriberRatio: false,
	topicPublishRatePerSec: false, topicPublishBytesPerSec: false,
	psiCpuSome: false, psiMemoryFull: false, psiIoFull: false, cpuThrottledRatio: false
};

test('the window is drained into a per-second rate and zeroed for the next sample', () => {
	const s = sampler({ ...QUIET, sampleIntervalMs: 500 });
	try {
		wsCounters.publishCountWindow = 21;
		s.tick();
		assert.equal(pressureSnapshot.publishRate, 42, '21 publishes in a 500ms window is 42/s');
		assert.equal(wsCounters.publishCountWindow, 0, 'window zeroed for the next sample');
		assert.equal(wsCounters.lastPublishCount, 21, 'the raw count is retained for the metrics hook');
		s.tick();
		assert.equal(pressureSnapshot.publishRate, 0, 'an idle window reads zero, not the previous rate');
	} finally { done(); }
});

test('per-topic stats become rates, feed topPublishers, and are cleared each window', () => {
	const s = sampler({ ...QUIET, sampleIntervalMs: 1000 });
	try {
		topicPublishStats.set('busy', { m: 30, b: 3000 });
		topicPublishStats.set('quiet', { m: 1, b: 10 });
		s.tick();
		assert.deepEqual(pressureSnapshot.topPublishers, [
			{ topic: 'busy', messagesPerSec: 30, bytesPerSec: 3000 },
			{ topic: 'quiet', messagesPerSec: 1, bytesPerSec: 10 }
		], 'sorted by message rate, per second');
		assert.equal(topicPublishStats.size, 0, 'the source map is cleared, so counts cannot compound');
		s.tick();
		assert.deepEqual(pressureSnapshot.topPublishers, [], 'a window with no publishes reports none');
	} finally { done(); }
});

test('onPressure fires ONLY when the reason changes, with the live snapshot', () => {
	const s = sampler({ ...QUIET, publishRatePerSec: 100, sampleIntervalMs: 1000 });
	try {
		const seen = [];
		pressureListeners.add((snap) => { seen.push(snap.reason); });

		s.tick();
		assert.deepEqual(seen, [], 'NONE to NONE is not a transition');

		wsCounters.publishCountWindow = 500;
		s.tick();
		assert.deepEqual(seen, ['PUBLISH_RATE'], 'crossing the threshold fires once');

		wsCounters.publishCountWindow = 900;
		s.tick();
		assert.deepEqual(seen, ['PUBLISH_RATE'], 'staying over the threshold does NOT fire again');

		s.tick();
		assert.deepEqual(seen, ['PUBLISH_RATE', 'NONE'], 'falling back fires the recovery transition');
		assert.equal(pressureSnapshot.active, false);
	} finally { done(); }
});

test('a throwing pressure listener is contained and the rest still run', () => {
	const s = sampler({ ...QUIET, publishRatePerSec: 100, sampleIntervalMs: 1000 });
	const realError = console.error;
	const errors = [];
	console.error = (...a) => { errors.push(a[0]); };
	try {
		let reached = false;
		pressureListeners.add(() => { throw new Error('listener boom'); });
		pressureListeners.add(() => { reached = true; });
		wsCounters.publishCountWindow = 500;
		s.tick();
		assert.equal(reached, true, 'the second listener still ran');
		assert.equal(errors[0], '[pressure] listener threw:');
	} finally { console.error = realError; done(); }
});

test('an onPublishRate listener replaces the default runaway warning', () => {
	const s = sampler({ ...QUIET, topicPublishRatePerSec: 10, sampleIntervalMs: 1000 });
	const realWarn = console.warn;
	let warned = 0;
	console.warn = () => { warned++; };
	try {
		topicPublishStats.set('runaway', { m: 50, b: 100 });
		s.tick();
		assert.equal(warned, 1, 'with no listener, the default throttled warning fires');

		const reports = [];
		publishRateListeners.add((over) => { reports.push(over); });
		topicPublishStats.set('runaway', { m: 50, b: 100 });
		s.tick();
		assert.equal(warned, 1, 'a registered listener SUPPRESSES the console warning');
		assert.equal(reports.length, 1);
		assert.deepEqual(reports[0], [{ topic: 'runaway', messagesPerSec: 50, bytesPerSec: 100 }]);
	} finally { console.warn = realWarn; done(); }
});

test('the default runaway warning is throttled per topic, not repeated every window', () => {
	const s = sampler({ ...QUIET, topicPublishRatePerSec: 10, sampleIntervalMs: 1000 });
	const realWarn = console.warn;
	let warned = 0;
	console.warn = () => { warned++; };
	try {
		for (let i = 0; i < 4; i++) {
			topicPublishStats.set('runaway', { m: 50, b: 100 });
			s.tick();
		}
		assert.equal(warned, 1, 'four over-threshold windows inside the throttle produce one line');
		assert.equal(lastPublishWarnAt.get('runaway') > 0, true, 'the topic is recorded in the dedup map');
	} finally { console.warn = realWarn; done(); }
});

test('the lease saturation peak lifts the value once, then decays by half', () => {
	const s = sampler({ ...QUIET, sampleIntervalMs: 1000 });
	try {
		wsCounters.leaseSaturationPeak = 1;
		s.tick();
		assert.equal(pressureSnapshot.value, 1, 'the peak folds into the worker value');
		assert.equal(wsCounters.leaseSaturationPeak, 0.5, 'and is halved so one spike does not stick');
		s.tick();
		assert.equal(pressureSnapshot.value, 0.5);
		assert.equal(wsCounters.leaseSaturationPeak, 0.25);
	} finally { done(); }
});

test('an engaged posture layers CAPACITY onto the snapshot but ticks on the BASE reason', () => {
	const s = sampler({ ...QUIET, publishRatePerSec: 100, sampleIntervalMs: 1000 });
	try {
		const ticks = [];
		wsCounters.activePosture = { level: 'elevated', tick: (snap) => { ticks.push(snap.active); } };

		s.tick();
		assert.equal(pressureSnapshot.reason, 'CAPACITY', 'an engaged posture shows as CAPACITY');
		assert.equal(pressureSnapshot.active, true, 'and counts as active pressure');
		assert.deepEqual(ticks, [false],
			'but the posture sees the BASE reason (calm) - otherwise it could never relax');
		assert.equal(wsCounters.lastBasePressureReason, 'NONE', 'the unlayered reason is retained');

		wsCounters.publishCountWindow = 500;
		s.tick();
		assert.deepEqual(ticks, [false, true], 'real load reaches the posture as active');
		assert.equal(pressureSnapshot.reason, 'CAPACITY');
	} finally { done(); }
});

test('MEMORY outranks an engaged posture, so a real OOM risk is never masked as CAPACITY', () => {
	const s = sampler({ ...QUIET, memoryHeapUsedRatio: 0, sampleIntervalMs: 1000 });
	try {
		wsCounters.activePosture = { level: 'siege', tick: () => {} };
		s.tick();
		assert.equal(pressureSnapshot.reason, 'MEMORY');
	} finally { done(); }
});

test('the export hooks run every sample, after the freshness stamp', () => {
	const s = sampler({ ...QUIET, sampleIntervalMs: 1000 });
	try {
		const stamps = [];
		wsCounters.metricsSampleHook = () => { stamps.push(['metrics', wsCounters.lastSampleWallMs]); };
		wsCounters.postureExportHook = () => { stamps.push(['posture', wsCounters.lastSampleWallMs]); };
		s.tick();
		assert.equal(stamps.length, 2);
		assert.equal(stamps[0][0], 'metrics');
		assert.equal(stamps[1][0], 'posture');
		assert.ok(stamps[0][1] > 0, 'the sample was stamped BEFORE the hook published it');
		assert.equal(wsCounters.lastSampleWallMs, stamps[1][1]);
	} finally { done(); }
});

test('backpressure aggregates come from a bounded walk of the live connections', () => {
	const s = sampler({ ...QUIET, sampleIntervalMs: 1000 });
	try {
		wsConnections.add({ getBufferedAmount: () => 10 });
		wsConnections.add({ getBufferedAmount: () => 200 * 1024 });
		wsConnections.add({ getBufferedAmount: () => { throw new Error('closed'); } });
		wsCounters.totalSubscriptions = 6;
		s.tick();
		assert.equal(pressureSnapshot.maxBufferedBytes, 200 * 1024, 'worst queue depth seen');
		assert.equal(pressureSnapshot.backpressuredConnections, 1, 'only the one past the threshold');
		assert.equal(pressureSnapshot.subscriberRatio, 2, '6 subscriptions across 3 connections');
	} finally { done(); }
});

test('starting twice replaces the timer rather than stacking samplers', () => {
	const s = sampler({ ...QUIET, sampleIntervalMs: 1000 });
	try {
		assert.equal(s.clearedCount(), 0, 'the first start had nothing to clear');
		startPressureSampling({ ...QUIET, sampleIntervalMs: 2000 });
		assert.equal(s.clearedCount(), 1, 'the second start cleared the first timer');
	} finally { done(); }
});

test('grantSizeFor wires the LIVE readings into the sizing math', () => {
	// The window must be a function of per-connection subscriber load - and of
	// nothing else on this engine, whose idle heap ratio would otherwise
	// collapse it. Computing the expectation from the same inputs the
	// implementation reads makes this exact rather than a range check: a
	// forgotten division, swapped arguments, or a constant return all fail.
	const before = wsConnections.size;
	try {
		wsConnections.clear();
		for (let i = 0; i < 4; i++) wsConnections.add({ getBufferedAmount: () => 0 });
		wsCounters.totalSubscriptions = 400;

		const g = grantSizeFor();
		assert.equal(g.count, leaseGrantSize({ heapRatio: 0, subscriberRatio: 100 }),
			'sized from subscriptions PER CONNECTION, with no heap term on this engine');
		assert.equal(g.ttlMs, 10000);

		// The heap term is deliberately absent: this engine reports 0.9+ on an
		// idle process, and feeding that to the 0.7 knee would collapse an
		// unloaded server's window. An idle server must get the full base.
		wsCounters.totalSubscriptions = 0;
		assert.equal(grantSizeFor().count, 256,
			'an idle server hands out the FULL window, whatever the live heap reads');
		wsCounters.totalSubscriptions = 400;

		// A heavier fan-out must narrow the window: the ratio is the input,
		// so the same subscription total over fewer connections grants less.
		wsCounters.totalSubscriptions = 4000;
		assert.ok(grantSizeFor().count < g.count, 'ten times the fan-out narrows the window');

		// With no connections at all the divisor floors at 1 rather than
		// producing Infinity or NaN.
		wsConnections.clear();
		wsCounters.totalSubscriptions = 0;
		const idle = grantSizeFor();
		assert.equal(Number.isInteger(idle.count), true);
		assert.equal(idle.count, 256, 'the divisor floors at 1 rather than producing NaN or Infinity');
		// Checked here, not in the `finally`: an assertion during unwinding
		// would replace the real failure's diagnostic with its own.
		assert.equal(before, 0, 'this test started from an empty connection set');
	} finally {
		wsConnections.clear();
		wsCounters.totalSubscriptions = 0;
	}
});

test('resolvePressureThresholds pins all ten defaults and clamps the interval both ways', () => {
	const d = resolvePressureThresholds(undefined);
	assert.deepEqual(d, {
		// OFF by default here, unlike the sibling's 0.85: this engine idles
		// with its heap mostly full (0.90-0.94 measured on Bun 1.3.14, 0.81
		// on 1.4.0), so the family threshold fires or flaps on a healthy
		// process. Pinned so the divergence can never become accidental.
		memoryHeapUsedRatio: false,
		publishRatePerSec: 10000,
		subscriberRatio: 50,
		sampleIntervalMs: 1000,
		topicPublishRatePerSec: 5000,
		topicPublishBytesPerSec: 10 * 1024 * 1024,
		psiCpuSome: 60,
		psiMemoryFull: 15,
		psiIoFull: 50,
		cpuThrottledRatio: 0.25
	}, 'every default is pinned, including the four kernel thresholds');

	assert.equal(resolvePressureThresholds({ sampleIntervalMs: 50 }).sampleIntervalMs, 1000,
		'under the floor resets to the default rather than spinning');
	assert.equal(resolvePressureThresholds({ sampleIntervalMs: 3e9 }).sampleIntervalMs, 2 ** 31 - 1,
		'past the timer ceiling is capped, because a larger delay silently becomes 1ms');
	assert.equal(resolvePressureThresholds({ publishRatePerSec: false }).publishRatePerSec, false,
		'false survives the merge and disables the signal');
});
