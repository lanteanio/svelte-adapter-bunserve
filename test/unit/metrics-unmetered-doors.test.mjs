import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// A server where both metered doors are turned off.
//
// The limiters are built once from module-level config, so "no limiter" cannot
// be reached from the file that covers the configured case - which is the whole
// reason this one exists. What it pins is the same rule the admission gauges
// follow: a signal this build does not measure is ABSENT, never a zero. A zero
// on `upgrade_rate_map_evicted_total` reads as "nothing was evicted"; the truth
// on a door with no map is "nothing is being counted", and an operator cannot
// tell a healthy limiter from a disabled one by looking at it.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true,
	upgradeRateLimit: 0,
	authPathRateLimit: 0
}).options;

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { metricsSnapshot } = await import('../../src/runtime/handler/metrics.js');
const { upgradeRateLimiter, authRateLimiter } = await import('../../src/runtime/handler/rate-limit.js');

test('neither door is metered in this build', () => {
	// The premise, asserted rather than assumed: without it the absence below
	// would pass on a build that meters both and simply renamed the family.
	assert.equal(upgradeRateLimiter, null);
	assert.equal(authRateLimiter, null);
});

test('an unmetered door publishes no eviction series', async () => {
	const text = await metricsSnapshot();
	assert.doesNotMatch(text, /upgrade_rate_map_evicted_total/);
});
