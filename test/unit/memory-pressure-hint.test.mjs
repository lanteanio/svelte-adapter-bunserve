import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryWallReader } from '../../src/runtime/utils/memory-wall.js';

globalThis.ENV_PREFIX ??= '';
globalThis.WS_OPTIONS ??= null;
globalThis.WS_PATH ??= '/ws';
const { startPressureSampling, stopPressureSampling, grantSizeFor, setPressureSourcesForTest } = await import('../../src/runtime/handler/pressure-metrics.js');
const { pressureSnapshot, wsCounters, wsConnections, pressureListeners, publishRateListeners, topicPublishStats } = await import('../../src/runtime/handler/ws-state.js');
const { setRuntimeEnv, resetRuntimeEnv } = await import('../../src/runtime/runtime.js');
const QUIET = {
	memoryHeapUsedRatio: 0.85, publishRatePerSec: false, subscriberRatio: false,
	topicPublishRatePerSec: false, topicPublishBytesPerSec: false,
	psiCpuSome: false, psiMemoryFull: false, psiIoFull: false, cpuThrottledRatio: false
};
const absent = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };

function setup(overrides = {}) {
	stopPressureSampling();
	wsConnections.clear();
	pressureListeners.clear();
	publishRateListeners.clear();
	topicPublishStats.clear();
	Object.assign(wsCounters, {
		publishCountWindow: 0, totalSubscriptions: 0, leaseSaturationPeak: 0,
		activePosture: null, metricsSampleHook: null, postureExportHook: null,
		lastSampleWallMs: 0, egressDeliveriesWindow: 0, egressBytesWindow: 0,
		egressRefusedTopicWindow: 0, egressRefusedTenantWindow: 0
	});
	Object.assign(pressureSnapshot, { reason: 'NONE', active: false, topPublishers: [] });
	let group = 'a';
	let present = true;
	let limit = '100';
	let unreadable = false;
	let groupsRead = 0;
	let measures = 0;
	let refreshes = 0;
	let osSamples = 0;
	let detached = 0;
	let cleared = 0;
	let extraTimers = 0;
	let time = 1000;
	const listeners = new Set();
	const timerCallbacks = [];
	const subscriptions = [];
	const reader = createMemoryWallReader({
		heapStatistics: () => ({ heap_size_limit: 0 }),
		readFile(path) {
			if (!present) return absent();
			if (unreadable && (path === '/proc/self/cgroup' || path === '/sys/fs/cgroup/a/memory.max')) {
				throw Object.assign(new Error('read denied'), { code: 'EACCES' });
			}
			if (path === '/proc/self/cgroup') { groupsRead++; return '0::/' + group; }
			if (path === '/sys/fs/cgroup/a/memory.max') return limit;
			if (path === '/sys/fs/cgroup/b/memory.max') return '30';
			if (path === '/sys/fs/cgroup/memory.max') return 'max';
			return absent();
		}
	});
	const controls = {
		subscribe(listener) {
			listeners.add(listener);
			subscriptions.push(listener);
			return () => { detached++; listeners.delete(listener); };
		},
		memoryWall: {
			measure(mem) { measures++; return reader.measure(mem); },
			refresh() { refreshes++; reader.refresh(); }
		},
		memoryUsage: () => ({ heapUsed: 10, rss: 30 }),
		osPressure: { sample() { osSamples++; return { psi: null, cpuThrottle: null }; } },
		...overrides
	};
	setRuntimeEnv({
		clock: { now: () => time, monotonic: () => time },
		timers: {
			setInterval(callback) { timerCallbacks.push(callback); return { unref() {} }; },
			clearInterval() { cleared++; },
			set() { extraTimers++; throw new Error('notification scheduled an extra timer'); }
		}
	}, { force: true });
	setPressureSourcesForTest(controls);
	return {
		start(options = QUIET) { startPressureSampling(options); },
		tick() { time += 1000; timerCallbacks.at(-1)(); },
		notify(level) { for (const listener of listeners) listener(level); },
		move() { group = 'b'; },
		present(value) { present = value; },
		unreadable(value) { unreadable = value; },
		limit(value) { limit = value; },
		counts: () => ({ groupsRead, measures, refreshes, osSamples, detached, cleared, extraTimers }),
		listeners, subscriptions, timerCallbacks,
		close() { stopPressureSampling(); setPressureSourcesForTest(null); resetRuntimeEnv(); }
	};
}

test('warning and critical bursts coalesce into next-tick cgroup rediscovery without draining counter windows early', () => {
	const s = setup();
	try {
		s.start();
		s.tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 0.3);
		assert.equal(s.counts().groupsRead, 1);
		s.move();
		s.tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 0.3, 'ordinary discovery keeps its existing cadence');
		wsCounters.publishCountWindow = 42;
		for (let i = 0; i < 100; i++) s.notify(i % 2 ? 'warning' : 'critical');
		assert.equal(wsCounters.publishCountWindow, 42);
		assert.equal(s.counts().measures, 2);
		assert.equal(s.counts().osSamples, 2);
		assert.equal(s.counts().refreshes, 0);
		assert.equal(s.timerCallbacks.length, 1);
		assert.equal(s.counts().extraTimers, 0);
		s.tick();
		assert.equal(pressureSnapshot.publishRate, 42);
		assert.equal(wsCounters.publishCountWindow, 0);
		assert.equal(s.counts().refreshes, 1);
		assert.equal(s.counts().groupsRead, 2);
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 1);
		assert.equal(pressureSnapshot.reason, 'MEMORY');
		wsCounters.publishCountWindow = 7;
		s.tick();
		assert.equal(pressureSnapshot.publishRate, 7);
		assert.equal(s.counts().refreshes, 1, 'the hint carries no sticky pressure state');
		assert.equal(s.counts().groupsRead, 2);
	} finally { s.close(); }
});

test('an unknown level is ignored and a native event cannot leak into a controlled environment', () => {
	const initial = process.listenerCount('memoryPressure');
	const s = setup();
	try {
		s.start();
		assert.equal(process.listenerCount('memoryPressure'), initial);
		s.notify('normal');
		s.notify(null);
		process.emit('memoryPressure', 'critical');
		s.tick();
		assert.equal(s.counts().refreshes, 0);
		assert.equal(pressureSnapshot.reason, 'NONE');
	} finally { s.close(); }
});

test('refresh revives a previously unavailable reader but an event alone never fabricates memory saturation', () => {
	const s = setup();
	try {
		s.present(false);
		s.start();
		s.notify('critical');
		s.tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, null);
		assert.equal(wsCounters.lastHeapUsedRatio, 0);
		assert.equal(pressureSnapshot.reason, 'NONE');
		assert.equal(pressureSnapshot.value, 0);
		assert.equal(grantSizeFor().count, 256);
		s.present(true);
		s.move();
		s.notify('warning');
		s.tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 1);
		assert.equal(pressureSnapshot.reason, 'MEMORY');
	} finally { s.close(); }
});

test('hinted rediscovery retains last-good walls on failed reads and retries membership at the next regular tick', () => {
	const s = setup();
	try {
		s.start();
		s.tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 0.3);
		s.move();
		s.unreadable(true);
		s.notify('critical');
		s.tick();
		assert.equal(s.counts().refreshes, 1);
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 0.3, 'a failed discovery does not erase the last measured wall');
		s.unreadable(false);
		s.tick();
		assert.equal(s.counts().refreshes, 1);
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 1, 'the failed membership read retries without another event');
	} finally { s.close(); }
});

test('memory threshold disabling preserves independent measured PSI behavior', () => {
	const s = setup({ osPressure: { sample: () => ({ psi: { cpuSome10: 0, memoryFull10: 20, ioFull10: 0 }, cpuThrottle: null }) } });
	try {
		s.move();
		s.start({ ...QUIET, memoryHeapUsedRatio: false, psiMemoryFull: 15 });
		s.notify('critical');
		s.tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 1);
		assert.equal(pressureSnapshot.reason, 'PSI');
		assert.equal(pressureSnapshot.value, 1);
	} finally { s.close(); }
});

test('replacement and stop remove subscriptions and discard pending or stale callbacks', () => {
	const s = setup();
	try {
		s.start();
		const oldNotification = s.subscriptions[0];
		const oldTick = s.timerCallbacks[0];
		s.notify('critical');
		s.start();
		assert.equal(s.listeners.size, 1);
		assert.equal(s.counts().detached, 1);
		oldNotification('critical');
		oldTick();
		assert.equal(s.counts().measures, 0);
		s.tick();
		assert.equal(s.counts().refreshes, 0);
		stopPressureSampling();
		assert.equal(s.listeners.size, 0);
		assert.equal(s.counts().detached, 2);
		s.subscriptions[1]('critical');
		s.timerCallbacks[1]();
		assert.equal(s.counts().measures, 1);
	} finally { s.close(); }
});

test('same injected notification and source sequence replays identically regardless of host events', () => {
	function replay(hostEvents) {
		const s = setup();
		const out = [];
		try {
			s.start();
			for (const level of [null, 'warning', 'critical', null]) {
				if (level) s.notify(level);
				if (hostEvents) process.emit('memoryPressure', 'critical');
				wsCounters.publishCountWindow = 4;
				s.tick();
				out.push({ ratio: wsCounters.lastMeasuredHeapUsedRatio, reason: pressureSnapshot.reason, value: pressureSnapshot.value, rate: pressureSnapshot.publishRate });
			}
			return out;
		} finally { s.close(); }
	}
	assert.deepEqual(replay(false), replay(true));
});

test('a partial virtual environment without a notification source never installs a host listener', () => {
	const initial = process.listenerCount('memoryPressure');
	setRuntimeEnv({ timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } }, { force: true });
	try {
		startPressureSampling(QUIET);
		assert.equal(process.listenerCount('memoryPressure'), initial);
	} finally { stopPressureSampling(); resetRuntimeEnv(); }
});

test('native listener lifecycle is supported even on runtimes that never emit the event', () => {
	resetRuntimeEnv();
	const initial = process.listenerCount('memoryPressure');
	try {
		startPressureSampling({ ...QUIET, sampleIntervalMs: 60_000 });
		assert.equal(process.listenerCount('memoryPressure'), initial + 1);
		process.emit('memoryPressure', 'warning');
		process.emit('memoryPressure', 'critical');
		startPressureSampling({ ...QUIET, sampleIntervalMs: 60_000 });
		assert.equal(process.listenerCount('memoryPressure'), initial + 1);
	} finally { stopPressureSampling(); resetRuntimeEnv(); }
	assert.equal(process.listenerCount('memoryPressure'), initial);
});


test('public runtime overrides ignore pressure injection', () => {
 let called = false;
 setRuntimeEnv({ pressure: { subscribe() { called = true; }, memoryUsage() { throw new Error('unexpected'); } }, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } }, { force: true });
 try {
  startPressureSampling(QUIET);
  assert.equal(called, false);
 } finally { stopPressureSampling(); resetRuntimeEnv(); }
});

test('a private subscription without cleanup does not break sampler shutdown', () => {
 const s = setup({ subscribe() { return 42; } });
 try { s.start(); assert.doesNotThrow(() => stopPressureSampling()); }
 finally { s.close(); }
});
