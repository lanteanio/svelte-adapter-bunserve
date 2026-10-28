import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = null;

const { httpPlatform, requestPlatform } = await import('../../src/runtime/handler/platform.js');
const { wsCounters } = await import('../../src/runtime/handler/ws-state.js');

test('an unconfigured registry stays null on HTTP and request platforms', async () => {
	for (const platform of [httpPlatform, requestPlatform('metrics-default')]) {
		assert.equal(platform.metrics, null);
		const snapshot = platform.metricsSnapshot();
		assert.ok(snapshot instanceof Promise);
		assert.equal(await snapshot, null);
	}
	assert.equal(wsCounters.metricsSampleHook, null);
	assert.equal(wsCounters.transportMetricHooks, null);
});
