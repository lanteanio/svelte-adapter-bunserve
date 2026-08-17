import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// THE METERED DOOR, DRIVEN THROUGH THE REAL UPGRADE PATH.
//
// Every other test of the limiter either calls the key folder directly or hands
// the limiter an address a test invented. This one goes the whole way: a client
// connects, `server.requestIP` answers, the upgrade path resolves an address
// from it, folds a key, and meters. That is the only place the three can be
// caught disagreeing - a fold that returns a different key per connection meters
// nothing, and a limiter that refuses nothing looks exactly like traffic under
// the limit from every counter the suite reads.
//
// The simulator could not reach a refusal at all before: it hands every client a
// fresh address, which is the right default for a workload about connections and
// makes the address door unreachable. A connection may now say which client it
// comes from.

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

register('../helpers/ws-handler-loader.mjs', import.meta.url);

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

test('a client whose port changes per connection is still one client', async () => {
	// The shape a proxy writes when it reports the peer SOCKET rather than the
	// peer host, which several do. A key that kept the port would put every
	// connection in a fresh bucket, and this door would refuse nothing while
	// every counter read exactly like traffic under the limit.
	const app = newApp();
	const clients = await connectAll(app, 4, (i) => `198.18.7.7:${40000 + i}`);
	assert.equal(clients[0].state, 'open');
	assert.equal(clients[1].state, 'open');
	assert.equal(clients[2].state, 'rejected', 'the port is not part of who this client is');
	assert.equal(clients[2].rejection.status, '429');
});

test('the same holds for the bracketed IPv6 spelling of one client', async () => {
	const app = newApp();
	const clients = await connectAll(app, 4, (i) => `[::ffff:198.18.7.7]:${40000 + i}`);
	assert.equal(clients[0].state, 'open');
	assert.equal(clients[1].state, 'open');
	assert.equal(clients[2].state, 'rejected');
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
