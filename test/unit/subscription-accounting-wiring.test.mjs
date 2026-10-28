import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The accounting primitives wired into the real lanes: platform.subscribe,
// platform.unsubscribe and the close handler all move the worker's total
// through the one sink, and a release that lands after a close charges nothing.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
const { WS_SUBSCRIPTIONS, adjustTotalSubscriptions, wsCounters } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const {
	accountClosedLogicalSubscriptions,
	addLogicalSubscription,
	isSettledSubscriptionRegistry,
	removeLogicalSubscription,
	setSubscriptionAccountingHook
} = await import('../../src/runtime/utils/ws-symbols.js');
const { checkTotalSubscriptions } = await import('../../src/runtime/invariants.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

beforeEach(() => {
	// Every topic here is public: the accounting is the subject, not the gate.
	__setHooks({ subscribe: () => null });
});

/** A stand-in for the socket facade over a plain userData object. */
function fakeWs() {
	const native = new Set();
	const subscriptions = new Set();
	const ud = { [WS_SUBSCRIPTIONS]: subscriptions };
	return {
		native,
		subscriptions,
		getUserData: () => ud,
		subscribe(/** @type {string} */ topic) { native.add(topic); return true; },
		unsubscribe(/** @type {string} */ topic) { native.delete(topic); return true; }
	};
}

/** A stand-in for Bun's raw socket, carrying what a real upgrade hands `open`. */
function rawSocket() {
	const native = new Set();
	return {
		native,
		data: upgradeData(),
		readyState: 1,
		send: (/** @type {string} */ payload) => payload.length,
		subscribe: (/** @type {string} */ topic) => { native.add(topic); return true; },
		unsubscribe: (/** @type {string} */ topic) => { native.delete(topic); return true; },
		isSubscribed: (/** @type {string} */ topic) => native.has(topic),
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (/** @type {() => unknown} */ fn) => fn()
	};
}

test('the runtime installs its own counter as the worker sink', () => {
	// Re-installing the installed function is the one install that reports no
	// displacement, so this names exactly which function holds the slot.
	assert.equal(setSubscriptionAccountingHook(adjustTotalSubscriptions), false);
});

test('platform, primitive, unsubscribe and close deltas stay balanced', async () => {
	const baseline = wsCounters.totalSubscriptions;
	const ws = fakeWs();

	assert.equal(await platform.subscribe(ws, 'platform-room'), null);
	assert.equal(await platform.subscribe(ws, 'platform-room'), null);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1, 'a held topic is not charged twice');

	assert.equal(addLogicalSubscription(ws.subscriptions, 'wire-room'), true);
	assert.equal(addLogicalSubscription(ws.subscriptions, 'wire-room'), false);
	assert.equal(wsCounters.totalSubscriptions, baseline + 2);

	assert.equal(platform.unsubscribe(ws, 'platform-room'), true);
	assert.equal(platform.unsubscribe(ws, 'platform-room'), false);
	assert.equal(removeLogicalSubscription(ws.subscriptions, 'wire-room'), true);
	assert.equal(wsCounters.totalSubscriptions, baseline);

	assert.equal(await platform.subscribe(ws, 'last'), null);
	assert.equal(accountClosedLogicalSubscriptions(ws.subscriptions), 1);
	assert.equal(wsCounters.totalSubscriptions, baseline);
});

test('a release that lands after close accounting charges nothing', async () => {
	// A plugin leave parked in an await, or a revocation that resumes once the
	// socket is gone, must find nothing left to charge. Charging again drives
	// the counter below the truth, and in test mode the clamp's assertion throws.
	const baseline = wsCounters.totalSubscriptions;
	const ws = fakeWs();
	assert.equal(await platform.subscribe(ws, 'room'), null);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);

	assert.equal(accountClosedLogicalSubscriptions(ws.subscriptions), 1);
	assert.equal(wsCounters.totalSubscriptions, baseline);

	assert.equal(platform.unsubscribe(ws, 'room'), true, 'the membership itself is still removed');
	assert.equal(wsCounters.totalSubscriptions, baseline);
});

test('the close handler settles the connection, and a later release is not charged', async () => {
	const baseline = wsCounters.totalSubscriptions;
	const raw = rawSocket();
	websocketHandlers.open(raw);
	const ws = wsFacade(raw);
	const subscriptions = raw.data[WS_SUBSCRIPTIONS];
	assert.equal(await platform.subscribe(ws, 'a'), null);
	assert.equal(await platform.subscribe(ws, 'b'), null);
	assert.equal(wsCounters.totalSubscriptions, baseline + 2);

	raw.readyState = 3;
	websocketHandlers.close(raw, 1000, '');
	assert.equal(wsCounters.totalSubscriptions, baseline);
	assert.equal(isSettledSubscriptionRegistry(subscriptions), true, 'the close settled the set');
	assert.equal(subscriptions.size, 0, 'and emptied it afterwards');

	// A copy of the helpers holding the set from before the close. Each
	// direction is checked on its own: an add and a remove net to zero whether
	// the set was settled or not.
	addLogicalSubscription(subscriptions, 'late');
	assert.equal(wsCounters.totalSubscriptions, baseline, 'a join after the close is not charged');
	removeLogicalSubscription(subscriptions, 'late');
	assert.equal(wsCounters.totalSubscriptions, baseline, 'nor is its leave');
	assert.equal(accountClosedLogicalSubscriptions(subscriptions), 0);
});

test('the counter agrees with the auditor predicate after closes with late releases', async () => {
	// Two independent halves: the expected value is summed from the live
	// connections' own sets by the auditor's predicate, and the actual is the
	// counter the sink maintains. A check that read the counter twice could not
	// fail.
	const baseline = wsCounters.totalSubscriptions;
	const open = async (/** @type {number} */ index) => {
		const ws = fakeWs();
		await platform.subscribe(ws, 'room-' + index);
		await platform.subscribe(ws, 'shared');
		return { ws, index };
	};
	const live = [await open(0), await open(1)];
	const gone = [await open(2), await open(3)];
	assert.equal(wsCounters.totalSubscriptions, baseline + 8);

	for (const conn of gone) {
		assert.equal(accountClosedLogicalSubscriptions(conn.ws.subscriptions), 2);
		// The late cleanup, on both lanes that reach the registry.
		platform.unsubscribe(conn.ws, 'shared');
		removeLogicalSubscription(conn.ws.subscriptions, 'room-' + conn.index);
	}

	assert.equal(
		checkTotalSubscriptions({
			totalSubscriptions: wsCounters.totalSubscriptions - baseline,
			connections: live.map((conn) => ({
				subscribed: [...conn.ws.subscriptions],
				bookkeeping: [...conn.ws.subscriptions]
			}))
		}),
		null
	);

	for (const conn of live) {
		assert.equal(accountClosedLogicalSubscriptions(conn.ws.subscriptions), 2);
	}
	assert.equal(wsCounters.totalSubscriptions, baseline);
});

test('a second runtime in the worker that takes the sink says so', async () => {
	/** @type {string[]} */
	const lines = [];
	const realWarn = console.warn;
	console.warn = (/** @type {unknown} */ line) => { lines.push(String(line)); };
	try {
		// A second instance of the module that owns the counter, the way a second
		// built runtime in one worker would hold one: its own counter, its own
		// install at load.
		const second = await import('../../src/runtime/handler/ws-state.js?second-runtime');
		assert.notEqual(second.adjustTotalSubscriptions, adjustTotalSubscriptions);
	} finally {
		console.warn = realWarn;
		setSubscriptionAccountingHook(adjustTotalSubscriptions);
	}
	assert.equal(lines.length, 1);
	assert.match(
		lines[0],
		/^\[lantean\/diagnostic source=svelte-adapter-bunserve component=runtime\.subscription-accounting event=runtime\.subscription-accounting\.sink-displaced severity=warn\] A second adapter runtime in this worker took over the subscription accounting sink\./
	);
	// And this runtime's counter is the sink again for the rest of the file.
	const baseline = wsCounters.totalSubscriptions;
	const ws = fakeWs();
	await platform.subscribe(ws, 'after');
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
	accountClosedLogicalSubscriptions(ws.subscriptions);
	assert.equal(wsCounters.totalSubscriptions, baseline);
});
