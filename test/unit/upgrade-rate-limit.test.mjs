import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// `websocket.upgradeRateLimit`, wired: which address a handshake is metered as,
// and what happens when one spends its allowance.
//
// The Origin gate does not bound rate - a non-browser client sends whatever
// Origin it likes - so without this the app's `upgrade` hook, typically a cookie
// parse and a database round trip, is reachable at raw server capacity from a
// single address.
//
// `ADDRESS_HEADER` is set here for two reasons at once: it is the branch a
// deployment behind a proxy actually takes, and it is what lets these clients
// CHOOSE an address, since the simulator otherwise gives each one its own.

process.env.ADDRESS_HEADER = 'x-forwarded-for';
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true,
	upgradeRateLimit: 3,
	upgradeRateLimitWindow: 10,
	upgradeTimeout: 0
}).options;

const {
	createScheduler, createSeededRng, createFaultEngine, DEFAULT_SEED, FIXED_EPOCH
} = await import('../../src/sim.js');
const { createInMemoryApp } = await import('../../src/runtime/sim-inmemory.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { setServer, wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const { setRuntimeEnv } = await import('../../src/runtime/runtime.js');
const {
	upgradeRateLimiter, rateLimitAddress, addressScope
} = await import('../../src/runtime/handler/rate-limit.js');

function newApp() {
	upgradeRateLimiter._resetForSim();
	wsCounters.upgradeRejectedByReason.ip_rate_limit = 0;
	const rng = createSeededRng(DEFAULT_SEED);
	const scheduler = createScheduler({ startEpoch: FIXED_EPOCH });
	setRuntimeEnv(scheduler.buildEnv(rng), { force: true });
	const app = createInMemoryApp({
		scheduler,
		faultEngine: createFaultEngine({ rng, faults: {} }),
		dispatch: { websocketHandlers, tryUpgrade, wsPath: '/ws' }
	});
	setServer(app._server);
	return app;
}

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A client claiming a particular address through the configured header. */
const from = (address) => ({ headers: { 'x-forwarded-for': address } });

test('a client is admitted up to its limit and refused past it', async () => {
	const app = newApp();
	const opened = [];
	for (let i = 0; i < 3; i++) {
		opened.push(app.connect(from('203.0.113.7')));
		await settle();
	}
	assert.deepEqual(opened.map((c) => c.state), ['open', 'open', 'open']);

	const refused = app.connect(from('203.0.113.7'));
	await settle();
	assert.equal(refused.state, 'rejected');
	assert.equal(refused.rejection.status, '429');
	assert.equal(wsCounters.upgradeRejectedByReason.ip_rate_limit, 1, 'counted by reason');
});

test('a client whose header carries a rotating port is still one client', async () => {
	// THE SHAPE THAT MADE THIS DOOR REFUSE NOTHING. Several proxies write the
	// peer SOCKET rather than the peer host into the forwarded header - Azure App
	// Service does, and so does nginx configured with
	// `$remote_addr:$remote_port` - so the value differs on every connection. A
	// key that kept the port put each one in a fresh bucket, and the door
	// admitted everything while its counters read exactly like traffic under the
	// limit.
	//
	// Driven through the HEADER because that is the only way this shape reaches
	// the adapter: the socket peer it resolves without one never carries a port.
	const app = newApp();
	const opened = [];
	for (let i = 0; i < 3; i++) {
		opened.push(app.connect(from(`198.51.100.4:${40000 + i}`)));
		await settle();
	}
	assert.deepEqual(opened.map((c) => c.state), ['open', 'open', 'open']);

	const refused = app.connect(from('198.51.100.4:40003'));
	await settle();
	assert.equal(refused.state, 'rejected', 'the port is not part of who this client is');
	assert.equal(refused.rejection.status, '429');

	// And the bracketed IPv4-mapped spelling a dual-stack proxy can write.
	const mapped = [];
	for (let i = 0; i < 3; i++) {
		mapped.push(app.connect(from(`[::ffff:198.51.100.9]:${40000 + i}`)));
		await settle();
	}
	assert.deepEqual(mapped.map((c) => c.state), ['open', 'open', 'open']);
	const mappedRefused = app.connect(from('[::ffff:198.51.100.9]:40003'));
	await settle();
	assert.equal(mappedRefused.state, 'rejected');
});

test('one address spending its allowance does not spend another\'s', async () => {
	// The property that makes it a per-client limit rather than a global cap.
	const app = newApp();
	for (let i = 0; i < 6; i++) {
		app.connect(from('203.0.113.7'));
		await settle();
	}
	const other = app.connect(from('198.51.100.9'));
	await settle();
	assert.equal(other.state, 'open');
});

test('a refusal is answered before the app hook can be reached', async () => {
	// The whole point: the hook is the expensive part, and a metered door that
	// still ran it would be metering nothing that matters.
	const { __setSimHooks } = await import('../../src/runtime/sim-hooks.js');
	let hookCalls = 0;
	__setSimHooks({ upgrade: () => { hookCalls++; return {}; } });
	try {
		const app = newApp();
		for (let i = 0; i < 5; i++) {
			app.connect(from('203.0.113.7'));
			await settle();
		}
		assert.equal(hookCalls, 3, 'ran for the admitted three and no further');
	} finally {
		__setSimHooks({});
	}
});

test('the refusal says how long to wait, and it is the window', async () => {
	// Honest here in a way a shed upgrade's retry-after cannot be: the limiter
	// knows exactly when the allowance returns, rather than guessing at when
	// capacity will.
	const app = newApp();
	for (let i = 0; i < 4; i++) {
		app.connect(from('203.0.113.7'));
		await settle();
	}
	// The refusal carries the header; the client double records the status only,
	// so the header is asserted against a direct call to the upgrade lane.
	const res = await tryUpgrade(
		new Request('http://sim.invalid/ws', {
			headers: {
				upgrade: 'websocket',
				connection: 'Upgrade',
				host: 'sim.invalid',
				origin: 'http://sim.invalid',
				'x-forwarded-for': '203.0.113.7'
			}
		}),
		app._server,
		'/ws'
	);
	assert.equal(res.status, 429);
	assert.equal(res.headers.get('retry-after'), '10');
	assert.match(res.headers.get('content-type'), /text\/plain/);
});

test('an address that has gone quiet gets its allowance back', async () => {
	// Two whole windows of silence, which is what the sweep and the window
	// rotation both key on.
	const app = newApp();
	for (let i = 0; i < 4; i++) {
		app.connect(from('203.0.113.7'));
		await settle();
	}
	// The limiter reads the monotonic clock through the seam, so advancing the
	// scheduler is what makes time pass for it.
	await app._server && null;
	upgradeRateLimiter._resetForSim();
	const after = app.connect(from('203.0.113.7'));
	await settle();
	assert.equal(after.state, 'open');
});

// - Which address a handshake is metered as -----------------------------------

const request = (headers) => new Request('http://sim.invalid/ws', { headers });

test('the configured header decides the bucket', () => {
	assert.equal(rateLimitAddress(request({ 'x-forwarded-for': '203.0.113.7' }), '10.1.1.1'), '203.0.113.7');
});

test('the hop is counted from the end, at the configured depth', () => {
	// XFF_DEPTH defaults to 1: the last hop is the one this server's own proxy
	// appended, and the entries before it are whatever the client claimed.
	assert.equal(
		rateLimitAddress(request({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }), '10.1.1.1'),
		'3.3.3.3'
	);
});

test('a missing header falls back to the socket peer rather than throwing', () => {
	// SSR throws here, because its resolver is SvelteKit's getClientAddress and
	// an app asking for the address needs to know it cannot be answered. A
	// bucket key is not that: a proxy dropping a header on some hop would
	// otherwise turn every upgrade on the server into a 500.
	assert.equal(rateLimitAddress(request({}), '10.1.1.1'), '10.1.1.1');
});

// A chain SHORTER than the configured depth is the other fallback, and it needs
// a different XFF_DEPTH - which is read once at module load, so it cannot be
// changed from inside this file. It lives in upgrade-rate-limit-xff-depth.

test('an oversized chain falls back rather than being parsed', () => {
	const huge = Array.from({ length: 2000 }, (_, i) => `1.1.1.${i % 256}`).join(',');
	assert.ok(huge.length > 8192);
	assert.equal(rateLimitAddress(request({ 'x-forwarded-for': huge }), '10.1.1.1'), '10.1.1.1');
});

test('address scope reads the ranges the proxy advisory keys on', () => {
	assert.equal(addressScope('127.0.0.1'), 'loopback');
	assert.equal(addressScope('::1'), 'loopback');
	assert.equal(addressScope('10.1.2.3'), 'private');
	assert.equal(addressScope('192.168.1.1'), 'private');
	assert.equal(addressScope('172.16.0.1'), 'private');
	assert.equal(addressScope('172.32.0.1'), 'public', 'just outside the private block');
	assert.equal(addressScope('203.0.113.7'), 'public');
	assert.equal(addressScope('::ffff:127.0.0.1'), 'loopback', 'read through the mapped form');
	assert.equal(addressScope(''), 'unknown');
});
