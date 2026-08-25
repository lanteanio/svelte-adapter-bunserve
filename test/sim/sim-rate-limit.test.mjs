import { test } from 'node:test';
import assert from 'node:assert/strict';

// THE METERED DOOR ON ITS SOCKET-PEER BRANCH.
//
// `upgrade-rate-limit.test.mjs` already drives this door end to end, and does it
// the way a deployment behind a proxy does: ADDRESS_HEADER configured, each
// client naming itself in the header. That leaves one branch of
// `resolveRateLimitAddress` with no workload behind it - the DEFAULT one, where
// no header is configured and the key is whatever `server.requestIP` answered.
// It is the branch every zero-config deployment takes.
//
// What that buys beyond the key folder's own tests is the join: `requestIP`, the
// resolver, the fold and the limiter agreeing about who one client is. A fold
// that returns a different key per connection meters nothing, and a door that
// refuses nothing looks exactly like traffic under the limit from every counter
// the suite reads.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true,
	upgradeRateLimit: 2,
	upgradeRateLimitWindow: 10
};


const {
	createScheduler, createSeededRng, createFaultEngine, DEFAULT_SEED, FIXED_EPOCH
} = await import('../../src/sim.js');
const { createInMemoryApp } = await import('../../src/runtime/sim-inmemory.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { setServer } = await import('../../src/runtime/handler/ws-state.js');
const { setRuntimeEnv } = await import('../../src/runtime/runtime.js');
const { upgradeRateLimiter } = await import('../../src/runtime/handler/rate-limit.js');

/** One app on the seeded clock, with the limiter's windows cleared. */
function newApp() {
	upgradeRateLimiter._resetForSim();
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

/** Open `n` clients whose addresses come from `addressFor`, and report each state. */
async function connectAll(app, n, addressFor) {
	const clients = [];
	for (let i = 0; i < n; i++) clients.push(app.connect({ address: addressFor(i) }));
	await settle();
	return clients;
}

test('the limiter is live for this fixture, so a refusal is reachable', () => {
	assert.notEqual(upgradeRateLimiter, null, 'a limiter exists');
});

test('one client past its allowance is refused, through the whole path', async () => {
	const app = newApp();
	const clients = await connectAll(app, 4, () => '198.18.7.7');
	assert.equal(clients[0].state, 'open', 'the first is admitted');
	assert.equal(clients[1].state, 'open', 'and the second');
	assert.equal(clients[2].state, 'rejected', 'the third is over the limit');
	assert.equal(clients[2].rejection.status, '429', 'and told so');
	assert.equal(clients[3].state, 'rejected', 'and so is everything after it');
});

test('separate clients keep separate allowances', async () => {
	// The other half, and the one a limiter that refuses everything would fail:
	// four clients, one connection each, none of them metered against another.
	const app = newApp();
	const clients = await connectAll(app, 4, (i) => `198.18.9.${i}`);
	assert.deepEqual(
		clients.map((c) => c.state),
		['open', 'open', 'open', 'open']
	);
});
