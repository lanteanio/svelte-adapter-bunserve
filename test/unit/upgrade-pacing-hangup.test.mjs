import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// A CLIENT THAT LEAVES WHILE ITS HANDSHAKE IS PARKED IN THE PACING QUEUE.
//
// Its own file because the shape needs a budget of one AND a queue with room in
// it - a handshake that has passed every refusal, has been deferred, and is
// waiting for its turn. The controller is a module singleton, so that pairing
// cannot share a file with the overflow fixture next door, whose queue is zero
// deep precisely so nothing ever waits in it.
//
// What it reaches is the SECOND hang-up check in the upgrade path. The first one
// runs before the pacing wait and is reached by any client that leaves while the
// app's hook holds it; the second exists because the queue can park a handshake
// across many turns, and a client can leave in any of them. Without a workload
// that waits in the queue, that block can be deleted and every other test in
// this repo still passes.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	upgradeAdmission: { perTickBudget: 1, maxDeferred: 4 }
};

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { wsCounters } = await import('../../src/runtime/handler/ws-state.js');

/** A server that accepts every upgrade and remembers how many it took. */
function fakeServer() {
	const srv = {
		taken: 0,
		upgrade() { srv.taken++; return true; }
	};
	return srv;
}

function upgradeRequest(signal) {
	return new Request('http://127.0.0.1/ws', {
		headers: { upgrade: 'websocket', connection: 'Upgrade' },
		signal
	});
}

test('the fixture pairs a one-per-tick budget with a queue that has room', () => {
	assert.notEqual(upgradeAdmission, null, 'admission is configured');
	assert.equal(upgradeAdmission.maxDeferred, 4, 'somewhere for a paced handshake to wait');
	assert.equal(upgradeAdmission.maxConcurrent, 0, 'no ceiling, so nothing else can refuse');
	// The budget itself is not exposed; that it is one per tick is what the test
	// below demonstrates, by getting a second handshake deferred rather than run.
});

test('a client that leaves while queued is answered, and takes no socket', async () => {
	const srv = fakeServer();
	const refusedBefore = wsCounters.upgradeRejectedTotal;

	// Both start in one tick: with no app hook the handler runs synchronously as
	// far as the pacing wait, so the first spends this tick's budget and the
	// second is DEFERRED rather than shed.
	const gone = new AbortController();
	const first = tryUpgrade(upgradeRequest(new AbortController().signal), srv, '/ws');
	const queued = tryUpgrade(upgradeRequest(gone.signal), srv, '/ws');
	for (let i = 0; i < 10; i++) await Promise.resolve();

	assert.equal(await first, undefined, 'the first handshake took the tick');
	assert.equal(upgradeAdmission.deferredDepth, 1, 'and the second is waiting in the queue');

	// It leaves WHILE WAITING. Nothing about the handshake has failed - it passed
	// every gate and simply has not had its turn yet.
	gone.abort();

	// One macrotask, so the queue's next drain runs the waiting continuation.
	await new Promise((resolve) => setImmediate(resolve));
	const answer = await queued;

	assert.ok(answer && answer.status === 503, `the queued handshake is answered, got ${answer && answer.status}`);
	assert.equal(answer.headers.get('retry-after'), null, 'as abandoned, not as shed');
	assert.equal(srv.taken, 1, 'and no socket was taken for a client that had gone');
	assert.equal(
		wsCounters.upgradeRejectedTotal,
		refusedBefore,
		'a client that left is not capacity pressure'
	);
	assert.equal(upgradeAdmission.deferredDepth, 0, 'the queue is empty again');
});
