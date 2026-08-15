import { test } from 'node:test';
import assert from 'node:assert/strict';

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
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true,
	upgradeAdmission: { maxConcurrent: 2, maxConnections: 2 }
};

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

/** One app on the seeded clock, assembled the way runSim assembles it. */
function newApp() {
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
