import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Another package's copy of the subscription helpers, driving this runtime's
// real connections. Two copies, neither of them the runtime's own module
// instance:
//
// - test/helpers/uws/ holds svelte-adapter-uws's ws-symbols.js, caps.js and
//   subscribe-policy.js verbatim, as of its commit ed86c50. A plugin built
//   against that adapter carries exactly this module.
// - a copy of this package's own entry, written to a temporary directory, so
//   it is a separate module instance the way a plugin's bundled copy is.
//
// Every case asks the same thing: does the copy move THIS runtime's state -
// the registry, the native membership, the subscription total, the in-flight
// record, the cohort - as the runtime's own lanes would.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
const { WS_CAPS, WS_SHARED_COHORTS, WS_SUBSCRIPTIONS, sharedTopics, wsCounters } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const runtimeSymbols = await import('../../src/runtime/utils/ws-symbols.js');
const { _resetSharedWireIds, getSharedWireId } = await import('../../src/runtime/utils/shared-wire-id.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');
const uws = await import('../helpers/uws/ws-symbols.js');

/** @type {string} */
let copyDir;
/** @type {any} */
let copy;

before(async () => {
	copyDir = mkdtempSync(join(tmpdir(), 'bunserve-subscriptions-'));
	const src = new URL('../../src/', import.meta.url);
	cpSync(new URL('subscriptions.js', src), join(copyDir, 'subscriptions.js'));
	for (const file of ['ws-symbols.js', 'caps.js', 'subscribe-policy.js']) {
		cpSync(new URL(`runtime/utils/${file}`, src), join(copyDir, 'runtime', 'utils', file));
	}
	copy = await import(pathToFileURL(join(copyDir, 'subscriptions.js')).href);
});

after(() => {
	rmSync(copyDir, { recursive: true, force: true });
});

/** @type {any[]} */
let opened = [];
let baseline = 0;

beforeEach(() => {
	__setHooks({ subscribe: () => null });
	for (const raw of opened) {
		if (raw.readyState === 1) {
			raw.readyState = 3;
			websocketHandlers.close(raw, 1000, '');
		}
	}
	opened = [];
	baseline = wsCounters.totalSubscriptions;
});

/** Open one connection through the real handler, recording what it is sent. */
function connect() {
	const native = new Set();
	/** @type {any[]} */
	const sent = [];
	const raw = {
		native,
		sent,
		data: upgradeData(),
		readyState: 1,
		send: (/** @type {string} */ payload) => { sent.push(payload); return payload.length; },
		subscribe: (/** @type {string} */ t) => { native.add(t); return true; },
		unsubscribe: (/** @type {string} */ t) => native.delete(t),
		isSubscribed: (/** @type {string} */ t) => native.has(t),
		closedWith: null,
		close(code, reason) { this.closedWith = { code, reason }; },
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (/** @type {() => unknown} */ fn) => fn()
	};
	websocketHandlers.open(raw);
	opened.push(raw);
	return { raw, ws: wsFacade(raw) };
}

/** Close a connection through the real handler. */
function close(/** @type {any} */ raw) {
	raw.readyState = 3;
	websocketHandlers.close(raw, 1000, '');
}

test('the copies are separate module instances from the runtime\'s', () => {
	assert.notEqual(uws.trackedSubscribe, runtimeSymbols.trackedSubscribe);
	assert.notEqual(copy.trackedSubscribe, runtimeSymbols.trackedSubscribe);
	assert.notEqual(copy.trackedSubscribe, uws.trackedSubscribe);
});

for (const [name, helpers] of [['svelte-adapter-uws\'s copy', () => uws], ['a second copy of this entry', () => copy]]) {
	test(`${name} moves the registry, native membership and the total`, () => {
		const { trackedSubscribe, trackedUnsubscribe } = helpers();
		const { raw, ws } = connect();
		assert.equal(trackedSubscribe(ws, 'room'), true);
		assert.ok(raw.data[WS_SUBSCRIPTIONS].has('room'));
		assert.ok(raw.native.has('room'));
		assert.equal(wsCounters.totalSubscriptions, baseline + 1, 'charged through the runtime\'s sink');
		let walked = 0;
		platform.forEachSubscriber('room', () => { walked++; });
		assert.equal(walked, 1, 'the runtime\'s subscriber walk sees it');

		assert.equal(trackedSubscribe(ws, 'room'), true);
		assert.equal(wsCounters.totalSubscriptions, baseline + 1, 'a repeat join is idempotent');
		assert.equal(trackedUnsubscribe(ws, 'room'), true);
		assert.equal(raw.data[WS_SUBSCRIPTIONS].size, 0);
		assert.ok(!raw.native.has('room'));
		assert.equal(wsCounters.totalSubscriptions, baseline);
		close(raw);
	});

	test(`${name}'s leave cancels a subscribe parked in this runtime's gate`, async () => {
		const { trackedUnsubscribe } = helpers();
		/** @type {Array<() => void>} */
		const releases = [];
		__setHooks({ subscribe: () => new Promise((resolve) => { releases.push(() => resolve(null)); }) });
		const { raw, ws } = connect();
		const landed = websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe', topic: 'room', ref: 1 }));
		for (let i = 0; i < 100 && releases.length === 0; i++) await new Promise((r) => setImmediate(r));
		assert.equal(releases.length, 1, 'the subscribe is parked');
		assert.equal(uws.pendingSubscribeTotal(raw.data), 1, 'svelte-adapter-uws reads this runtime\'s in-flight total');

		trackedUnsubscribe(ws, 'room');
		releases[0]();
		await landed;
		const answer = raw.sent.map((/** @type {string} */ f) => JSON.parse(f)).find((/** @type {any} */ f) => f.ref === 1);
		assert.deepEqual(answer, { type: 'subscribe-denied', topic: 'room', ref: 1, reason: 'FORBIDDEN' });
		assert.ok(!raw.data[WS_SUBSCRIPTIONS].has('room'));
		assert.ok(!raw.native.has('room'));
		assert.equal(wsCounters.totalSubscriptions, baseline);
		close(raw);
	});

	test(`${name} joins and leaves this runtime's shared cohort`, () => {
		const { trackedSubscribe, trackedUnsubscribe } = helpers();
		const { raw, ws } = connect();
		raw.data[WS_CAPS] = new Set(['cap:1']);
		sharedTopics.set('board', 'cap:1');
		try {
			assert.equal(trackedSubscribe(ws, 'board'), true);
			assert.ok(raw.native.has('board\0bin'), 'joined the binary cohort through the platform slot');
			assert.ok(raw.data[WS_SHARED_COHORTS].has('board'));
			const id = getSharedWireId('board');
			assert.ok(id !== undefined);
			assert.equal(trackedUnsubscribe(ws, 'board'), true);
			assert.ok(!raw.native.has('board\0bin'));
			assert.ok(!raw.native.has('board\0json'));
			assert.equal(getSharedWireId('board'), undefined, 'and gave its reference back');
		} finally {
			raw.data[WS_CAPS] = undefined;
			sharedTopics.delete('board');
			_resetSharedWireIds();
			close(raw);
		}
	});

	test(`${name}'s late leave after close charges nothing`, () => {
		const { trackedSubscribe, trackedUnsubscribe } = helpers();
		const { raw, ws } = connect();
		const subscriptions = raw.data[WS_SUBSCRIPTIONS];
		assert.equal(trackedSubscribe(ws, 'room'), true);
		assert.equal(wsCounters.totalSubscriptions, baseline + 1);
		close(raw);
		assert.equal(wsCounters.totalSubscriptions, baseline, 'the close released it');
		assert.equal(trackedUnsubscribe(ws, 'room'), false, 'the socket is gone');
		assert.equal(wsCounters.totalSubscriptions, baseline);
		// The settle mark is shared across copies, so none of them can release
		// the registry a second time.
		assert.equal(uws.isSettledSubscriptionRegistry(subscriptions), true);
		assert.equal(uws.accountClosedLogicalSubscriptions(subscriptions), 0);
		assert.equal(wsCounters.totalSubscriptions, baseline);
	});
}

test('svelte-adapter-uws\'s record helpers read this runtime\'s in-flight record', () => {
	// The other direction: the runtime opens the attempt, the copy settles it.
	const ud = {};
	const token = runtimeSymbols.beginPendingSubscribe(ud, 'room');
	assert.equal(uws.tombstonePendingSubscribe(ud, 'room'), true);
	assert.equal(runtimeSymbols.settlePendingSubscribe(ud, 'room', token), false, 'the copy\'s cancellation stands');
	const fresh = uws.beginPendingSubscribe(ud, 'room', false);
	assert.equal(runtimeSymbols.settleHeldSubscribe(ud, 'room', fresh), 'ack');
	assert.equal(uws.pendingSubscribeTotal(ud), 0);
	assert.equal(runtimeSymbols.pendingSubscribeTotal(ud), 0);
});

test('svelte-adapter-uws\'s observer lane runs the app\'s unsubscribe hook through this runtime\'s slot', async () => {
	// The shape its presence and cursor plugins have: an authorization that
	// installs membership and then refuses. Its unwind has no reference to the
	// app's hooks, so it reaches them through the platform slot.
	let unsubscribeRuns = 0;
	__setHooks({ subscribe: () => null, unsubscribe() { unsubscribeRuns++; } });
	const { raw, ws } = connect();
	const allowed = await uws.authorizeDerivedSubscribe(ws, 'room', async () => {
		uws.trackedSubscribe(ws, 'room');
		return 'FORBIDDEN';
	});
	assert.equal(allowed, false);
	assert.ok(!raw.data[WS_SUBSCRIPTIONS].has('room'), 'the membership the refusing hook installed is gone');
	assert.equal(unsubscribeRuns, 1, 'and the app hook ran for it');
	assert.equal(wsCounters.totalSubscriptions, baseline);
	close(raw);
});

// Last in the file: the registration lives on globalThis for the rest of the
// process, the way a plugin's does.
test('a tap a plugin derived from a topic is released when the topic is revoked or unwound', () => {
	uws.registerDerivedTopicPrefix('__tap:');
	const { raw, ws } = connect();
	uws.trackedSubscribe(ws, 'room');
	uws.trackedSubscribe(ws, '__tap:room');
	platform.unsubscribe(ws, 'room');
	assert.ok(!raw.data[WS_SUBSCRIPTIONS].has('room'));
	assert.ok(!raw.data[WS_SUBSCRIPTIONS].has('__tap:room'), 'the revocation took the tap with it');
	assert.ok(!raw.native.has('__tap:room'));

	uws.trackedSubscribe(ws, 'room');
	uws.trackedSubscribe(ws, '__tap:room');
	runtimeSymbols.unwindRevokedMembership(ws, 'room');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].size, 0, 'so did the unwind');

	// An observer holding only the tap: the revocation takes it whether or not
	// the base membership is there.
	uws.trackedSubscribe(ws, '__tap:room');
	assert.equal(platform.unsubscribe(ws, 'room'), false, 'there was no base membership');
	assert.ok(!raw.data[WS_SUBSCRIPTIONS].has('__tap:room'), 'the tap went anyway');
	assert.equal(wsCounters.totalSubscriptions, baseline);
	close(raw);
});


test('platform unsubscribe reports cancelled authorization and dispatches held teardown once', async () => {
	const { raw, ws } = connect();
	let release;
	const removed = [];
	__setHooks({ subscribe: () => new Promise(resolve => { release = resolve; }), unsubscribe: (_ws, topic) => { removed.push(topic); } });
	const pending = platform.subscribe(ws, 'parked');
	assert.equal(platform.unsubscribe(ws, 'parked'), true);
	release(null);
	assert.equal(await pending, 'FORBIDDEN');
	assert.deepEqual(removed, []);
	runtimeSymbols.trackedSubscribe(ws, 'held');
	assert.equal(platform.unsubscribe(ws, 'held'), true);
	assert.equal(platform.unsubscribe(ws, 'held'), false);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(removed, ['held']);
	assert.equal(raw.native.has('held'), false);
	close(raw);
});


test('wire unsubscribe dispatches a held teardown only once', async () => {
	const { raw, ws } = connect();
	const removed = [];
	__setHooks({ unsubscribe: (_ws, topic) => { removed.push(topic); } });
	runtimeSymbols.trackedSubscribe(ws, 'held-wire');
	await websocketHandlers.message(raw, JSON.stringify({ type: 'unsubscribe', topic: 'held-wire', ref: 'u' }));
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(removed, ['held-wire']);
	close(raw);
});


test('wire held releases invoke every hook without closing', async () => {
	const { raw, ws } = connect();
	let closed = false;
	raw.close = () => { closed = true; raw.readyState = 2; };
	__setHooks({ unsubscribe: () => new Promise(() => {}) });
	for (let i = 0; i < 1200; i++) runtimeSymbols.trackedSubscribe(ws, `overflow:${i}`);
	for (let i = 0; i < 1200 && !closed; i++) {
		raw.sent.length = 0;
		await websocketHandlers.message(raw, JSON.stringify({ type: 'unsubscribe', topic: `overflow:${i}`, ref: i }));
	}
	assert.equal(closed, false);
	assert.equal(raw.data[runtimeSymbols.WS_SUBSCRIPTIONS].size, 0);
	assert.deepEqual(raw.sent, []);
	close(raw);
});


test('lead plugins read the runtime capability and frozen attribution slots', async () => {
	let observed;
	__setHooks({ attribution: () => ({ tenantId: 'tenant_1' }), open: ws => { observed = ws.getUserData()[uws.WS_ATTRIBUTION]; } });
	const { raw } = connect();
	assert.deepEqual(observed, { tenantId: 'tenant_1' });
	assert.equal(Object.isFrozen(observed), true);
	await websocketHandlers.message(raw, JSON.stringify({ type: 'hello', caps: ['binary'] }));
	assert.equal(raw.data[uws.WS_CAPS].has('binary'), true);
	close(raw);
});

test('invalid attribution refuses before the application open hook', () => {
	let opened = 0;
	for (const attribution of [() => ({ tenantId: 'bad/value' }), () => ({ tenantid: 'misspelled' }), () => Promise.resolve(null), 7]) {
		__setHooks({ attribution, open: () => { opened++; } });
		const { raw } = connect();
		assert.equal(raw.closedWith.code, 1008);
		close(raw);
	}
	assert.equal(opened, 0);
});

test('a prefix registered by the lead reaches the plugin hook and requires tracked membership', async () => {
	uws.registerPluginOwnedPrefix('__interop:');
	const seen = [];
	__setHooks({ subscribe: (ws, topic) => {
		seen.push(topic);
		if (topic.endsWith('allowed')) uws.trackedSubscribe(ws, topic);
		return null;
	} });
	const { raw } = connect();
	await websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe', topic: '__interop:allowed', ref: 1 }));
	await websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe-batch', topics: ['__interop:missing'], ref: 2 }));
	const out = raw.sent.map(JSON.parse);
	assert.deepEqual(seen, ['__interop:allowed', '__interop:missing']);
	assert.equal(out.find(f => f.ref === 1).type, 'subscribed');
	assert.equal(out.find(f => f.ref === 2).reason, 'FORBIDDEN');
	await websocketHandlers.message(raw, JSON.stringify({ type: 'unsubscribe', topic: '__interop:allowed', ref: 3 }));
	assert.equal(raw.native.has('__interop:allowed'), false);
	close(raw);
});


test('server bulk revocation runs every async teardown without closing the socket', async () => {
	const { raw, ws } = connect();
	let release;
	const barrier = new Promise((resolve) => { release = resolve; });
	const completed = new Set();
	let started = 0;
	__setHooks({ unsubscribe: async (_ws, topic) => { started++; await barrier; completed.add(topic); } });
	uws.registerDerivedTopicPrefix('__bulk:');
	for (let i = 0; i < 2500; i++) {
		runtimeSymbols.trackedSubscribe(ws, `revoke:${i}`);
		uws.trackedSubscribe(ws, `__bulk:revoke:${i}`);
	}
	const before = wsCounters.closedWsAborts;
	for (let i = 0; i < 2500; i++) assert.equal(platform.unsubscribe(ws, `revoke:${i}`), true);
	assert.equal(raw.closedWith, null);
	assert.equal(raw.readyState, 1);
	assert.equal(wsCounters.closedWsAborts, before);
	assert.equal(started, 2500);
	release();
	await barrier;
	assert.equal(completed.size, 2500);
	assert.equal(raw.native.size, 0);
	assert.equal(wsCounters.totalSubscriptions, baseline);
	close(raw);
});


test('wire unsubscribe emits no acknowledgement for held or absent topics', async () => {
	__setHooks({});
	const { raw, ws } = connect();
	runtimeSymbols.trackedSubscribe(ws, 'no-ack');
	raw.sent.length = 0;
	await websocketHandlers.message(raw, JSON.stringify({ type: 'unsubscribe', topic: 'no-ack', ref: 1 }));
	assert.equal(raw.native.has('no-ack'), false);
	await websocketHandlers.message(raw, JSON.stringify({ type: 'unsubscribe', topic: 'absent', ref: 2 }));
	assert.deepEqual(raw.sent, []);
	close(raw);
});


for (const verdict of [null, 'FORBIDDEN']) {
	test(`server subscribe revoke races contain every ${verdict === null ? 'allowed' : 'denied'} landing teardown`, async () => {
		const { raw, ws } = connect();
		let allow;
		const authorization = new Promise(resolve => { allow = resolve; });
		let finish;
		const teardown = new Promise(resolve => { finish = resolve; });
		const contexts = [];
		const completed = new Set();
		const warnings = [];
		const savedWarn = console.warn;
		console.warn = (...args) => warnings.push(args);
		__setHooks({
			subscribe: async (socket, topic) => {
				await authorization;
				uws.trackedSubscribe(socket, topic);
				return verdict;
			},
			unsubscribe: async (_socket, topic, ctx) => {
				contexts.push(ctx.platform);
				await teardown;
				completed.add(topic);
			}
		});
		const before = wsCounters.closedWsAborts;
		const topics = Array.from({ length: 1200 }, (_, i) => `race:${i}`);
		const attempts = topics.map(topic => platform.subscribe(ws, topic));
		try {
			assert.equal(runtimeSymbols.pendingSubscribeTotal(raw.data), 1200);
			for (const topic of topics) assert.equal(platform.unsubscribe(ws, topic), true);
			allow();
			assert.deepEqual(await Promise.all(attempts), topics.map(() => 'FORBIDDEN'));
			assert.equal(raw.closedWith, null);
			assert.equal(raw.readyState, 1);
			assert.equal(wsCounters.closedWsAborts, before);
			assert.equal(contexts.length, topics.length);
			for (const ctxPlatform of contexts) assert.equal(ctxPlatform, raw.data[runtimeSymbols.WS_PLATFORM]);
			assert.deepEqual(warnings, []);
			finish();
			await teardown;
			assert.equal(completed.size, topics.length);
			assert.equal(raw.native.size, 0);
			assert.equal(runtimeSymbols.pendingSubscribeTotal(raw.data), 0);
			assert.equal(wsCounters.totalSubscriptions, baseline);
		} finally {
			allow();
			finish();
			await Promise.allSettled(attempts);
			console.warn = savedWarn;
			close(raw);
		}
	});
}

test('external observer deny-unwind hook slot does not consume the client release queue', async () => {
	const { raw, ws } = connect();
	let finish;
	const barrier = new Promise(resolve => { finish = resolve; });
	let started = 0;
	const contexts = [];
	__setHooks({ unsubscribe: async (_socket, _topic, ctx) => {
		started++;
		contexts.push(ctx.platform);
		await barrier;
	} });
	const before = wsCounters.closedWsAborts;
	try {
		for (let i = 0; i < 1200; i++) {
			platform[runtimeSymbols.WS_REVOKED_UNSUBSCRIBE](ws, `observer:${i}`, raw.data);
		}
		assert.equal(raw.closedWith, null);
		assert.equal(started, 1200);
		assert.equal(wsCounters.closedWsAborts, before);
		for (const ctxPlatform of contexts) assert.equal(ctxPlatform, raw.data[runtimeSymbols.WS_PLATFORM]);
	} finally {
		finish();
		await barrier;
		close(raw);
	}
});

test('server unsubscribe contains a rejecting hook and passes the owning platform', async () => {
	const { raw, ws } = connect();
	uws.trackedSubscribe(ws, 'rejecting');
	const failure = new Error('server teardown rejected');
	const errors = [];
	const savedError = console.error;
	let ctxPlatform;
	console.error = (...args) => errors.push(args);
	__setHooks({ unsubscribe: async (_socket, _topic, ctx) => {
		ctxPlatform = ctx.platform;
		await Promise.resolve();
		throw failure;
	} });
	try {
		assert.equal(platform.unsubscribe(ws, 'rejecting'), true);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(raw.closedWith, null);
		assert.equal(ctxPlatform, raw.data[runtimeSymbols.WS_PLATFORM]);
		assert.ok(errors.some(args => args.some(value => typeof value === 'string' && value.includes('unsubscribe.hook-failed'))));
		assert.ok(errors.some(args => args.some(value => typeof value === 'string' && value.includes('svelte-adapter-bunserve'))));
		assert.equal(raw.native.size, 0);
	} finally {
		console.error = savedError;
		close(raw);
	}
});


for (const verdict of [null, 'FORBIDDEN']) {
	test(`wire subscribe deny-unwind invokes every teardown for ${verdict === null ? 'allowed' : 'denied'} hooks`, async () => {
		const { raw, ws } = connect();
		let allow;
		const authorization = new Promise(resolve => { allow = resolve; });
		let finish;
		const teardown = new Promise(resolve => { finish = resolve; });
		let started = 0;
		__setHooks({
			subscribe: async (socket, topic) => {
				await authorization;
				uws.trackedSubscribe(socket, topic);
				return verdict;
			},
			unsubscribe: async () => { started++; await teardown; }
		});
		const topics = Array.from({ length: 1200 }, (_, i) => `wire-race:${i}`);
		const attempts = topics.map(topic => websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe', topic })));
		try {
			assert.equal(runtimeSymbols.pendingSubscribeTotal(raw.data), topics.length);
			for (const topic of topics) assert.equal(platform.unsubscribe(ws, topic), true);
			allow();
			await Promise.all(attempts);
			assert.equal(raw.closedWith, null);
			assert.equal(started, topics.length, 'every wire teardown runs without closing the socket');
			assert.equal(runtimeSymbols.pendingSubscribeTotal(raw.data), 0);
		} finally {
			allow();
			finish();
			await Promise.allSettled(attempts);
			close(raw);
		}
	});
}

test('wire unsubscribe releases every string topic silently and runs its hook', async () => {
	const seen = [];
	__setHooks({ unsubscribe: (socket, topic) => {
		assert.equal(socket.isSubscribed(topic), false, 'native membership is released before teardown');
		seen.push(topic);
	} });
	const { raw, ws } = connect();
	const topics = ['', 'bad' + String.fromCharCode(0), '__presence:room', '__realtime', 'x'.repeat(300), 'room:M\u00fcller', 'absent'];
	const nativeUnsubscribe = raw.unsubscribe;
	raw.unsubscribe = topic => {
		if (topic === '') throw new TypeError('unsubscribe requires a non-empty topic name');
		return nativeUnsubscribe(topic);
	};
	for (const topic of topics) if (topic !== '' && topic !== 'absent') ws.subscribe(topic);
	runtimeSymbols.trackedSubscribe(ws, '__realtime');
	const aborted = wsCounters.closedWsAborts;
	raw.sent.length = 0;
	for (const topic of topics) {
		raw.data[runtimeSymbols.WS_PUBLISH_GRANT] = topic;
		await websocketHandlers.message(raw, JSON.stringify({ type: 'unsubscribe', topic, ref: 1 }));
		assert.equal(raw.native.has(topic), false, JSON.stringify(topic));
		assert.equal(raw.data[runtimeSymbols.WS_PUBLISH_GRANT], undefined);
	}
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(seen, topics);
	assert.equal(wsCounters.totalSubscriptions, baseline);
	assert.equal(wsCounters.closedWsAborts, aborted);
	assert.deepEqual(raw.sent, []);
	close(raw);
});
