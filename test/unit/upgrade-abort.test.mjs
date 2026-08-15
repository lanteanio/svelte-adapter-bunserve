import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// THE ABORT PATH, driven through `tryUpgrade` rather than through the counters.
//
// A client that opens a handshake and hangs up while the app's `upgrade` hook is
// still awaiting used to hold one in-flight slot and one connection permit until
// that hook settled. Bounded by hook duration rather than permanent, which is
// what makes it easy to miss: a storm of connect-then-drop clients pins
// `maxConcurrent` for a full hook latency, and that storm is the exact thing the
// ceiling exists to shed. uws returns both counters from `res.onAborted`; the
// equivalent here is the request's abort signal, which this runtime fires within
// tens of milliseconds of the socket going away rather than at the end of the
// hook (`probe/bun-api-facts.report.md`, upgrade-abort).
//
// Every assertion below is about the state of the gate WHILE the hooks are still
// parked. Anything measured after they settle would pass with no fix at all.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
// Both ceilings at two, and no pacing: this file is about what a hang-up gives
// back, so nothing here should depend on the per-tick budget's timing.
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	upgradeAdmission: { maxConcurrent: 2, maxConnections: 2 }
};

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

/** A server that accepts every upgrade and remembers how many it took. */
function fakeServer() {
	const srv = {
		taken: 0,
		upgrade() { srv.taken++; return true; }
	};
	return srv;
}

/** Resolvers for every hook call currently parked. */
const parked = [];

/** Let every parked hook return, admitting whatever is behind it. */
function releaseHooks() {
	for (const resolve of parked.splice(0)) resolve({});
}

__setHooks({ upgrade: () => new Promise((resolve) => parked.push(resolve)) });

/**
 * One handshake, with a client that can hang up on it.
 *
 * @param {AbortSignal} signal
 */
function upgradeRequest(signal) {
	return new Request('http://127.0.0.1/ws', {
		headers: { upgrade: 'websocket', connection: 'Upgrade' },
		signal
	});
}

/** Drain microtasks and one macrotask turn, so an abort has provably landed. */
async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

test('the controller is live for this fixture, so the checks below can fail', () => {
	assert.notEqual(upgradeAdmission, null, 'admission is configured');
	assert.equal(upgradeAdmission.maxConcurrent, 2);
	assert.equal(upgradeAdmission.maxConnections, 2);
});

test('a client that hangs up mid-hook gives both counters back before the hook settles', async () => {
	const srv = fakeServer();
	const first = new AbortController();
	const second = new AbortController();

	const a = tryUpgrade(upgradeRequest(first.signal), srv, '/ws');
	const b = tryUpgrade(upgradeRequest(second.signal), srv, '/ws');
	await settle();
	assert.equal(parked.length, 2, 'both handshakes are inside the app hook');
	assert.equal(upgradeAdmission.inFlight, 2, 'holding both in-flight slots');
	assert.equal(upgradeAdmission.connectionPermits, 2, 'and both connection permits');

	// The ceiling binds while they are parked - which is what makes the next
	// part meaningful rather than a test of an ungated server.
	const refused = await tryUpgrade(upgradeRequest(new AbortController().signal), srv, '/ws');
	assert.ok(refused && refused.status === 503, `a full gate sheds, got ${refused && refused.status}`);
	assert.equal(parked.length, 2, 'and sheds before the hook, not after it');

	// Both clients hang up. Nothing has released either hook.
	first.abort();
	second.abort();
	await settle();
	assert.equal(parked.length, 2, 'the hooks are still awaiting, as an app hook may be');
	assert.equal(upgradeAdmission.inFlight, 0, 'the in-flight slots came back on the hang-up');
	assert.equal(upgradeAdmission.connectionPermits, 0, 'and so did the connection permits');

	// The gate is usable again, still before either hook settles. Reaching the
	// hook is the proof: a shed handshake is refused before it.
	const third = new AbortController();
	const c = tryUpgrade(upgradeRequest(third.signal), srv, '/ws');
	await settle();
	assert.equal(parked.length, 3, 'a new handshake is admitted rather than shed');

	releaseHooks();
	assert.equal(await c, undefined, 'the live handshake upgraded');
	const abandonedA = await a;
	const abandonedB = await b;
	assert.ok(abandonedA && abandonedA.status === 503, 'an abandoned handshake is answered, not upgraded');
	assert.ok(abandonedB && abandonedB.status === 503);
	assert.equal(srv.taken, 1, 'and the runtime was never asked to take a socket for a client that left');

	// No slot is released twice: `release()` and `releaseConnection()` are bare
	// decrements, so a double release reads as a permanently open gate here and
	// throws in the close callback there.
	assert.equal(upgradeAdmission.inFlight, 0, 'no in-flight slot was returned twice');
	assert.equal(upgradeAdmission.connectionPermits, 1, 'the live socket holds the only permit');
});

test('a handshake that is never abandoned still upgrades, and returns only its in-flight slot', async () => {
	// The other half of the same wiring: attaching an abort listener must not
	// change what an ordinary handshake does. The permit stays out because the
	// socket owns it from here until its close callback.
	const srv = fakeServer();
	const before = upgradeAdmission.connectionPermits;
	const settled = tryUpgrade(upgradeRequest(new AbortController().signal), srv, '/ws');
	await settle();
	releaseHooks();
	assert.equal(await settled, undefined, 'the handshake upgraded');
	assert.equal(srv.taken, 1);
	assert.equal(upgradeAdmission.inFlight, 0, 'the upgrade window is over, so the slot went back');
	assert.equal(upgradeAdmission.connectionPermits, before + 1, 'the permit went to the socket');
});
