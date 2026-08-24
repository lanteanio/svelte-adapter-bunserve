import { test } from 'node:test';
import assert from 'node:assert/strict';

// The pressure/protection + flow-control surface, tested at the same seams
// the sibling adapter tests it: the pure lease state machine and sizing math,
// the bounded backpressure fold, the pressure-reason precedence corpus, the
// kernel-source parsers, and - through the sim harness - the real hello/lease
// handshake against the production dispatch.

import {
	DEFAULT_GRANT,
	MAX_QUEUED_REQUESTS,
	createLeaseState,
	leaseGrantSize,
	leasePressureValue,
	samplePressureValue
} from '../../src/runtime/utils/lease.js';
import {
	BACKPRESSURE_SAMPLE_CAP,
	BACKPRESSURE_SAMPLE_THRESHOLD_BYTES,
	foldConnectionBackpressure
} from '../../src/runtime/utils/backpressure.js';
import {
	applyCapacityReason,
	computePressureReason,
	computeTopPublishers,
	createPosture
} from '../../src/runtime/utils/pressure.js';
import {
	createOsPressureSampler,
	parseCpuStat,
	parsePsi
} from '../../src/runtime/utils/os-pressure.js';
import {
	CONSUMED_CONTROL_TYPES,
	isConsumedControlType,
	leaseGrantFrame,
	requestNFrame
} from '../../src/runtime/utils/control-frame.js';

// pressure-metrics rides the handler graph, which reads its build-injected
// config from globals at import - same preamble as api-parity.test.mjs.
globalThis.ENV_PREFIX ??= '';
globalThis.WS_OPTIONS ??= null;
globalThis.WS_PATH ??= '/ws';
const { register } = await import('node:module');
register('../helpers/ws-handler-loader.mjs', import.meta.url);
const { resolvePressureThresholds } = await import('../../src/runtime/handler/pressure-metrics.js');

// Baseline thresholds for reason/value tests: every process-local signal
// enabled at a known level, kernel signals enabled at the defaults.
const T = {
	memoryHeapUsedRatio: 0.85,
	publishRatePerSec: 10000,
	subscriberRatio: 50,
	topicPublishRatePerSec: 5000,
	topicPublishBytesPerSec: 10 * 1024 * 1024,
	psiCpuSome: 60,
	psiMemoryFull: 15,
	psiIoFull: 50,
	cpuThrottledRatio: 0.25
};

const idle = { heapUsedRatio: 0.1, publishRate: 0, subscriberRatio: 0 };

test('createLeaseState: a window is permits plus an ABSOLUTE deadline', () => {
	let t = 1000;
	const gate = createLeaseState({ requestCount: 3, ttlMs: 100, now: () => t });
	assert.equal(gate.live(), false, 'no window before the first grant');
	gate.grant();
	assert.equal(gate.expiresAt(), 1100, 'deadline fixed at grant time');
	assert.equal(gate.available(), 3);
	assert.equal(gate.tryAcquire(), true);
	assert.equal(gate.tryAcquire(), true);
	assert.equal(gate.available(), 1);
	// The deadline is a clock comparison, never a countdown: jumping the
	// clock past it kills the window even though permits remain.
	t = 1101;
	assert.equal(gate.live(), false);
	assert.equal(gate.tryAcquire(), false, 'expired window refuses without consuming');
	assert.equal(gate.available(), 1, 'refusal consumed nothing');
	// A stalled event loop cannot extend the window: the deadline was fixed
	// at grant, so re-reading it later never moves it.
	assert.equal(gate.expiresAt(), 1100);
});

test('createLeaseState: spent window refuses, queue is bounded, requestN drains FIFO', () => {
	let t = 0;
	const gate = createLeaseState({ requestCount: 1, ttlMs: 1000, maxQueue: 2, now: () => t });
	gate.grant();
	assert.equal(gate.tryAcquire(), true);
	assert.equal(gate.tryAcquire(), false, 'window spent');
	assert.equal(gate.enqueue('a'), true);
	assert.equal(gate.enqueue('b'), true);
	assert.equal(gate.enqueue('c'), false, 'past the bound is refused, not buffered');
	assert.equal(gate.queued(), 2);
	// Re-grant covers one: FIFO order, remainder stays queued.
	const drained = gate.requestN(1, 1000);
	assert.deepEqual(drained, ['a']);
	assert.equal(gate.queued(), 1);
	assert.equal(gate.available(), 0, 'the drain consumed the new window');
	// A wider re-grant drains the rest and leaves permits.
	const rest = gate.requestN(5, 1000);
	assert.deepEqual(rest, ['b']);
	assert.equal(gate.available(), 4);
});

test('leasePressureValue: direction, clamp, and the no-window fallback', () => {
	assert.equal(leasePressureValue({ granted: 4, available: 4 }), 0, 'idle reads 0');
	assert.equal(leasePressureValue({ granted: 4, available: 2 }), 0.5);
	assert.equal(leasePressureValue({ granted: 4, available: 0 }), 1, 'exhausted reads 1');
	assert.equal(leasePressureValue({ granted: 4, available: -1 }), 1, 'negative clamps');
	assert.equal(leasePressureValue({ granted: 0, available: 0, fallback: 0.3 }), 0.3,
		'no window returns the caller fallback');
	assert.equal(leasePressureValue({ granted: 0, available: 0, fallback: 7 }), 1, 'fallback clamps');
	assert.equal(leasePressureValue({ granted: 0, available: 0 }), 0, 'fallback defaults to 0');
});

test('leaseGrantSize: full base when healthy, shrinks under load, always floors', () => {
	assert.equal(leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 1 }), DEFAULT_GRANT.requestCount);
	// Heap over 0.7 scales by remaining headroom: 0.9 -> 10% of base.
	assert.equal(leaseGrantSize({ heapRatio: 0.9, subscriberRatio: 1 }), Math.round(256 * 0.1));
	// Subscriber ratio over 25 scales by 25/ratio: 50 -> half the base.
	assert.equal(leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 50 }), 128);
	// The combined scale is floored at 0.05, and the count at `floor`.
	assert.equal(leaseGrantSize({ heapRatio: 0.99, subscriberRatio: 10000 }), Math.max(8, Math.round(256 * 0.05)));
	assert.equal(leaseGrantSize({ heapRatio: 0.99, subscriberRatio: 10000, base: 100 }), 8, 'floor holds');
	// A window never exceeds the base.
	assert.equal(leaseGrantSize({ heapRatio: 0, subscriberRatio: 0 }), 256);
});

test('samplePressureValue: idle 0, worst-of fold, gate-peak lift, false disables, clamp', () => {
	assert.equal(samplePressureValue(idle, T, 0), 0.1 / 0.85, 'heap headroom is the only signal at idle');
	// Worst-of: the publish signal dominates when closest to its threshold.
	const busy = { heapUsedRatio: 0.1, publishRate: 9000, subscriberRatio: 10 };
	assert.equal(samplePressureValue(busy, T, 0), 0.9);
	// The lease peak lifts the value even when counters look calm.
	assert.equal(samplePressureValue(idle, T, 0.95), 0.95);
	// Disabling a signal removes its contribution entirely.
	const noHeap = { ...T, memoryHeapUsedRatio: false, publishRatePerSec: false, subscriberRatio: false };
	assert.equal(samplePressureValue(idle, noHeap, 0), 0);
	// Breach clamps at 1.
	assert.equal(samplePressureValue({ heapUsedRatio: 5, publishRate: 0, subscriberRatio: 0 }, T, 0), 1);
	// Kernel fields contribute only when present.
	assert.equal(samplePressureValue({ ...idle, psiCpuSome10: 30 }, T, 0), 0.5);
});

test('foldConnectionBackpressure: worst queue, strict threshold, throw-as-zero, cap', () => {
	const conn = (amt) => ({ getBufferedAmount: () => amt });
	assert.deepEqual(foldConnectionBackpressure([], 10, 100),
		{ maxBufferedBytes: 0, backpressuredConnections: 0, sampled: 0 });
	const r = foldConnectionBackpressure([conn(50), conn(150), conn(100)], 10, 100);
	assert.equal(r.maxBufferedBytes, 150);
	assert.equal(r.backpressuredConnections, 1, 'strictly greater: 100 at threshold 100 does not count');
	// A connection closing mid-walk throws; it counts as 0, already gone.
	const throwing = { getBufferedAmount: () => { throw new Error('closed'); } };
	const r2 = foldConnectionBackpressure([throwing, conn(200)], 10, 100);
	assert.equal(r2.maxBufferedBytes, 200);
	assert.equal(r2.backpressuredConnections, 1);
	// The walk is cap-bounded: a prefix, not the whole set.
	const many = Array.from({ length: 8 }, () => conn(500));
	const r3 = foldConnectionBackpressure(many, 3, 100);
	assert.equal(r3.sampled, 3);
	assert.equal(r3.backpressuredConnections, 3);
	// The default constants are part of the sampler's documented contract.
	assert.equal(BACKPRESSURE_SAMPLE_CAP, 1024);
	assert.equal(BACKPRESSURE_SAMPLE_THRESHOLD_BYTES, 64 * 1024);
});

test('computePressureReason: fixed precedence, >= comparisons, false disables', () => {
	assert.equal(computePressureReason(idle, T), 'NONE');
	assert.equal(computePressureReason({ heapUsedRatio: 0.85, publishRate: 99999, subscriberRatio: 999 }, T),
		'MEMORY', 'memory beats everything, and >= fires at the threshold exactly');
	assert.equal(computePressureReason({ ...idle, cpuThrottledRatio: 0.3, psiCpuSome10: 99 }, T),
		'CPU_QUOTA', 'cpu quota beats psi');
	assert.equal(computePressureReason({ ...idle, psiMemoryFull10: 20, publishRate: 99999 }, T),
		'PSI', 'psi beats publish rate');
	assert.equal(computePressureReason({ heapUsedRatio: 0.1, publishRate: 10000, subscriberRatio: 999 }, T),
		'PUBLISH_RATE', 'publish rate beats subscribers');
	assert.equal(computePressureReason({ heapUsedRatio: 0.1, publishRate: 0, subscriberRatio: 50 }, T),
		'SUBSCRIBERS');
	// Disabling a signal silences it; the next in precedence answers.
	assert.equal(computePressureReason({ heapUsedRatio: 0.99, publishRate: 99999, subscriberRatio: 1 },
		{ ...T, memoryHeapUsedRatio: false }), 'PUBLISH_RATE');
	// Absent kernel fields never fire regardless of threshold.
	assert.equal(computePressureReason(idle, { ...T, psiCpuSome: 0.0001 }), 'NONE');
});

test('applyCapacityReason: MEMORY passes through, engaged posture reads CAPACITY', () => {
	assert.equal(applyCapacityReason('MEMORY', 'siege'), 'MEMORY');
	assert.equal(applyCapacityReason('NONE', 'elevated'), 'CAPACITY');
	assert.equal(applyCapacityReason('PUBLISH_RATE', 'siege'), 'CAPACITY');
	assert.equal(applyCapacityReason('PUBLISH_RATE', 'normal'), 'PUBLISH_RATE');
});

test('createPosture: asymmetric dwell, siege needs sustained over-capacity, 429s are inert', () => {
	const posture = createPosture({ admission: { maxConcurrent: 10 } });
	assert.equal(posture.level, 'normal');
	// Escalate after 5 consecutive active samples, not before.
	for (let i = 0; i < 4; i++) posture.tick({ active: true });
	assert.equal(posture.level, 'normal');
	posture.tick({ active: true });
	assert.equal(posture.level, 'elevated');
	// Siege needs the over-capacity reject rate (>= 2x the ceiling) sustained.
	for (let i = 0; i < 10; i++) {
		for (let j = 0; j < 25; j++) posture.recordCapacityReject();
		posture.tick({ active: true });
	}
	assert.equal(posture.level, 'siege');
	// Relaxation steps ONE level per dwell; siege never skips to normal.
	for (let i = 0; i < 10; i++) posture.tick({ active: false });
	assert.equal(posture.level, 'elevated');
	for (let i = 0; i < 10; i++) posture.tick({ active: false });
	assert.equal(posture.level, 'normal');

	// A rate-limit reject storm cannot escalate anything.
	const calm = createPosture({ admission: { maxConcurrent: 10 } });
	for (let i = 0; i < 20; i++) {
		for (let j = 0; j < 100; j++) calm.recordRateLimitReject();
		calm.tick({ active: false });
	}
	assert.equal(calm.level, 'normal');

	// A pinned level only decays; it never moves.
	const pinned = createPosture({ admission: { maxConcurrent: 10 }, pin: 'siege' });
	for (let i = 0; i < 30; i++) pinned.tick({ active: false });
	assert.equal(pinned.level, 'siege');
});

test('computeTopPublishers: per-second rates, top-5 by message rate, threshold fires on either axis', () => {
	const stats = new Map([
		['a', { m: 10, b: 100 }],
		['b', { m: 50, b: 10 }],
		['c', { m: 5, b: 30 * 1024 * 1024 }],
		['d', { m: 1, b: 1 }],
		['e', { m: 2, b: 2 }],
		['f', { m: 3, b: 3 }]
	]);
	const { topPublishers, overThreshold } = computeTopPublishers(stats, 2, {
		topicPublishRatePerSec: 20, topicPublishBytesPerSec: 10 * 1024 * 1024
	});
	assert.equal(topPublishers.length, 5, 'top five only');
	assert.equal(topPublishers[0].topic, 'b');
	assert.equal(topPublishers[0].messagesPerSec, 25, 'window counts divided by the interval');
	assert.deepEqual(overThreshold.map((e) => e.topic).sort(), ['b', 'c'],
		'message rate fired b, byte rate fired c');
	// false disables an axis entirely.
	const off = computeTopPublishers(stats, 2, { topicPublishRatePerSec: false, topicPublishBytesPerSec: false });
	assert.equal(off.overThreshold.length, 0);
});

test('os-pressure: psi and cpu.stat parse, deltas baseline at zero, failed probe disables for good', () => {
	assert.deepEqual(
		parsePsi('some avg10=1.25 avg60=0.80 avg300=0.30 total=123\nfull avg10=0.50 avg60=0.10 avg300=0.05 total=45\n'),
		{ some10: 1.25, full10: 0.5 }
	);
	assert.deepEqual(parseCpuStat('usage_usec 100\nnr_periods 5\nnr_throttled 2\nthrottled_usec 5000\n'),
		{ nrThrottled: 2, throttledUsec: 5000 });
	// v1 reports nanoseconds; normalized to microseconds.
	assert.deepEqual(parseCpuStat('nr_periods 5\nnr_throttled 2\nthrottled_time 5000000\n'),
		{ nrThrottled: 2, throttledUsec: 5000 });
	assert.equal(parseCpuStat('usage_usec 100\n'), null, 'no throttling fields at all');

	// A sampler over injected files: the first cpu sample is the baseline and
	// reports zeros; the second reports the delta as a ratio of the window.
	let throttled = 0;
	const files = {
		'/proc/pressure/cpu': 'some avg10=2.0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n',
		'/proc/pressure/memory': 'some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=1.0 avg60=0 avg300=0 total=0\n',
		'/proc/pressure/io': 'some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=3.0 avg60=0 avg300=0 total=0\n',
		'/sys/fs/cgroup/cpu.stat': () => `nr_throttled 1\nthrottled_usec ${throttled}\n`
	};
	const sampler = createOsPressureSampler({
		readFile: (p) => {
			const f = files[p];
			if (f === undefined) throw new Error('missing');
			return typeof f === 'function' ? f() : f;
		}
	});
	const first = sampler.sample(1000);
	assert.deepEqual(first.psi, { cpuSome10: 2.0, memoryFull10: 1.0, ioFull10: 3.0 });
	assert.deepEqual(first.cpuThrottle, { throttledRatio: 0, nrThrottledDelta: 0 }, 'baseline sample');
	throttled = 500_000;
	const second = sampler.sample(1000);
	assert.equal(second.cpuThrottle.throttledRatio, 0.5, '500ms throttled in a 1000ms window');
	// The ratio clamps at 1 however large the delta.
	throttled = 100_000_000;
	assert.equal(sampler.sample(1000).cpuThrottle.throttledRatio, 1);

	// A host without the sources: the startup probe fails once and the
	// sampler answers nulls forever at no further cost.
	const none = createOsPressureSampler({ readFile: () => { throw new Error('ENOENT'); } });
	assert.deepEqual(none.sample(1000), { psi: null, cpuThrottle: null });
	assert.deepEqual(none.sample(1000), { psi: null, cpuThrottle: null });
});

test('resolvePressureThresholds: defaults, override merge, interval clamp', () => {
	const d = resolvePressureThresholds(undefined);
	// Disabled by default on this engine (see pressure-metrics.js): an idle
	// server measures 0.90-0.94 on Bun 1.3.14 and 0.81 on 1.4.0, so the
	// family's 0.85 fires or flaps on a healthy process. Opting back in is
	// one option key.
	assert.equal(d.memoryHeapUsedRatio, false);
	assert.equal(resolvePressureThresholds({ memoryHeapUsedRatio: 0.85 }).memoryHeapUsedRatio, 0.85,
		'the sibling threshold is one option away');
	assert.equal(d.publishRatePerSec, 10000);
	assert.equal(d.subscriberRatio, 50);
	assert.equal(d.sampleIntervalMs, 1000);
	assert.equal(d.topicPublishRatePerSec, 5000);
	assert.equal(d.topicPublishBytesPerSec, 10 * 1024 * 1024);
	const o = resolvePressureThresholds({ publishRatePerSec: false, sampleIntervalMs: 250 });
	assert.equal(o.publishRatePerSec, false);
	assert.equal(o.sampleIntervalMs, 250);
	assert.equal(resolvePressureThresholds({ sampleIntervalMs: 5 }).sampleIntervalMs, 1000,
		'a pathological interval resets to the default');
});

test('lease control frames: exact wire shapes, demux-consumed type', () => {
	assert.equal(leaseGrantFrame(256, 10000), '{"type":"lease","count":256,"ttlMs":10000}');
	assert.equal(leaseGrantFrame(8.9, 10000.7), '{"type":"lease","count":8,"ttlMs":10000}',
		'integer serialization, never floats on the wire');
	assert.equal(requestNFrame(64), '{"type":"request-n","n":64}');
	assert.ok(CONSUMED_CONTROL_TYPES.includes('request-n'));
	assert.ok(isConsumedControlType(requestNFrame(64)));
	assert.equal(DEFAULT_GRANT.requestCount, 256);
	assert.equal(DEFAULT_GRANT.ttlMs, 10000);
	assert.equal(MAX_QUEUED_REQUESTS, 256);
});

test('every kernel signal folds through its OWN threshold, not a neighbours', () => {
	// Four near-identical blocks: the highest-probability copy-paste site in
	// the fold. Each is driven alone, at a value that is unambiguous against
	// the OTHER thresholds, so a crossed pairing changes the result.
	assert.equal(samplePressureValue({ ...idle, psiCpuSome10: 30 }, T, 0), 30 / 60);
	assert.equal(samplePressureValue({ ...idle, psiMemoryFull10: 3 }, T, 0), 3 / 15);
	assert.equal(samplePressureValue({ ...idle, psiIoFull10: 20 }, T, 0), 20 / 50);
	assert.equal(samplePressureValue({ ...idle, cpuThrottledRatio: 0.05 }, T, 0), 0.05 / 0.25);
	// Disabling one kernel signal must not silence the others.
	assert.equal(
		samplePressureValue({ ...idle, psiIoFull10: 20 }, { ...T, psiCpuSome: false }, 0),
		20 / 50
	);
	// An absent field never fires, however low the threshold.
	assert.equal(samplePressureValue(idle, { ...T, psiIoFull: 0.0001 }, 0), 0.1 / 0.85);
});

test('each PSI axis can raise the reason on its own', () => {
	// The PSI arm is a three-way disjunction; only one disjunct was covered by
	// the precedence corpus, so a crossed comparison in either of the others
	// would never have shown up.
	const quiet = { ...T, memoryHeapUsedRatio: false, cpuThrottledRatio: false };
	assert.equal(computePressureReason({ ...idle, psiCpuSome10: 60 }, quiet), 'PSI');
	assert.equal(computePressureReason({ ...idle, psiMemoryFull10: 15 }, quiet), 'PSI');
	assert.equal(computePressureReason({ ...idle, psiIoFull10: 50 }, quiet), 'PSI');
	// Just under each threshold stays quiet - pinning the comparison direction.
	assert.equal(computePressureReason({ ...idle, psiCpuSome10: 59.9 }, quiet), 'NONE');
	assert.equal(computePressureReason({ ...idle, psiMemoryFull10: 14.9 }, quiet), 'NONE');
	assert.equal(computePressureReason({ ...idle, psiIoFull10: 49.9 }, quiet), 'NONE');
});

test('leaseGrantSize engages exactly at its documented knees', () => {
	// The knees ARE the tuning contract; every earlier case sat far from them,
	// so moving 0.7 to 0.6 or 25 to 30 would have passed.
	assert.equal(leaseGrantSize({ heapRatio: 0.7, subscriberRatio: 0 }), 256,
		'at 0.7 the heap knee is not yet engaged');
	assert.ok(leaseGrantSize({ heapRatio: 0.701, subscriberRatio: 0 }) < 256,
		'just past it, the window narrows');
	assert.equal(leaseGrantSize({ heapRatio: 0, subscriberRatio: 25 }), 256,
		'at 25 the subscriber knee is not yet engaged');
	assert.ok(leaseGrantSize({ heapRatio: 0, subscriberRatio: 25.1 }) < 256,
		'just past it, the window narrows');
});

test('createLeaseState.grant honours explicit arguments, and requestN ignores the clock', () => {
	let t = 0;
	const gate = createLeaseState({ requestCount: 4, ttlMs: 1000, now: () => t });
	gate.grant(9, 50);
	assert.equal(gate.granted(), 9, 'an explicit count wins over the configured one');
	assert.equal(gate.expiresAt(), 50, 'and so does an explicit ttl');
	gate.grant();
	assert.equal(gate.granted(), 4, 'argless falls back to the configured window');
	assert.equal(gate.expiresAt(), 1000);

	// requestN drains on permits alone: a zero-ttl re-grant is dead the instant
	// it is created, yet still releases queued work. Pinned because it differs
	// from tryAcquire, which does check the clock.
	gate.grant(0, 0);
	assert.equal(gate.enqueue('x'), true);
	assert.deepEqual(gate.requestN(1, 0), ['x'], 'the queued item drains despite the dead window');
	assert.equal(gate.live(), false);
	assert.equal(gate.tryAcquire(), false, 'while tryAcquire refuses on the same state');
});

test('createPosture reports its reject rate with decay, and announces transitions once', () => {
	const seen = [];
	const posture = createPosture({
		admission: { maxConcurrent: 10 },
		onTransition: (from, to) => { seen.push(from + '->' + to); }
	});
	assert.equal(posture.rejectedPerSecond, 0);
	posture.recordCapacityReject();
	posture.recordCapacityReject();
	assert.equal(posture.rejectedPerSecond, 2, 'fresh rejects are visible before any tick');
	posture.tick({ active: false });
	assert.equal(posture.rejectedPerSecond, 2, 'folded into the rolling rate');
	posture.tick({ active: false });
	assert.equal(posture.rejectedPerSecond, 1, 'and decays by half on a quiet tick');

	// A 429 storm must never move the rate the escalation reads.
	for (let i = 0; i < 50; i++) posture.recordRateLimitReject();
	assert.equal(posture.rejectedPerSecond, 1, 'rate-limit rejects are accounted separately');

	assert.deepEqual(seen, [], 'no transition yet');
	for (let i = 0; i < 5; i++) posture.tick({ active: true });
	assert.deepEqual(seen, ['normal->elevated'], 'the observer is told once, in order');
});

test('a throwing transition observer cannot wedge the posture machine', () => {
	const posture = createPosture({
		admission: { maxConcurrent: 10 },
		onTransition: () => { throw new Error('observer boom'); }
	});
	for (let i = 0; i < 5; i++) posture.tick({ active: true });
	assert.equal(posture.level, 'elevated', 'the level still advanced');
	for (let i = 0; i < 10; i++) posture.tick({ active: false });
	assert.equal(posture.level, 'normal', 'and still relaxes afterwards');
});

test('os-pressure: a LATER read failure is transient, only a failed startup probe disables', () => {
	let fail = false;
	const psi = 'some avg10=1.0 avg60=0 avg300=0 total=0\nfull avg10=2.0 avg60=0 avg300=0 total=0\n';
	const sampler = createOsPressureSampler({
		readFile: (p) => {
			if (fail) throw new Error('EIO');
			if (p.startsWith('/proc/pressure/')) return psi;
			throw new Error('ENOENT');
		}
	});
	assert.equal(sampler.sample(1000).psi.cpuSome10, 1.0, 'the startup probe succeeded');
	fail = true;
	assert.equal(sampler.sample(1000).psi, null, 'a transient failure reports nothing for that sample');
	fail = false;
	assert.equal(sampler.sample(1000).psi.cpuSome10, 1.0, 'and the source stays armed for the next one');
});

test('os-pressure: the cgroup v1 layout is found by falling through the path list', () => {
	const seen = [];
	const sampler = createOsPressureSampler({
		readFile: (p) => {
			seen.push(p);
			if (p.startsWith('/proc/pressure/')) throw new Error('ENOENT');
			// Only the v1 layout answers, and only in nanoseconds.
			if (p.includes('cpuacct')) {
				return 'nr_periods 10\nnr_throttled 4\nthrottled_time 2000000\n';
			}
			throw new Error('ENOENT');
		}
	});
	const first = sampler.sample(1000);
	assert.deepEqual(first.cpuThrottle, { throttledRatio: 0, nrThrottledDelta: 0 }, 'baseline sample');
	assert.ok(seen.some((p) => p.includes('cpuacct')), 'the v1 path was reached by falling through');
	const second = sampler.sample(1000);
	assert.equal(second.cpuThrottle.nrThrottledDelta, 0, 'no new throttling between identical reads');
});

test('os-pressure: the throttle delta counts periods as well as time', () => {
	let nr = 1;
	let usec = 0;
	const sampler = createOsPressureSampler({
		readFile: (p) => {
			if (p.startsWith('/proc/pressure/')) throw new Error('ENOENT');
			if (p === '/sys/fs/cgroup/cpu.stat') return 'nr_throttled ' + nr + '\nthrottled_usec ' + usec + '\n';
			throw new Error('ENOENT');
		}
	});
	sampler.sample(1000);
	nr = 4;
	usec = 250000;
	const s = sampler.sample(1000);
	assert.equal(s.cpuThrottle.nrThrottledDelta, 3, 'three new throttled periods');
	assert.equal(s.cpuThrottle.throttledRatio, 0.25, 'a quarter of the window suspended');
});
