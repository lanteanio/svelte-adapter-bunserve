import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// `websocket.authPathRateLimit`, wired: the second door on the shared limiter.
//
// Without it the app's `authenticate` hook - a credential check, typically a
// database round trip against a session table - is reachable at raw server
// capacity from one address, which is exactly the traffic shape a credential
// stuffer produces.
//
// Its own file because the limiters are built once from the options at module
// load, so a limit low enough for a test to reach cannot be set from inside a
// file that also needs the default.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowedOrigins: 'same-origin',
	authPathRateLimit: 3,
	authPathRateLimitWindow: 10,
	// A DIFFERENT number at the other door, so a test can tell the two budgets
	// apart rather than watching one that happens to agree.
	upgradeRateLimit: 1
}).options;


const { tryAuthEndpoint } = await import('../../src/runtime/handler/auth.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const {
	authRateLimiter, upgradeRateLimiter, upgradeRateLimitExceeded
} = await import('../../src/runtime/handler/rate-limit.js');

const AUTH_PATH = '/__ws/auth';
const SELF = 'https://app.example';

/** A preflight from a chosen address, as the family client sends it. */
function post(address = '203.0.113.7', headers = {}) {
	const req = new Request(SELF + AUTH_PATH, {
		method: 'POST',
		headers: { host: 'app.example', 'x-requested-with': 'XMLHttpRequest', ...headers }
	});
	return tryAuthEndpoint(req, { requestIP: () => ({ address }) }, AUTH_PATH);
}

function fresh() {
	authRateLimiter._resetForSim();
	upgradeRateLimiter._resetForSim();
	wsCounters.upgradeRejectedByReason.auth_rate_limit = 0;
	__setHooks({ authenticate: () => undefined });
}

test('a client is admitted up to its limit and refused past it', async () => {
	fresh();
	for (let i = 0; i < 3; i++) {
		assert.equal((await post()).status, 204, `preflight ${i + 1}`);
	}
	const refused = await post();
	assert.equal(refused.status, 429);
	assert.equal(wsCounters.upgradeRejectedByReason.auth_rate_limit, 1, 'counted by reason');
});

test('the refusal says how long to wait, and it is the window', async () => {
	fresh();
	for (let i = 0; i < 4; i++) await post();
	const refused = await post();
	assert.equal(refused.headers.get('retry-after'), '10');
	assert.match(refused.headers.get('content-type'), /text\/plain/);
	assert.match(await refused.text(), /Too many authentication requests/);
});

test('one address spending its allowance does not spend another\'s', async () => {
	fresh();
	for (let i = 0; i < 6; i++) await post('203.0.113.7');
	assert.equal((await post('198.51.100.9')).status, 204);
});

test('a refusal is answered before the app hook can be reached', async () => {
	// The whole point: the hook is the expensive part, and a metered door that
	// still ran it would be metering nothing that matters.
	fresh();
	let calls = 0;
	__setHooks({ authenticate: () => { calls++; } });
	for (let i = 0; i < 5; i++) await post();
	assert.equal(calls, 3, 'ran for the admitted three and no further');
});

test('a refused ORIGIN is charged, like everything else that reaches this door', async () => {
	// The sibling meters AFTER its origin check so a refused origin is not
	// charged. That ordering does not survive contact with this door: passing the
	// guard needs only `x-requested-with`, an unverified header any client can
	// set, so an attacker spends the budget anyway - and the only thing the
	// ordering bought was an UNMETERED path through a guard that reconstructs the
	// origin from headers whenever ORIGIN is unset. So this door meters first,
	// exactly like the upgrade door, and everything that reaches it is charged.
	fresh();
	for (let i = 0; i < 3; i++) {
		const req = new Request(SELF + AUTH_PATH, {
			method: 'POST',
			headers: { host: 'app.example', origin: 'https://evil.example' }
		});
		const res = await tryAuthEndpoint(req, { requestIP: () => ({ address: '203.0.113.7' }) }, AUTH_PATH);
		assert.equal(res.status, 403, `refusal ${i + 1}`);
	}
	assert.equal((await post('203.0.113.7')).status, 429, 'the refusals spent the budget');
});

test('the two doors have separate budgets', async () => {
	// A shared map would make every preflight spend an upgrade too, so a
	// reconnect wave would refuse handshakes the upgrade limit would have
	// admitted - which is why the sibling meters them apart and defaults this
	// door higher.
	fresh();
	for (let i = 0; i < 3; i++) await post('203.0.113.7');
	assert.equal(upgradeRateLimitExceeded('203.0.113.7'), false, 'the first upgrade is still free');
	assert.equal(upgradeRateLimitExceeded('203.0.113.7'), true, 'and the limit of one still holds');
});
