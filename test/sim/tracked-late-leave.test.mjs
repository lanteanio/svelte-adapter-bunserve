import { test } from 'node:test';
import assert from 'node:assert/strict';

// A tracked leave that runs after its connection closed - a continuation of an
// async close hook - must release nothing the close already released. The
// close gave back the connection's shared wire-id reference; a second release
// would retire the id while another member still holds it, and every later
// shared publish would build no frame for that member.

const { runSim } = await import('../../src/sim.js');
const { trackedSubscribe, trackedUnsubscribe } = await import('../../src/runtime/utils/ws-symbols.js');
const { WS_SHARED_COHORTS } = await import('../../src/runtime/handler/ws-state.js');

const CAP = 'snap:1';
const TOPIC = 'board';
const sharedCodec = {
	capability: CAP,
	schemaVersion: 1,
	shared: true,
	encode: () => new Uint8Array([7, 7])
};

test('a tracked leave after close releases nothing the close already released', async () => {
	/** @type {(() => boolean) | null} */
	let lateLeave = null;
	/** @type {boolean | null} */
	let lateResult = null;
	let bBinary = -1;
	const result = await runSim({
		clients: 0,
		handler: {
			message(/** @type {any} */ ws, /** @type {any} */ { msg }) {
				if (msg && msg.type === 'plugin-join') trackedSubscribe(ws, msg.topic);
			},
			close(/** @type {any} */ ws) {
				lateLeave = () => trackedUnsubscribe(ws, TOPIC);
			}
		},
		async scenario(api) {
			const a = api.connect();
			const b = api.connect();
			await api.advance();
			for (const c of [a, b]) {
				c.send({ type: 'hello', caps: [CAP] });
				c.send({ type: 'plugin-join', topic: TOPIC });
			}
			await api.advance();
			// The first shared publish moves both members into the binary cohort.
			api.server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec);
			await api.advance();
			a.close();
			await api.advance();
			assert.equal(typeof lateLeave, 'function', 'the close hook ran');
			lateResult = /** @type {() => boolean} */ (lateLeave)();
			api.server.platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec);
			await api.advance();
			bBinary = b.frames().filter((/** @type {any} */ f) => f.isBinary).length;
		}
	});
	assert.deepEqual(result.schedulerUncaught, [], 'the dispatch threw nothing');
	assert.deepEqual(result.invariantViolations, []);
	assert.equal(lateResult, false, 'the leave found a closed socket');
	assert.equal(bBinary, 2, 'the remaining member gets both shared frames');
});

test('a tracked leave made inside the close hook releases the cohort reference once', async () => {
	// Before the socket detaches its userData still answers, so this leave
	// does reach the cohort slot and gives the reference back - and the close
	// that follows must not give it back again.
	let bBinary = -1;
	/** @type {boolean | null} */
	let leftInClose = null;
	/** @type {boolean | null} */
	let cohortHeldAfterLeave = null;
	const result = await runSim({
		clients: 0,
		handler: {
			message(/** @type {any} */ ws, /** @type {any} */ { msg }) {
				if (msg && msg.type === 'plugin-join') trackedSubscribe(ws, msg.topic);
			},
			close(/** @type {any} */ ws) {
				leftInClose = trackedUnsubscribe(ws, TOPIC);
				cohortHeldAfterLeave = ws.getUserData()[WS_SHARED_COHORTS]?.has(TOPIC) ?? false;
			}
		},
		async scenario(api) {
			const a = api.connect();
			const b = api.connect();
			await api.advance();
			for (const c of [a, b]) {
				c.send({ type: 'hello', caps: [CAP] });
				c.send({ type: 'plugin-join', topic: TOPIC });
			}
			await api.advance();
			api.server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec);
			await api.advance();
			a.close();
			await api.advance();
			api.server.platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec);
			await api.advance();
			bBinary = b.frames().filter((/** @type {any} */ f) => f.isBinary).length;
		}
	});
	assert.deepEqual(result.schedulerUncaught, [], 'the dispatch threw nothing');
	assert.deepEqual(result.invariantViolations, [], 'the subscription total stayed consistent');
	assert.equal(leftInClose, false, 'the socket was already closed for writes');
	assert.equal(cohortHeldAfterLeave, false, 'the leave reached the cohort slot and gave the reference back');
	assert.equal(bBinary, 2, 'the remaining member gets both shared frames');
});
