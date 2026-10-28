import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// trackedSubscribe / trackedUnsubscribe on their own: native membership, the
// registry, the cap, the cohort slots and the accounting move together. The
// same cases drive the real platform's slots in ws-wire-publish.test.mjs and a
// late leave after close in test/sim/tracked-late-leave.test.mjs.
import {
	WS_COHORT_JOIN,
	WS_COHORT_LEAVE,
	WS_PLATFORM,
	WS_SUBSCRIPTIONS,
	addLogicalSubscription,
	beginPendingSubscribe,
	removeLogicalSubscription,
	setSubscriptionAccountingHook,
	settlePendingSubscribe,
	trackedSubscribe,
	trackedUnsubscribe
} from '../../src/runtime/utils/ws-symbols.js';
import { MAX_SUBSCRIPTIONS_PER_CONNECTION } from '../../src/runtime/utils/caps.js';
import { exceedsSubscriptionCap } from '../../src/runtime/utils/subscribe-policy.js';

let total = 0;

afterEach(() => {
	setSubscriptionAccountingHook(null);
	total = 0;
});

/** A socket over a plain userData object, recording native membership. */
function fakeWs(ud = { [WS_SUBSCRIPTIONS]: new Set() }) {
	const native = new Set();
	return {
		native,
		ud,
		getUserData: () => ud,
		subscribe(/** @type {string} */ topic) { native.add(topic); return true; },
		unsubscribe(/** @type {string} */ topic) { native.delete(topic); return true; }
	};
}

test('the cohort slots run after the registry update, found through the platform clone', () => {
	/** @type {Array<{ topic: string, inSubs: boolean }>} */
	const joins = [];
	/** @type {Array<{ topic: string, inSubs: boolean }>} */
	const leaves = [];
	// The per-connection platform is a clone of the base platform, so the slots
	// are inherited, not own - the lookup must walk the chain.
	const base = {
		[WS_COHORT_JOIN]: (/** @type {any} */ _ws, /** @type {any} */ ud, /** @type {string} */ topic) =>
			joins.push({ topic, inSubs: ud[WS_SUBSCRIPTIONS].has(topic) }),
		[WS_COHORT_LEAVE]: (/** @type {any} */ _ws, /** @type {any} */ ud, /** @type {string} */ topic) =>
			leaves.push({ topic, inSubs: ud[WS_SUBSCRIPTIONS].has(topic) })
	};
	const ws = fakeWs({ [WS_SUBSCRIPTIONS]: new Set(), [WS_PLATFORM]: Object.create(base) });
	assert.equal(trackedSubscribe(ws, 'room'), true);
	assert.equal(trackedUnsubscribe(ws, 'room'), true);
	// The join sees the membership, the leave sees it gone.
	assert.deepEqual(joins, [{ topic: 'room', inSubs: true }]);
	assert.deepEqual(leaves, [{ topic: 'room', inSubs: false }]);
});

test('a platform without the slots, or no platform, changes membership only', () => {
	for (const platform of [{}, undefined]) {
		const ws = fakeWs({ [WS_SUBSCRIPTIONS]: new Set(), [WS_PLATFORM]: platform });
		assert.equal(trackedSubscribe(ws, 'x'), true);
		assert.equal(ws.ud[WS_SUBSCRIPTIONS].has('x'), true);
		assert.equal(ws.native.has('x'), true);
		assert.equal(trackedUnsubscribe(ws, 'x'), true);
		assert.equal(ws.ud[WS_SUBSCRIPTIONS].has('x'), false);
		assert.equal(ws.native.has('x'), false);
	}
});

test('a tracked join racing another lane is charged once, and so is its leave', () => {
	setSubscriptionAccountingHook((delta) => { total += delta; });
	const ws = fakeWs();
	const subs = ws.ud[WS_SUBSCRIPTIONS];
	// A wire or platform landing and a plugin join on the same Set.
	assert.equal(addLogicalSubscription(subs, 'room'), true);
	assert.equal(trackedSubscribe(ws, 'room'), true);
	assert.equal(trackedSubscribe(ws, 'room'), true);
	assert.equal(total, 1);

	assert.equal(removeLogicalSubscription(subs, 'room'), true);
	assert.equal(trackedUnsubscribe(ws, 'room'), true);
	assert.equal(trackedUnsubscribe(ws, 'room'), true);
	assert.equal(total, 0);
});

test('the cap refuses a new topic, never a held one', () => {
	const subs = new Set();
	for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION - 1; i++) subs.add(`filler:${i}`);
	const ws = fakeWs({ [WS_SUBSCRIPTIONS]: subs });
	assert.equal(trackedSubscribe(ws, 'last'), true, 'the cap admits up to itself');
	assert.equal(subs.size, MAX_SUBSCRIPTIONS_PER_CONNECTION);
	assert.equal(trackedSubscribe(ws, 'one-too-many'), false);
	assert.equal(ws.native.has('one-too-many'), false, 'refused before the native call');
	assert.equal(subs.has('one-too-many'), false);
	assert.equal(trackedSubscribe(ws, 'last'), true, 'a held topic is idempotent at the cap');
});

test('the cap decision: held is exempt, and a missing cap refuses', () => {
	assert.equal(exceedsSubscriptionCap({ held: true, size: 10, max: 10 }), false);
	assert.equal(exceedsSubscriptionCap({ held: false, size: 9, max: 10 }), false);
	assert.equal(exceedsSubscriptionCap({ held: false, size: 10, max: 10 }), true);
	// Every comparison against undefined or NaN is false, so a bare size >= max
	// would answer "not at the cap" for a caller that forgot the argument.
	for (const max of [undefined, NaN, '10', null]) {
		assert.equal(exceedsSubscriptionCap({ held: false, size: 0, max: /** @type {any} */ (max) }), true, String(max));
	}
});

test('a closed socket answers false and changes nothing', () => {
	setSubscriptionAccountingHook((delta) => { total += delta; });
	const closed = {
		getUserData() { throw new Error('closed'); },
		subscribe() { throw new Error('closed'); },
		unsubscribe() { throw new Error('closed'); }
	};
	assert.equal(trackedSubscribe(closed, 'room'), false);
	assert.equal(trackedUnsubscribe(closed, 'room'), false);

	// Readable userData, but the native call fails: the registry is not touched
	// for a membership that does not exist.
	const subs = new Set();
	const refusing = {
		getUserData: () => ({ [WS_SUBSCRIPTIONS]: subs }),
		subscribe() { throw new Error('closed'); },
		unsubscribe() { throw new Error('closed'); }
	};
	assert.equal(trackedSubscribe(refusing, 'room'), false);
	assert.equal(subs.size, 0);
	assert.equal(total, 0);
});

test('a tracked leave cancels a subscribe still in its gate', () => {
	// A plugin evict is a revocation too: a subscribe parked in its await must
	// not land afterwards and re-install what the evict removed.
	const ws = fakeWs();
	const token = beginPendingSubscribe(ws.ud, 'room');
	trackedUnsubscribe(ws, 'room');
	assert.equal(settlePendingSubscribe(ws.ud, 'room', token), false);
});

test('a slot that is not a Set is left alone, and the native call still runs', () => {
	const ws = fakeWs({ [WS_SUBSCRIPTIONS]: ['room'] });
	assert.equal(trackedSubscribe(ws, 'room'), true);
	assert.equal(ws.native.has('room'), true);
	assert.deepEqual(ws.ud[WS_SUBSCRIPTIONS], ['room']);
	assert.equal(trackedUnsubscribe(ws, 'room'), true);
	assert.equal(ws.native.has('room'), false);
});
