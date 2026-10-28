import '../helpers/configured-metrics.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({ handler: 'src/ws-handler.js' }).options;
const { createMemoryWallReader, processMemoryWall } = await import('../../src/runtime/utils/memory-wall.js');
const { startPressureSampling, stopPressureSampling, grantSizeFor } = await import('../../src/runtime/handler/pressure-metrics.js');
const { wsCounters, pressureSnapshot } = await import('../../src/runtime/handler/ws-state.js');
const { metricsRegistry, metricsSnapshot } = await import('../../src/runtime/handler/metrics.js');
const { setRuntimeEnv, resetRuntimeEnv } = await import('../../src/runtime/runtime.js');
const QUIET = {
	memoryHeapUsedRatio: 0.85, publishRatePerSec: false, subscriberRatio: false,
	topicPublishRatePerSec: false, topicPublishBytesPerSec: false,
	psiCpuSome: false, psiMemoryFull: false, psiIoFull: false, cpuThrottledRatio: false
};
const value = text => text.split('\n').find(line => line.startsWith('heap_used_ratio '));

test('the real sampler, projection and send gate retain availability through finite/unlimited/finite walls', async () => {
	let limit = '100';
	const reader = createMemoryWallReader({
		heapStatistics: () => ({ heap_size_limit: 0 }),
		readFile(path) {
			if (path === '/proc/self/cgroup') return '0::/';
			if (path === '/sys/fs/cgroup/memory.max') return limit;
			throw Object.assign(new Error('absent'), { code: 'ENOENT' });
		}
	});
	const original = processMemoryWall.measure;
	let tick;
	processMemoryWall.measure = () => reader.measure({ heapUsed: 10, rss: 30 });
	setRuntimeEnv({ timers: { setInterval(fn) { tick = fn; return { unref() {} }; }, clearInterval() {} } }, { force: true });
	try {
		startPressureSampling(QUIET);
		tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 0.3);
		assert.equal(wsCounters.lastHeapUsedRatio, 0.3);
		assert.equal(value(await metricsSnapshot()), 'heap_used_ratio 0.3');
		limit = 'max';
		tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, null);
		assert.equal(wsCounters.lastHeapUsedRatio, 0);
		assert.equal(pressureSnapshot.reason, 'NONE');
		assert.equal(pressureSnapshot.value, 0);
		assert.equal(grantSizeFor().count, 256);
		assert.equal(value(await metricsSnapshot()), undefined);
		metricsRegistry.gauge('heap_used_ratio').set(0.9);
		assert.equal(value(await metricsSnapshot()), undefined, 'an old app handle cannot revive an unavailable source');
		limit = '30';
		tick();
		assert.equal(wsCounters.lastMeasuredHeapUsedRatio, 1);
		assert.equal(pressureSnapshot.reason, 'MEMORY');
		assert.equal(pressureSnapshot.value, 1);
		assert.equal(value(await metricsSnapshot()), 'heap_used_ratio 1');
		assert.ok(grantSizeFor().count < 256);
	} finally {
		stopPressureSampling();
		processMemoryWall.measure = original;
		resetRuntimeEnv();
	}
});
