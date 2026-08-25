import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// ONE DOOR METERED, ONE NOT - the configuration between the two neighbouring
// files, and the only one where the eviction family's per-door rule can be seen
// discriminating rather than answering all-or-nothing. `upgradeRateLimit: 0` is
// documented as the way to disable a door when something upstream throttles, so
// a deployment that does it for one door and not the other is ordinary.
//
// What must not happen: a second flat zero series. A "by door" panel showing one
// would say the auth door is metering and finding nothing, where the truth is
// that it keeps no map at all.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true,
	upgradeRateLimit: 10,
	authPathRateLimit: 0
}).options;


const { metricsSnapshot } = await import('../../src/runtime/handler/metrics.js');
const { upgradeRateLimiter, authRateLimiter } = await import('../../src/runtime/handler/rate-limit.js');

/** Every line of one family. */
function family(text, name) {
	return text.split('\n').filter((l) => l.startsWith(name + '{') || l.startsWith(name + ' '));
}

test('exactly one door meters in this build', () => {
	// The premise, asserted rather than assumed: without it the single series
	// below would pass on a build that meters neither and renamed the family.
	assert.notEqual(upgradeRateLimiter, null, 'the upgrade door keeps a map');
	assert.equal(authRateLimiter, null, 'the auth door does not');
});

test('and exactly one eviction series is published', async () => {
	const text = await metricsSnapshot();
	const lines = family(text, 'upgrade_rate_map_evicted_total');
	assert.equal(lines.length, 1, `one series, got ${JSON.stringify(lines)}`);
	assert.match(lines[0], /\{door="upgrade"\} 0$/);
	assert.doesNotMatch(text, /door="auth"/);
});
