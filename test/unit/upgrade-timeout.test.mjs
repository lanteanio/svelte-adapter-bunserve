import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// `websocket.upgradeTimeout`: how long the app's `upgrade` hook may take before
// the handshake is refused.
//
// The bound exists because a hook is the part of a handshake that can hang - it
// awaits a database, an identity provider, a lock - and while it hangs the
// handshake is holding an in-flight slot and a connection permit that no other
// client can have. One unreachable dependency would otherwise turn the whole
// upgrade ceiling into a queue of handshakes that never finish, which is why
// this file runs against a GATED server: what a timeout must give back is the
// interesting half, and it does not exist without a ceiling.
//
// The virtual clock is what makes this testable at all. It does not wait a
// timeout out, it jumps to it - so a bound of seconds is reached in the same
// instant, and the ordering afterwards is exact rather than raced.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true,
	upgradeTimeout: 5,
	upgradeAdmission: { maxConcurrent: 2, maxConnections: 2 }
}).options;

const {
	createScheduler, createSeededRng, createFaultEngine, DEFAULT_SEED, FIXED_EPOCH
} = await import('../../src/sim.js');
const { createInMemoryApp } = await import('../../src/runtime/sim-inmemory.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { setServer, wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const { setRuntimeEnv } = await import('../../src/runtime/runtime.js');
const { __setSimHooks } = await import('../../src/runtime/sim-hooks.js');
const { upgrade_timeout_ms } = await import('../../src/runtime/handler/config.js');

/**
 * One app on the seeded clock, with its scheduler handed back so a test can
 * advance time.
 *
 * The ceiling is reset with it, exactly as `runSim` resets it per run. It is a
 * module singleton built once from the options, so without this a test would
 * start against whatever the previous test left holding - and a connection left
 * OPEN at the end of a test is legitimately still holding its permit, so the
 * pollution is ordinary rather than a bug to be found by reading.
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
	return { app, scheduler };
}

/** Drain microtasks without letting the clock move, so a pending hook stays pending. */
async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('the option is read in seconds and held in milliseconds', () => {
	// Seconds because that is the unit uws declares, milliseconds because that
	// is what a timer takes. Getting this wrong by a factor of 1000 is a bound
	// that either never fires or fires on every handshake.
	assert.equal(upgrade_timeout_ms, 5000);
});

test('a hook that never answers is refused with 504, and gives back what it held', async () => {
	// Never resolved: the dependency the hook is waiting on is simply gone.
	__setSimHooks({ upgrade: () => new Promise(() => {}) });
	try {
		const { app, scheduler } = newApp();
		wsCounters.upgradeRejectedByReason.auth_timeout = 0;

		const client = app.connect();
		await settle();
		assert.equal(client.state, 'connecting', 'still inside the hook');
		assert.equal(upgradeAdmission.inFlight, 1, 'holding a slot while it waits');
		assert.equal(upgradeAdmission.connectionPermits, 1, 'and a permit');

		await scheduler.run({ maxSteps: 100 });

		assert.equal(client.state, 'rejected');
		assert.equal(client.rejection.status, '504');
		// The half that matters: a bound that refused the client but kept its
		// counters would convert one hung dependency into a permanently narrowed
		// ceiling, which is the failure it exists to prevent.
		assert.equal(upgradeAdmission.inFlight, 0, 'the in-flight slot came back');
		assert.equal(upgradeAdmission.connectionPermits, 0, 'and so did the permit');
		assert.equal(app._connections.size, 0, 'no socket was ever created');
		assert.equal(wsCounters.upgradeRejectedByReason.auth_timeout, 1, 'counted as auth_timeout');
	} finally {
		__setSimHooks({});
	}
});

test('the refusal waits for the bound rather than arriving early', async () => {
	__setSimHooks({ upgrade: () => new Promise(() => {}) });
	try {
		const { app, scheduler } = newApp();
		const startedAt = scheduler.now();
		const client = app.connect();
		await settle();
		await scheduler.run({ maxSteps: 100 });
		assert.equal(client.state, 'rejected');
		assert.equal(scheduler.now() - startedAt, 5000, 'exactly the configured five seconds');
	} finally {
		__setSimHooks({});
	}
});

test('a hook that answers in time is untouched, and leaves no timer behind', async () => {
	let release;
	const parked = new Promise((resolve) => { release = resolve; });
	__setSimHooks({ upgrade: () => parked });
	try {
		const { app, scheduler } = newApp();
		const client = app.connect();
		await settle();

		release({ who: 'in time' });
		await settle();
		assert.equal(client.state, 'open', 'upgraded normally');

		// An armed timer that is never cleared is a retained callback per
		// handshake. What makes it VISIBLE is the virtual clock: draining to
		// quiescence advances time to the next thing waiting to fire, so a stale
		// five-second timeout would drag the run out to exactly five seconds.
		// (`pending()` is the wrong question - an open connection has a welcome
		// frame in flight, which is scheduled work too.)
		const startedAt = scheduler.now();
		await scheduler.run({ maxSteps: 100 });
		assert.ok(
			scheduler.now() - startedAt < 5000,
			`the run drained without waiting out a stale timeout (advanced ${scheduler.now() - startedAt}ms)`
		);
		assert.equal(client.state, 'open', 'the connection is still open afterwards');
	} finally {
		__setSimHooks({});
	}
});

test('a hook that answers WITHOUT a promise arms no timer at all', async () => {
	// The common path. A synchronous hook cannot exceed a bound, so it must not
	// pay for one - and on the virtual clock a timer armed and then cleared is
	// indistinguishable from one never armed, so what this pins is that draining
	// never waits on the bound.
	__setSimHooks({ upgrade: () => ({ who: 'synchronous' }) });
	try {
		const { app, scheduler } = newApp();
		const client = app.connect();
		await settle();
		assert.equal(client.state, 'open');
		const startedAt = scheduler.now();
		await scheduler.run({ maxSteps: 100 });
		assert.ok(scheduler.now() - startedAt < 5000, 'the run never waited on the bound');
	} finally {
		__setSimHooks({});
	}
});

test('a hook that answers LATE answers nothing, and its rejection escapes nowhere', async () => {
	// The handshake has already been answered by the time this resolves. The
	// value must be dropped rather than upgrading a client that was told 504,
	// and a late REJECTION must not surface as an unhandled one - it belongs to
	// a request that is over.
	let settleHook;
	const late = new Promise((resolve, reject) => { settleHook = { resolve, reject }; });
	__setSimHooks({ upgrade: () => late });
	const unhandled = [];
	const onUnhandled = (err) => unhandled.push(err);
	process.on('unhandledRejection', onUnhandled);
	try {
		const { app, scheduler } = newApp();
		const client = app.connect();
		await settle();
		await scheduler.run({ maxSteps: 100 });
		assert.equal(client.state, 'rejected', 'answered by the timeout');

		settleHook.reject(new Error('the dependency finally failed'));
		await settle();
		await scheduler.run({ maxSteps: 100 });

		assert.equal(client.state, 'rejected', 'still refused, not upgraded after the fact');
		assert.equal(app._connections.size, 0, 'and no socket appeared late');
		assert.deepEqual(unhandled, [], 'the late rejection did not escape');
		assert.equal(upgradeAdmission.inFlight, 0, 'counters stayed returned');
		assert.equal(upgradeAdmission.connectionPermits, 0);
	} finally {
		process.off('unhandledRejection', onUnhandled);
		__setSimHooks({});
	}
});

test('a timed-out handshake does not consume the ceiling for the next client', async () => {
	// The whole point, stated as the symptom an operator would see: after a hook
	// hangs, the server must still admit people. With the counters leaked, the
	// second client here is refused by a ceiling that nothing is occupying.
	let hang = true;
	__setSimHooks({ upgrade: () => (hang ? new Promise(() => {}) : { ok: true }) });
	try {
		const { app, scheduler } = newApp();
		for (let i = 0; i < 2; i++) {
			app.connect();
			await settle();
			await scheduler.run({ maxSteps: 100 });
		}
		assert.equal(upgradeAdmission.connectionPermits, 0, 'both timed-out handshakes let go');

		hang = false;
		const admitted = app.connect();
		await settle();
		assert.equal(admitted.state, 'open', 'the next client is admitted');
	} finally {
		__setSimHooks({});
	}
});
