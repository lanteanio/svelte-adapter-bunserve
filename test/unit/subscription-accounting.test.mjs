import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// The accounting primitives on their own, with no runtime loaded: nothing here
// installs the runtime's counter, so clearing the sink between cases cannot
// strip it from anything. The wiring into the real lanes is in
// subscription-accounting-wiring.test.mjs.
import {
	WS_SUBSCRIPTIONS,
	accountClosedLogicalSubscriptions,
	createUnaccountedSubscriptionRegistry,
	addLogicalSubscription,
	isSettledSubscriptionRegistry,
	removeLogicalSubscription,
	setSubscriptionAccountingHook,
	trackedSubscribe,
	trackedUnsubscribe
} from '../../src/runtime/utils/ws-symbols.js';
import { checkTotalSubscriptions } from '../../src/runtime/invariants.js';

let total = 0;

test('development registries never charge the production sink across bundled copies', async () => {
	const lead = await import('../helpers/uws/ws-symbols.js');
	const deltas = [];
	setSubscriptionAccountingHook((delta, topic) => deltas.push([delta, topic]));
	for (const create of [createUnaccountedSubscriptionRegistry, lead.createUnaccountedSubscriptionRegistry]) {
		const registry = create();
		assert.equal(addLogicalSubscription(registry, 'first'), true);
		assert.equal(lead.addLogicalSubscription(registry, 'second'), true);
		assert.equal(removeLogicalSubscription(registry, 'first'), true);
		assert.equal(lead.accountClosedLogicalSubscriptions(registry), 1);
		assert.equal(isSettledSubscriptionRegistry(registry), true);
		assert.equal(accountClosedLogicalSubscriptions(registry), 0);
		assert.equal(removeLogicalSubscription(registry, 'second'), true);
	}
	assert.deepEqual(deltas, []);
});

afterEach(() => {
	setSubscriptionAccountingHook(null);
	total = 0;
});

test('a sink that displaces a different one is reported, and nothing else is', () => {
	// The sink is one Symbol.for slot on globalThis so every copy of the module
	// in a worker addresses the same counter. That also means an install
	// REPLACES whatever was there, and the install reports the displacement so
	// the condition has a name.
	const first = (/** @type {number} */ delta) => { total += delta; };
	const second = (/** @type {number} */ delta) => { total += delta; };

	assert.equal(setSubscriptionAccountingHook(first), false, 'installing into an empty slot is not a displacement');
	assert.equal(setSubscriptionAccountingHook(first), false, 'reinstalling the same sink is idempotent');
	assert.equal(setSubscriptionAccountingHook(second), true, 'a different sink took the slot');
	// Clearing is how a caller releases the slot, and the install that follows
	// it is a first install rather than a takeover.
	assert.equal(setSubscriptionAccountingHook(null), false, 'clearing is not a displacement');
	assert.equal(setSubscriptionAccountingHook(first), false, 'installing after a clear is not a displacement');
});

test('every delta goes to the sink that displaced the earlier one', () => {
	// The half that matters downstream: after a takeover the FIRST counter stops
	// moving entirely, which is what strands a total.
	let displacedTotal = 0;
	let activeTotal = 0;
	setSubscriptionAccountingHook((delta) => { displacedTotal += delta; });
	setSubscriptionAccountingHook((delta) => { activeTotal += delta; });

	const subscriptions = new Set();
	addLogicalSubscription(subscriptions, 'room');
	addLogicalSubscription(subscriptions, 'other');
	removeLogicalSubscription(subscriptions, 'room');

	assert.equal(displacedTotal, 0, 'the displaced sink kept receiving deltas');
	assert.equal(activeTotal, 1);
});

test('every delta carries the topic it describes', () => {
	/** @type {Array<[number, string]>} */
	const deltas = [];
	setSubscriptionAccountingHook((delta, topic) => { deltas.push([delta, topic]); });
	const subscriptions = new Set();
	addLogicalSubscription(subscriptions, 'a');
	addLogicalSubscription(subscriptions, 'b');
	removeLogicalSubscription(subscriptions, 'a');
	accountClosedLogicalSubscriptions(subscriptions);
	assert.deepEqual(deltas, [[1, 'a'], [1, 'b'], [-1, 'a'], [-1, 'b']]);
});

test('duplicate adds and removals are charged exactly once', () => {
	setSubscriptionAccountingHook((delta) => { total += delta; });
	const subscriptions = new Set();

	assert.equal(addLogicalSubscription(subscriptions, 'room'), true);
	assert.equal(addLogicalSubscription(subscriptions, 'room'), false);
	assert.equal(total, 1);
	assert.equal(
		checkTotalSubscriptions({ totalSubscriptions: total, connections: [{ subscribed: ['room'], bookkeeping: ['room'] }] }),
		null
	);

	assert.equal(removeLogicalSubscription(subscriptions, 'room'), true);
	assert.equal(removeLogicalSubscription(subscriptions, 'room'), false);
	assert.equal(total, 0);
});

test('close charges every still-live membership once', () => {
	setSubscriptionAccountingHook((delta) => { total += delta; });
	const subscriptions = new Set();
	addLogicalSubscription(subscriptions, 'wire');
	addLogicalSubscription(subscriptions, 'platform');
	addLogicalSubscription(subscriptions, 'tracked');
	assert.equal(total, 3);
	assert.equal(accountClosedLogicalSubscriptions(subscriptions), 3);
	assert.equal(total, 0);
});

test('the registry is settled once, so a repeated close releases nothing', () => {
	setSubscriptionAccountingHook((delta) => { total += delta; });
	const subscriptions = new Set();
	addLogicalSubscription(subscriptions, 'one');
	addLogicalSubscription(subscriptions, 'two');
	assert.equal(accountClosedLogicalSubscriptions(subscriptions), 2);
	assert.equal(total, 0);
	// Still populated - settling does not empty the set - so a second call must
	// not read those two entries as two more live memberships to release.
	assert.equal(subscriptions.size, 2);
	assert.equal(isSettledSubscriptionRegistry(subscriptions), true);
	assert.equal(accountClosedLogicalSubscriptions(subscriptions), 0);
	assert.equal(total, 0);
});

test('neither a release nor a subscribe that lands after close is charged', () => {
	setSubscriptionAccountingHook((delta) => { total += delta; });
	const subscriptions = new Set();
	addLogicalSubscription(subscriptions, 'room');
	assert.equal(accountClosedLogicalSubscriptions(subscriptions), 1);
	assert.equal(total, 0);

	// Both directions: a late leave must not push the counter below the truth,
	// and a late join must not raise it for a connection that is already gone.
	assert.equal(removeLogicalSubscription(subscriptions, 'room'), true);
	assert.equal(total, 0);
	assert.equal(addLogicalSubscription(subscriptions, 'room'), true);
	assert.equal(total, 0);
});

test('a corrupted subscription slot releases nothing, and does not throw', () => {
	// The close path calls this from a `finally`, so a throw would escape the
	// close callback and abandon the rest of the connection's teardown.
	setSubscriptionAccountingHook((delta) => { total += delta; });
	for (const corrupt of [undefined, null, 'room', 7, { size: 3 }, ['room']]) {
		assert.doesNotThrow(() => accountClosedLogicalSubscriptions(/** @type {any} */ (corrupt)));
		assert.equal(accountClosedLogicalSubscriptions(/** @type {any} */ (corrupt)), 0);
		assert.equal(isSettledSubscriptionRegistry(corrupt), false);
	}
	assert.equal(total, 0);
});

test('a live registry that merely emptied itself keeps being charged', () => {
	// The mark keys on the close having run, NOT on the set being empty: a
	// connection that unsubscribes from everything and then subscribes again is
	// still live, and every one of those deltas must still be charged.
	setSubscriptionAccountingHook((delta) => { total += delta; });
	const subscriptions = new Set();
	addLogicalSubscription(subscriptions, 'room');
	assert.equal(removeLogicalSubscription(subscriptions, 'room'), true);
	assert.equal(subscriptions.size, 0);
	assert.equal(total, 0);
	addLogicalSubscription(subscriptions, 'room');
	assert.equal(total, 1);
	assert.equal(accountClosedLogicalSubscriptions(subscriptions), 1);
	assert.equal(total, 0);
});

test('with no sink installed, membership still moves and nothing is charged', () => {
	const subscriptions = new Set();
	assert.equal(addLogicalSubscription(subscriptions, 'room'), true);
	assert.equal(removeLogicalSubscription(subscriptions, 'room'), true);
	assert.equal(subscriptions.size, 0);
});

// The process-wide slots hang off globalThis under Symbol.for keys, so one
// accessor on Object.prototype would take the publication for every module copy
// at once. Each case installs the accessor first and then uses the slot
// through its entry point, so it fails against an assignment and passes only
// when the write defines an own property.

/**
 * @param {symbol} key
 * @param {(stolen: unknown[]) => void | Promise<void>} body
 */
async function underAccessor(key, body) {
	const before = Object.getOwnPropertyDescriptor(globalThis, key);
	// @ts-expect-error - a symbol-keyed global slot
	if (before) delete globalThis[key];
	/** @type {unknown[]} */
	const stolen = [];
	Object.defineProperty(Object.prototype, key, {
		set(v) { stolen.push(v); },
		get() { return undefined; },
		configurable: true
	});
	try {
		await body(stolen);
	} finally {
		// @ts-expect-error - a symbol-keyed accessor on the prototype
		delete Object.prototype[key];
		// @ts-expect-error - a symbol-keyed global slot
		delete globalThis[key];
		if (before) Object.defineProperty(globalThis, key, before);
	}
}

test('the accounting sink is installed, not swallowed by an accessor', async () => {
	await underAccessor(Symbol.for('adapter-uws.subscription-accounting-hook'), (stolen) => {
		/** @type {Array<[number, string]>} */
		const deltas = [];
		assert.equal(setSubscriptionAccountingHook((delta, topic) => { deltas.push([delta, topic]); }), false);
		assert.deepEqual(stolen, []);
		const subs = new Set();
		const ws = {
			getUserData: () => ({ [WS_SUBSCRIPTIONS]: subs }),
			subscribe: () => true,
			unsubscribe: () => true
		};
		trackedSubscribe(ws, 'room:2');
		trackedUnsubscribe(ws, 'room:2');
		assert.deepEqual(deltas, [[1, 'room:2'], [-1, 'room:2']]);
	});
});

test('the settled mark is published under an accessor, and every later copy reads it', async () => {
	const key = Symbol.for('adapter-uws.subscription-registry-states');
	await underAccessor(key, async (stolen) => {
		// A copy may publish the mark when it loads or when it first needs it,
		// so the copy has to load under the accessor too: a fresh instance, the
		// way a plugin's bundled copy loads.
		const copy = await import('../../src/runtime/utils/ws-symbols.js?settled-under-accessor');
		const subs = new Set(['room:3']);
		assert.equal(copy.accountClosedLogicalSubscriptions(subs), 1);
		assert.deepEqual(stolen, [], 'the mark was handed to the accessor');
		const own = Object.getOwnPropertyDescriptor(globalThis, key);
		assert.ok(own && own.value instanceof WeakMap, 'the mark is not an own property of globalThis');
		assert.equal(copy.isSettledSubscriptionRegistry(subs), true);
		assert.equal(copy.accountClosedLogicalSubscriptions(subs), 0, 'a settled registry releases nothing twice');
		// svelte-adapter-uws's copy, which looks the mark up on every call, finds
		// the published one past the accessor.
		const lead = await import('../helpers/uws/ws-symbols.js?settled-under-accessor');
		assert.equal(lead.isSettledSubscriptionRegistry(subs), true);
		assert.equal(lead.accountClosedLogicalSubscriptions(subs), 0);
		// A copy that loads afterwards reads the published mark rather than
		// building its own. Under an assignment it would read `undefined` back
		// through the accessor, and its late release would charge the
		// membership a second time.
		const later = await import('../../src/runtime/utils/ws-symbols.js?settled-later-copy');
		assert.equal(later.isSettledSubscriptionRegistry(subs), true);
		assert.equal(later.accountClosedLogicalSubscriptions(subs), 0);
	});
});

test('a copy that loads after svelte-adapter-uws\'s copy published the mark reads that mark', async () => {
	// The other order: svelte-adapter-uws's copy, which publishes the mark on
	// its first call rather than at load, settles a registry before this module
	// has loaded. The copy loading afterwards has to take that WeakMap, not
	// build one beside it.
	const key = Symbol.for('adapter-uws.subscription-registry-states');
	const before = Object.getOwnPropertyDescriptor(globalThis, key);
	// @ts-expect-error - a symbol-keyed global slot
	delete globalThis[key];
	try {
		const lead = await import('../helpers/uws/ws-symbols.js');
		const subs = new Set(['room:4']);
		assert.equal(lead.accountClosedLogicalSubscriptions(subs), 1);
		const published = Object.getOwnPropertyDescriptor(globalThis, key);
		assert.ok(published && published.value instanceof WeakMap, 'the lead\'s copy published no mark');
		const later = await import('../../src/runtime/utils/ws-symbols.js?after-the-lead-copy');
		assert.equal(later.isSettledSubscriptionRegistry(subs), true);
		assert.equal(later.accountClosedLogicalSubscriptions(subs), 0, 'the registry was released a second time');
	} finally {
		// @ts-expect-error - a symbol-keyed global slot
		delete globalThis[key];
		if (before) Object.defineProperty(globalThis, key, before);
	}
});
