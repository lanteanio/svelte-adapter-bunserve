import { test } from 'node:test';
import assert from 'node:assert/strict';

// A REVOCATION LANDING WHILE THE BATCH GATE IS PARKED. Bun does not await the
// message handler, so an `unsubscribe` frame - or a server-side
// `platform.unsubscribe` - runs to completion between a `subscribe-batch`
// entering the app's hook and its topics landing. The single-subscribe spelling
// stamps an in-flight token before its gate and refuses to install afterwards;
// the batch spelling has to do the same, or the same request refused on one
// path installs on the other and the client holds a subscription it cancelled.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = { allowedOrigins: 'any', path: '/ws', handler: 'src/ws-handler.js' };

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { MAX_SUBSCRIPTIONS_PER_CONNECTION, WS_SUBSCRIPTIONS, pendingSubscribeTopics } =
	await import('../../src/runtime/handler/ws-state.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

/** The minimum of Bun's ServerWebSocket the subscribe lanes touch. */
function rawSocket() {
	const sent = [];
	const joined = new Set();
	const raw = {
		sent,
		joined,
		data: upgradeData(),
		readyState: 1,
		send(payload) { sent.push(payload); return payload.length; },
		subscribe(topic) { joined.add(topic); },
		unsubscribe(topic) { joined.delete(topic); },
		isSubscribed(topic) { return joined.has(topic); },
		getBufferedAmount() { return 0; },
		cork(fn) { return fn(); },
		close() { raw.readyState = 3; },
		terminate() { raw.readyState = 3; }
	};
	return raw;
}

/** A deferred, so a test can hold the app's gate open and act while it is parked. */
function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

/**
 * Open a connection through the real `open` handler, so its userData carries
 * the slots the subscribe lanes read.
 */
function connect() {
	const raw = rawSocket();
	websocketHandlers.open(raw);
	return { raw, ud: raw.data };
}

test('a revoke during the BATCH gate cancels the install, as it does on the single lane', async () => {
	const gate = deferred();
	const enteredSignal = deferred();
	let entered = null;
	__setHooks({
		subscribeBatch: async (ws) => {
			entered = ws;
			enteredSignal.resolve();
			await gate.promise;
			return {};
		}
	});
	try {
		const { raw, ud } = connect();
		const pending = websocketHandlers.message(
			raw,
			'{"type":"subscribe-batch","topics":["room:1"],"ref":1}'
		);
		await enteredSignal.promise;
		// The client's own unsubscribe, or a server-side revocation, arriving
		// while the gate is parked. It must cancel the subscribe in flight.
		platform.unsubscribe(entered, 'room:1');
		gate.resolve();
		await pending;
		assert.equal(
			ud[WS_SUBSCRIPTIONS].has('room:1'),
			false,
			'the batch landed a subscription the client had already cancelled'
		);
		assert.equal(raw.joined.has('room:1'), false, 'and installed it on the socket');
	} finally {
		__setHooks({});
	}
});

test('a re-grant inside the batch window acks, instead of reporting the revoke', async () => {
	// A permission refresh is a revoke followed at once by a re-grant. The
	// cancellation mark only ever rises, so reading it without asking about
	// membership first turns that refresh into a denial for a topic the
	// connection is holding and being fanned out to.
	const gate = deferred();
	const enteredSignal = deferred();
	let parkNext = true;
	let ws = null;
	__setHooks({
		open: (socket) => { ws = socket; },
		subscribeBatch: async () => {
			if (parkNext) {
				parkNext = false;
				enteredSignal.resolve();
				await gate.promise;
			}
			return {};
		}
	});
	try {
		const { raw, ud } = connect();
		const pending = websocketHandlers.message(
			raw,
			'{"type":"subscribe-batch","topics":["room:1"],"ref":3}'
		);
		await enteredSignal.promise;
		platform.unsubscribe(ws, 'room:1');
		assert.equal(await platform.subscribe(ws, 'room:1'), null, 'the re-grant itself failed');
		gate.resolve();
		await pending;
		assert.equal(ud[WS_SUBSCRIPTIONS].has('room:1'), true, 'the re-grant did not stand');
		assert.ok(
			raw.sent.some((f) => f.includes('"type":"subscribed"') && f.includes('"topic":"room:1"')),
			'the client was not acked for a subscription the server is fanning out to it'
		);
		assert.ok(
			!raw.sent.some((f) => f.includes('"type":"subscribe-denied"') && f.includes('"topic":"room:1"')),
			'the client was told its subscription did not stand'
		);
	} finally {
		__setHooks({});
	}
});

test('a hook that mutates the topic array in place cannot desync the stamps', async () => {
	// The hook is handed an ordinary array. An app that filters or sorts it in
	// place - both are ordinary things to do to a list of topics - must not be
	// able to leave the tokens stamped for this frame matched to different
	// topics than the ones they were taken for.
	const gate = deferred();
	const enteredSignal = deferred();
	let parkNext = true;
	let ws = null;
	__setHooks({
		open: (socket) => { ws = socket; },
		subscribeBatch: async (_socket, topics) => {
			// Reordered AND truncated, the two shapes that break an index pairing.
			topics.reverse();
			topics.length = 1;
			if (parkNext) {
				parkNext = false;
				enteredSignal.resolve();
				await gate.promise;
			}
			return {};
		}
	});
	try {
		const { raw, ud } = connect();
		const pending = websocketHandlers.message(
			raw,
			'{"type":"subscribe-batch","topics":["room:a","room:b"],"ref":6}'
		);
		await enteredSignal.promise;
		// The server takes back one of the two while the hook is parked.
		platform.unsubscribe(ws, 'room:a');
		gate.resolve();
		await pending;
		assert.equal(
			ud[WS_SUBSCRIPTIONS].has('room:a'),
			false,
			'the revoked topic was installed because the stamps had been shuffled'
		);
		assert.equal(
			pendingSubscribeTopics(ud),
			0,
			'the frame left in-flight entries behind that nothing will ever settle'
		);
		// Every topic the client named is still answered, whatever the hook did
		// to its copy.
		for (const topic of ['room:a', 'room:b']) {
			assert.ok(
				raw.sent.some((f) => f.includes('"topic":"' + topic + '"')),
				topic + ' was named in the frame and never answered'
			);
		}
	} finally {
		__setHooks({});
	}
});

test('an app denial outranks the re-grant ack', async () => {
	// The hook ran for this topic in this frame and refused it. That the
	// connection happens to hold the topic when the frame settles is not
	// authority to overrule the app.
	const gate = deferred();
	const enteredSignal = deferred();
	let parkNext = true;
	let ws = null;
	__setHooks({
		open: (socket) => { ws = socket; },
		subscribeBatch: async () => {
			if (parkNext) {
				parkNext = false;
				enteredSignal.resolve();
				await gate.promise;
				return { 'room:secret': 'FORBIDDEN' };
			}
			return {};
		}
	});
	try {
		const { raw } = connect();
		const pending = websocketHandlers.message(
			raw,
			'{"type":"subscribe-batch","topics":["room:secret"],"ref":5}'
		);
		await enteredSignal.promise;
		platform.unsubscribe(ws, 'room:secret');
		assert.equal(await platform.subscribe(ws, 'room:secret'), null);
		gate.resolve();
		await pending;
		assert.ok(
			raw.sent.some((f) => f.includes('"reason":"FORBIDDEN"') && f.includes('room:secret')),
			'the app refused the topic and the client was told it had subscribed'
		);
		assert.ok(
			!raw.sent.some((f) => f.includes('"type":"subscribed"') && f.includes('room:secret')),
			'the client was acked for a topic its own server refused'
		);
	} finally {
		__setHooks({});
	}
});

test('pending batch attempts share the server subscribe bound and release it on settlement', async () => {

	const gate = deferred();
	let ws = null;
	__setHooks({
		open: (socket) => { ws = socket; },
		// Only the flood frames park. A one-topic call is what the grant's own
		// gate makes, and it has to be able to answer while they are parked.
		subscribeBatch: async (_socket, topics) => {
			if (topics.length > 1) await gate.promise;
			return {};
		}
	});
	try {
		const { raw } = connect();
		const parked = [];
		for (let f = 0; f < 40; f++) {
			const topics = [];
			for (let i = 0; i < 256; i++) topics.push('flood' + f + ':' + i);
			// No `ref`, so every ack and refusal this frame earns is silent: what
			// is under test is the accounting, not the ack channel.
			parked.push(
				websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe-batch', topics }))
			);
		}
		assert.equal(
			await platform.subscribe(ws, 'server:granted'),
			'RATE_LIMITED',
			'pending batch attempts consume the same bound as server attempts'
		);
		gate.resolve();
		await Promise.all(parked);
		assert.equal(await platform.subscribe(ws, 'server:granted'), null);
	} finally {
		__setHooks({});
	}
});

test('a batch that straddles the subscription cap is refused from the TAIL', async () => {
	// Which entries a straddling frame loses is not cosmetic: the client retries
	// what it was told to retry, so refusing an arbitrary subset in the middle
	// of the frame - whichever the per-topic cap check happened to reach first -
	// leaves it re-sending topics that already installed and dropping ones that
	// never did.
	let hookTopics;
	__setHooks({ subscribeBatch: async (_ws, topics) => { hookTopics = [...topics]; return {}; } });
	try {
		const { raw, ud } = connect();
		// Seeded directly: what is under test is the arithmetic at the boundary,
		// not the tens of thousands of gate calls it would take to reach it
		// honestly. One hundred short of the cap.
		for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION - 100; i++) ud[WS_SUBSCRIPTIONS].add('seed:' + i);
		const topics = [];
		for (let i = 0; i < 256; i++) topics.push('new:' + i);
		await websocketHandlers.message(
			raw,
			JSON.stringify({ type: 'subscribe-batch', topics, ref: 9 })
		);
		assert.deepEqual(hookTopics, topics, 'landed capacity is enforced after the hook');
		assert.equal(ud[WS_SUBSCRIPTIONS].size, MAX_SUBSCRIPTIONS_PER_CONNECTION, 'the cap was not filled exactly');
		assert.equal(ud[WS_SUBSCRIPTIONS].has('new:0'), true, 'the first entry was refused');
		assert.equal(ud[WS_SUBSCRIPTIONS].has('new:99'), true, 'the last admitted entry was refused');
		assert.equal(ud[WS_SUBSCRIPTIONS].has('new:100'), false, 'an entry past the cap installed');
		const refused = raw.sent.filter((f) => f.includes('RATE_LIMITED'));
		assert.equal(refused.length, 156, 'the refusals do not account for the whole tail');
		assert.ok(
			refused.every((f) => {
				const n = Number(/"topic":"new:(\d+)"/.exec(f)?.[1]);
				return n >= 100;
			}),
			'a topic before the boundary was refused'
		);
	} finally {
		__setHooks({});
	}
});

test('the single lane already refuses it, which is the behaviour the batch must match', async () => {
	const gate = deferred();
	const enteredSignal = deferred();
	let entered = null;
	__setHooks({
		subscribe: async (ws) => {
			entered = ws;
			enteredSignal.resolve();
			await gate.promise;
			return null;
		}
	});
	try {
		const { raw, ud } = connect();
		const pending = websocketHandlers.message(
			raw,
			'{"type":"subscribe","topic":"room:1","ref":1}'
		);
		await enteredSignal.promise;
		platform.unsubscribe(entered, 'room:1');
		gate.resolve();
		await pending;
		assert.equal(ud[WS_SUBSCRIPTIONS].has('room:1'), false);
		assert.equal(raw.joined.has('room:1'), false);
	} finally {
		__setHooks({});
	}
});


test('the batch pending-attempt boundary admits exactly the remaining prefix', async () => {
	const { beginPendingSubscribe, settlePendingSubscribe, pendingSubscribeTotal } = await import('../../src/runtime/utils/ws-symbols.js');
	const calls = [];
	__setHooks({ subscribeBatch: (_ws, topics) => { calls.push([...topics]); return {}; } });
	const { raw, ud } = connect();
	const tokens = Array.from({ length: 4095 }, () => beginPendingSubscribe(ud, 'parked', false));
	try {
		await websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe-batch', topics: ['fits', 'overflow'], ref: 90 }));
		assert.deepEqual(calls, [['fits']]);
		assert.equal(ud[WS_SUBSCRIPTIONS].has('fits'), true);
		assert.equal(ud[WS_SUBSCRIPTIONS].has('overflow'), false);
		assert.equal(pendingSubscribeTotal(ud), 4095);
		const denied = raw.sent.map((f) => JSON.parse(f)).find((f) => f.topic === 'overflow');
		assert.equal(denied.reason, 'RATE_LIMITED');
	} finally {
		for (const token of tokens) settlePendingSubscribe(ud, 'parked', token);
		__setHooks({});
	}
});

test('FORBIDDEN wins over a saturated pending-attempt bound on single and batch wire lanes', async () => {
	const { beginPendingSubscribe, settlePendingSubscribe } = await import('../../src/runtime/handler/ws-state.js');
	platform.authorizeWireSubscribe('strict');
	__setHooks({ subscribe: () => null });
	const { raw, ud } = connect();
	const tokens = Array.from({ length: 4096 }, () => beginPendingSubscribe(ud, 'parked', false));
	try {
		await websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe', topic: 'blocked-single', ref: 91 }));
		await websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe-batch', topics: ['blocked-batch'], ref: 92 }));
		for (const ref of [91, 92]) {
			const answer = raw.sent.map((f) => JSON.parse(f)).find((f) => f.ref === ref);
			assert.equal(answer.reason, 'FORBIDDEN');
		}
	} finally {
		for (const token of tokens) settlePendingSubscribe(ud, 'parked', token);
		__setHooks({});
	}
});


test('a pre-denied prefix entry still consumes batch pending headroom', async () => {
	const { beginPendingSubscribe, settlePendingSubscribe } = await import('../../src/runtime/handler/ws-state.js');
	platform.authorizeWireSubscribe('strict');
	const calls = [];
	__setHooks({ subscribeBatch: (_ws, topics) => { calls.push(topics); return {}; } });
	const { raw, ud } = connect();
	ud[WS_SUBSCRIPTIONS].add('held');
	const tokens = Array.from({ length: 4095 }, () => beginPendingSubscribe(ud, 'parked', false));
	try {
		await websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe-batch', topics: ['ungranted', 'held'], ref: 93 }));
		const answers = raw.sent.map(JSON.parse).filter(frame => frame.ref === 93);
		assert.equal(answers.find(frame => frame.topic === 'ungranted').reason, 'FORBIDDEN');
		assert.equal(answers.find(frame => frame.topic === 'held').reason, 'RATE_LIMITED');
		assert.deepEqual(calls, []);
	} finally {
		for (const token of tokens) settlePendingSubscribe(ud, 'parked', token);
		__setHooks({});
	}
});

test('forbidden batch entries remain enrolled while the allowed hook is parked', async () => {
	const { beginPendingSubscribe, settlePendingSubscribe, pendingSubscribeTotal } = await import('../../src/runtime/utils/ws-symbols.js');
	const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
	platform.authorizeWireSubscribe('strict');
	__setHooks({ subscribe: () => null });
	const { raw, ud } = connect();
	await platform.subscribe(wsFacade(raw), 'held');
	const entered = deferred();
	const gate = deferred();
	const observations = [];
	__setHooks({ subscribeBatch: async (_ws, topics) => {
		observations.push({ topics: [...topics], pending: pendingSubscribeTotal(ud) });
		entered.resolve();
		await gate.promise;
		return {};
	} });
	const tokens = Array.from({ length: 4094 }, () => beginPendingSubscribe(ud, 'parked', false));
	const pending = websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe-batch', topics: ['ungranted', 'held'], ref: 94 }));
	try {
		await entered.promise;
		assert.deepEqual(observations, [{ topics: ['held'], pending: 4096 }]);
		assert.equal(pendingSubscribeTotal(ud), 4096);
		gate.resolve();
		await pending;
		assert.equal(pendingSubscribeTotal(ud), 4094);
		const replies = raw.sent.map(frame => JSON.parse(frame)).filter(frame => frame.ref === 94);
		assert.deepEqual(replies.map(({ topic, type, reason }) => ({ topic, type, reason })), [
			{ topic: 'ungranted', type: 'subscribe-denied', reason: 'FORBIDDEN' },
			{ topic: 'held', type: 'subscribed', reason: undefined }
		]);
	} finally {
		gate.resolve();
		await pending;
		for (const token of tokens) settlePendingSubscribe(ud, 'parked', token);
		__setHooks({});
		websocketHandlers.close(raw, 1000, '');
	}
});

test('the batch landed cap is checked after the admitted prefix reaches its hook', async () => {
	const { beginPendingSubscribe, settlePendingSubscribe, pendingSubscribeTotal, trackedSubscribe } = await import('../../src/runtime/utils/ws-symbols.js');
	const { subscribeAuth } = await import('../../src/runtime/handler/ws-state.js');
	const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
	const previous = { ...subscribeAuth };
	subscribeAuth.enabled = false;
	subscribeAuth.strict = false;
	const calls = [];
	__setHooks({ subscribeBatch: (_ws, topics) => { calls.push([...topics]); return {}; } });
	const { raw, ud } = connect();
	const ws = wsFacade(raw);
	for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) trackedSubscribe(ws, `full:${i}`);
	const tokens = Array.from({ length: 4095 }, () => beginPendingSubscribe(ud, 'parked', false));
	try {
		await websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe-batch', topics: ['new', 'full:0'], ref: 95 }));
		assert.deepEqual(calls, [['new']], 'the first valid position owns the slot even at the landed cap');
		const replies = raw.sent.map(frame => JSON.parse(frame)).filter(frame => frame.ref === 95);
		assert.deepEqual(replies.map(({ topic, reason }) => ({ topic, reason })), [
			{ topic: 'full:0', reason: 'RATE_LIMITED' },
			{ topic: 'new', reason: 'RATE_LIMITED' }
		]);
		assert.equal(ud[WS_SUBSCRIPTIONS].has('new'), false);
		assert.equal(pendingSubscribeTotal(ud), 4095);
	} finally {
		for (const token of tokens) settlePendingSubscribe(ud, 'parked', token);
		__setHooks({});
		websocketHandlers.close(raw, 1000, '');
		Object.assign(subscribeAuth, previous);
	}
});
