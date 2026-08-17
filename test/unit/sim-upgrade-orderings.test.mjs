import { test } from 'node:test';
import assert from 'node:assert/strict';
// Dependency-free and reads no global, so it is safe to import before the
// server options below are installed.
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// THE SIMULATOR, DRIVEN THROUGH THE TWO ORDERINGS IT COULD NOT SEE.
//
// This is the tool the repo built to explore interleavings, and it was blind to
// both halves of the ordering that produced the worst defect in this subsystem:
//
// - it un-closed a socket that closed inside `open`, reporting the refused
//   client as connected while it carried the close code it was refused with, so
//   any scenario reasoning about client state was reasoning about a connection
//   that did not exist;
// - its handshake request carried no abort signal, so a client could never
//   leave mid-handshake, and every hang-up branch in the upgrade path was
//   unreachable from a scenario.
//
// WS_OPTIONS is set before importing the sim, which is how a scenario chooses
// the server it runs against - here, one with a ceiling, because the accounting
// under test does not exist without one.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
// NORMALIZED, because a raw object is not a server. The keys below are the ones
// these tests are about; a built server also carries the subscription cap, the
// control-egress budget and the gate concurrency, and a handler reading those
// and finding `undefined` is not the handler a deployment runs.
globalThis.WS_OPTIONS = normalizeWsOptions({
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true,
	// A parked hook is the whole point of the hang-up test below, and a virtual
	// clock jumps to a timeout rather than waiting it out - so a bound armed here
	// would answer the handshake before the client could leave inside it.
	upgradeTimeout: 0,
	upgradeAdmission: { maxConcurrent: 2, maxConnections: 2 }
}).options;

// Imported for its side effects as much as its exports: it registers the sim
// loader and installs the seeded environment seam that the handler graph reads.
const {
	createScheduler, createSeededRng, createFaultEngine, DEFAULT_SEED, FIXED_EPOCH
} = await import('../../src/sim.js');
const { createInMemoryApp } = await import('../../src/runtime/sim-inmemory.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { setServer } = await import('../../src/runtime/handler/ws-state.js');
const { setRuntimeEnv } = await import('../../src/runtime/runtime.js');
const { __setSimHooks } = await import('../../src/runtime/sim-hooks.js');

/**
 * One app on the seeded clock, assembled the way runSim assembles it.
 *
 * The admission controller is reset first, as it is in the file next door: it
 * is a module singleton built once from the options, so without this a test
 * starts against whatever the previous one left holding, and the absolute
 * counter assertions below would depend on the order the tests were declared
 * in. A connection left open at the end of a test is legitimately still holding
 * its permit, so the pollution is ordinary rather than a bug to be found by
 * reading.
 */
function newApp() {
	upgradeAdmission._resetForSim();
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

/** Drain microtasks, which is all an in-memory upgrade needs to settle. */
async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('the sim runs against a gated server, so these orderings are reachable at all', () => {
	assert.notEqual(upgradeAdmission, null, 'a scenario can configure a ceiling');
	assert.equal(upgradeAdmission.maxConnections, 2);
});

test('a socket closed inside the open hook is reported closed, not open', async () => {
	__setSimHooks({
		open: (ws) => { ws.end(4001, 'refused by the app'); }
	});
	try {
		const sim = newApp();
		const client = sim.connect();
		await settle();

		// The whole point: `open` runs INSIDE the upgrade call, so by the time
		// the upgrade reports success this connection is already gone.
		assert.equal(client.state, 'closed', `the client is closed, not ${client.state}`);
		assert.deepEqual(
			client.closeInfo,
			{ code: 4001, reason: 'refused by the app' },
			'and carries what it was refused with'
		);
		assert.equal(sim._connections.size, 0, 'the registry holds nothing');
		// And the accounting behind it: a refused connection must not keep a
		// permit, or a scenario that opens a few would run out of ceiling.
		assert.equal(upgradeAdmission.connectionPermits, 0, 'its permit went back');
		assert.equal(upgradeAdmission.inFlight, 0);
	} finally {
		__setSimHooks({});
	}
});

test('closing the socket inside `open` ends its request, which is how the runtime behaves', async () => {
	// THE HALF THE SIMULATOR USED TO DROP. On Bun the socket going away ends the
	// request it was upgraded from, and it does so BEFORE the close callback:
	//
	//   before upgrade -> open enters -> abort -> close -> open exits
	//
	// (probe/bun-api-facts.report.md, upgrade-dispatch-order). Modelling the
	// close without the abort left the handshake's hang-up watch armed while its
	// own socket tore down - so the interleaving that releases the permit TWICE
	// could not occur here, and the corpus could not fail on it. It is the
	// double release that is fatal: `releaseConnection` throws, and that throw
	// leaves through the close callback.
	__setSimHooks({
		open: (ws) => { ws.end(4001, 'refused by the app'); }
	});
	try {
		const sim = newApp();
		const client = sim.connect();
		await settle();

		assert.equal(client.requestEnded, true, 'the request ended with the socket');
		assert.equal(client.state, 'closed');
		// And the accounting survived it: one release, not two. An over-release
		// throws rather than miscounting, so a passing assertion here is also the
		// statement that nothing threw.
		assert.equal(upgradeAdmission.connectionPermits, 0);
		assert.equal(upgradeAdmission.inFlight, 0);
	} finally {
		__setSimHooks({});
	}
});

test('a connection that stays open has not ended its request', async () => {
	// The other side of the rule, so the abort models a socket ENDING rather
	// than a socket existing. Without this, wiring that fired on every upgrade
	// would pass the test above and make every later hang-up branch unreachable
	// for the opposite reason.
	const sim = newApp();
	const client = sim.connect();
	await settle();

	assert.equal(client.state, 'open');
	assert.equal(client.requestEnded, false);
	assert.equal(upgradeAdmission.connectionPermits, 1, 'and it is holding its permit');

	client.close(1000, 'done');
	await settle();
	assert.equal(client.requestEnded, true, 'ending it later ends the request too');
	assert.equal(upgradeAdmission.connectionPermits, 0, 'and returns the permit exactly once');
});

test('a client that hangs up mid-hook gives the ceiling back inside the sim too', async () => {
	// The hook parks, so the handshake is still inside it when the client goes -
	// the window the whole hang-up path exists for, now reachable from a
	// scenario rather than only from a live server.
	let release;
	const parked = new Promise((resolve) => { release = resolve; });
	__setSimHooks({ upgrade: () => parked });
	try {
		const sim = newApp();
		const client = sim.connect();
		await settle();
		assert.equal(client.state, 'connecting', 'parked inside the app hook');
		assert.equal(upgradeAdmission.connectionPermits, 1, 'holding a permit while it waits');

		assert.equal(client.hangUp(), true, 'the client goes away');
		await settle();
		assert.equal(
			upgradeAdmission.connectionPermits,
			0,
			'the permit came back before the hook settled'
		);
		assert.equal(upgradeAdmission.inFlight, 0, 'and so did the in-flight slot');

		release({});
		await settle();
		assert.equal(client.state, 'rejected', 'the handshake is answered, not upgraded');
		assert.equal(sim._connections.size, 0, 'and no socket was ever created for it');
	} finally {
		__setSimHooks({});
	}
});
