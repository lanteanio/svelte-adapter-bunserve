import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The subscription slots another copy of the helpers can name. They are keyed
// by svelte-adapter-uws's Symbol.for names, so a copy of either adapter's
// helpers reaches the same connection state, and that makes them reachable by
// an accessor on Object.prototype. The runtime declares them as own properties
// at open; these cases install the accessor first and drive the real handlers,
// so they fail against an assignment and pass only against a declaration.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
const { wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const {
	SHARED_CONNECTION_SLOTS,
	WS_COHORT_JOIN,
	WS_COHORT_LEAVE,
	WS_PENDING_SUBSCRIBES,
	WS_PENDING_SUBSCRIBES_TOTAL,
	WS_PLATFORM,
	WS_SUBSCRIPTIONS,
	declareConnectionSlots
} = await import('../../src/runtime/utils/ws-symbols.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

beforeEach(() => {
	__setHooks({ subscribe: () => null });
});

/** A stand-in for Bun's raw socket, carrying what a real upgrade hands `open`. */
function rawSocket() {
	return {
		data: upgradeData(),
		readyState: 1,
		send: (/** @type {string} */ payload) => payload.length,
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (/** @type {() => unknown} */ fn) => fn()
	};
}

/**
 * Install a stealing accessor on Object.prototype for every shared key, run
 * `body`, and take the accessors down again.
 * @param {(stolen: Array<[symbol, unknown]>) => Promise<void> | void} body
 */
async function underAccessors(body) {
	/** @type {Array<[symbol, unknown]>} */
	const stolen = [];
	for (const key of SHARED_CONNECTION_SLOTS) {
		Object.defineProperty(Object.prototype, key, {
			set(v) { stolen.push([key, v]); },
			get() { return undefined; },
			configurable: true
		});
	}
	try {
		await body(stolen);
	} finally {
		// @ts-expect-error - symbol-keyed accessors on the prototype
		for (const key of SHARED_CONNECTION_SLOTS) delete Object.prototype[key];
	}
}

test('the shared slots carry svelte-adapter-uws\'s registered names', () => {
	assert.equal(Symbol.keyFor(WS_SUBSCRIPTIONS), 'adapter-uws.ws.subscriptions');
	assert.equal(Symbol.keyFor(WS_PENDING_SUBSCRIBES), 'adapter-uws.ws.pending-subscribes');
	assert.equal(Symbol.keyFor(WS_PENDING_SUBSCRIBES_TOTAL), 'adapter-uws.ws.pending-subscribes-total');
	assert.equal(Symbol.keyFor(WS_PLATFORM), 'adapter-uws.ws.platform');
	assert.equal(Symbol.keyFor(WS_COHORT_JOIN), 'adapter-uws.platform.cohort-join');
	assert.equal(Symbol.keyFor(WS_COHORT_LEAVE), 'adapter-uws.platform.cohort-leave');
	assert.deepEqual(
		[...SHARED_CONNECTION_SLOTS].map((key) => Symbol.keyFor(key)).sort(),
		[
			'adapter-uws.ws.attribution',
			'adapter-uws.ws.caps',
			'adapter-uws.ws.ingress-bindings',
			'adapter-uws.ws.pending-subscribes',
			'adapter-uws.ws.pending-subscribes-total',
			'adapter-uws.ws.platform',
			'adapter-uws.ws.publish-grant',
			'adapter-uws.ws.session-id',
			'adapter-uws.ws.subscriptions'
		],
		'every shared slot is registered, and declared'
	);
});

test('an open connection holds every shared slot as an own property', () => {
	const raw = rawSocket();
	websocketHandlers.open(raw);
	for (const key of SHARED_CONNECTION_SLOTS) {
		assert.ok(Object.hasOwn(raw.data, key), String(key));
	}
	// Declared, not filled: a slot the connection has not used still reads
	// undefined, so the lazy initializations keep their falsy guards.
	assert.equal(raw.data[WS_PENDING_SUBSCRIBES], undefined);
	raw.readyState = 3;
	websocketHandlers.close(raw, 1000, '');
});

test('an accessor on Object.prototype takes none of the runtime\'s writes', async () => {
	await underAccessors(async (stolen) => {
		const raw = rawSocket();
		websocketHandlers.open(raw);
		const ws = wsFacade(raw);
		const before = wsCounters.totalSubscriptions;
		assert.equal(await platform.subscribe(ws, 'room'), null);
		assert.equal(stolen.length, 0, 'a slot write reached an inherited setter');
		assert.ok(raw.data[WS_SUBSCRIPTIONS] instanceof Set);
		assert.ok(raw.data[WS_SUBSCRIPTIONS].has('room'));
		assert.equal(raw.data[WS_PLATFORM].requestId, 'req-test');
		assert.ok(raw.data[WS_PENDING_SUBSCRIBES] instanceof Map, 'the in-flight record was created in place');
		assert.equal(raw.data[WS_PENDING_SUBSCRIBES_TOTAL], 0);
		assert.equal(wsCounters.totalSubscriptions, before + 1);
		raw.readyState = 3;
		websocketHandlers.close(raw, 1000, '');
		assert.equal(stolen.length, 0, 'nor did the close');
		assert.equal(wsCounters.totalSubscriptions, before);
	});
});

test('without the declaration the accessor would take the write', async () => {
	// The control for the case above: the same accessor on a plain object that
	// was NOT declared swallows the assignment and leaves no own property.
	await underAccessors((stolen) => {
		const plain = {};
		// @ts-expect-error - a symbol-keyed write
		plain[WS_SUBSCRIPTIONS] = new Set();
		assert.equal(stolen.length, 1);
		assert.equal(Object.hasOwn(plain, WS_SUBSCRIPTIONS), false);

		const declared = {};
		declareConnectionSlots(declared);
		// @ts-expect-error - a symbol-keyed write
		declared[WS_SUBSCRIPTIONS] = new Set();
		assert.equal(stolen.length, 1, 'the declared object kept its own write');
		assert.ok(Object.hasOwn(declared, WS_SUBSCRIPTIONS));
	});
});

test('declaring leaves an already populated slot alone, so the double-init guard keeps its evidence', () => {
	const live = { marker: 'live platform' };
	const userData = { [WS_PLATFORM]: live };
	declareConnectionSlots(userData);
	assert.equal(userData[WS_PLATFORM], live);
	assert.ok(Object.hasOwn(userData, WS_SUBSCRIPTIONS));
	assert.equal(userData[WS_SUBSCRIPTIONS], undefined);
});
