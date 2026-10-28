import { test } from 'node:test';
import assert from 'node:assert/strict';

// THE ARMED GATE, on the two lanes that reach a topic's contents without going
// through a wire `subscribe`: the client-named `resume` frame, which yields a
// topic's message HISTORY, and the hook-presence rule that decides whether the
// gate is standing aside at all.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	authorizeWireSubscribe: true
};

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { WS_SUBSCRIPTIONS } = await import('../../src/runtime/handler/ws-state.js');
const { addLogicalSubscription, beginPendingSubscribe, settlePendingSubscribe } = await import(
	'../../src/runtime/utils/ws-symbols.js'
);
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

/** The minimum of Bun's ServerWebSocket these lanes touch. */
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

/** Open a connection, capturing the facade through a one-shot open hook. */
function connectCapturing(hooks) {
	let ws = null;
	__setHooks({ ...hooks, open: (socket) => { ws = socket; } });
	const raw = rawSocket();
	websocketHandlers.open(raw);
	return { raw, ud: raw.data, ws };
}

test('a resume frame serves history only for topics the server granted', async () => {
	/** @type {string[][]} */
	const seen = [];
	const { raw, ws } = connectCapturing({
		resume: (_socket, ctx) => { seen.push(Object.keys(ctx.lastSeenSeqs)); }
	});
	// The server grants one topic. `platform.subscribe` is the trusted
	// grant-establishing path and is never gated by the arming.
	assert.equal(await platform.subscribe(ws, 'room:granted'), null);
	await websocketHandlers.message(
		raw,
		'{"type":"resume","sessionId":"11111111-1111-4111-8111-111111111111",' +
		'"lastSeenSeqs":{"room:granted":4,"room:private":4}}'
	);
	assert.deepEqual(
		seen,
		[['room:granted']],
		'the resume hook was handed a topic this connection was never granted'
	);
	__setHooks({});
});

test('the resume frame filters its EPOCH map by the same grant', async () => {
	// Both maps ride into one hook and are read together - an app checking for
	// an epoch mismatch iterates this one - so a topic dropped from the seqs and
	// left in the epochs is the refused topic arriving by the other hand. A frame
	// naming an ungranted topic ONLY in the epoch map is the whole attack.
	/** @type {(string[] | null)[]} */
	const seen = [];
	const { raw, ws } = connectCapturing({
		resume: (_socket, ctx) => {
			seen.push(ctx.lastSeenEpochs ? Object.keys(ctx.lastSeenEpochs) : null);
		}
	});
	assert.equal(await platform.subscribe(ws, 'room:granted'), null);
	await websocketHandlers.message(
		raw,
		'{"type":"resume","sessionId":"11111111-1111-4111-8111-111111111111",' +
		'"lastSeenSeqs":{"room:granted":4},' +
		'"lastSeenEpochs":{"room:granted":1,"room:private":1,"admin:secrets":1}}'
	);
	assert.deepEqual(
		seen,
		[['room:granted']],
		'the epoch map handed the hook topics this connection was never granted'
	);
	__setHooks({});
});

test('a recover on a topic the connection already holds still gap-fills', async () => {
	// Live membership carries no HISTORY. Acking a held topic without running
	// the gap-fill tells a client replaying from an offset that it caught up,
	// with the tail silently missing - and under the armed gate, where held is
	// exactly what granted means, that would be every recover the wire can ask
	// for.
	/** @type {any[]} */
	const filled = [];
	const { raw, ws } = connectCapturing({
		resume: (_socket, ctx) => { filled.push(ctx.lastSeenSeqs); }
	});
	assert.equal(await platform.subscribe(ws, 'room:held'), null);
	await websocketHandlers.message(
		raw,
		'{"type":"subscribe","topic":"room:held","ref":11,"recover":{"offset":7}}'
	);
	assert.deepEqual(
		filled,
		[{ 'room:held': 7 }],
		'the gap-fill was skipped for a topic the connection holds'
	);
	assert.ok(
		raw.sent.some((f) => f.includes('"type":"subscribed"') && f.includes('"topic":"room:held"')),
		'the client was not acked after its gap-fill'
	);
	__setHooks({});
});

test('a side-effect-only plugin hook does not stand the gate aside', async () => {
	// The family marks a plugin hook that observes rather than decides, through
	// the global registry key the lead publishes. A roster join that returns no
	// opinion is not the app taking over the topic decision, so the gate stays
	// armed - otherwise arming it and following a plugin's README together give
	// no enforcement at all.
	const sideEffectOnly = Symbol.for('adapter-uws.hook.side-effect-only');
	const joined = [];
	/** @param {any} _ws @param {string} topic */
	const pluginSubscribe = (_ws, topic) => { joined.push(topic); return null; };
	pluginSubscribe[sideEffectOnly] = true;

	const { raw, ud } = connectCapturing({ subscribe: pluginSubscribe });
	await websocketHandlers.message(
		raw,
		'{"type":"subscribe","topic":"room:ungranted","ref":7}'
	);
	assert.equal(
		ud[WS_SUBSCRIPTIONS].has('room:ungranted'),
		false,
		'an ungranted topic was installed because a plugin hook disarmed the gate'
	);
	assert.ok(
		raw.sent.some((f) => typeof f === 'string' && f.includes('"reason":"FORBIDDEN"')),
		'and the client was not told FORBIDDEN'
	);
	__setHooks({});
});

test('armed but not strict, an app hook still decides the observer lane', async () => {
	// The grant is a second authority only under `'strict'`. An app that ships
	// its own gate is documented as deciding every topic, so the snapshot lanes
	// must keep working for exactly the apps that took authorization over -
	// hard-denying an ungranted topic here would break presence and cursors for
	// them.
	const { ws } = connectCapturing({ subscribe: () => null });
	assert.equal(
		await platform.checkSubscribe(ws, 'room:never-granted', { requireGrant: true }),
		null,
		'the observer gate denied a topic the app hook allowed, with strict not armed'
	);
	__setHooks({});
});

test('an app hook that is not marked still decides, as it always has', async () => {
	const { raw, ud } = connectCapturing({ subscribe: () => null });
	await websocketHandlers.message(
		raw,
		'{"type":"subscribe","topic":"room:app-allowed","ref":8}'
	);
	assert.equal(
		ud[WS_SUBSCRIPTIONS].has('room:app-allowed'),
		true,
		'an app that ships its own gate keeps deciding every topic'
	);
	__setHooks({});
});

// A membership installed inside an attempt's await window (a plugin join from
// its hook), with that attempt still in flight, is not a grant yet: the
// attempt's landing, or a sibling's refusal, may still unwind it. Neither lane
// that reads the grant on its own may count it.

/** Hold `topic` the way such an install leaves it: a member, and an attempt in flight. */
function unconfirmedMembership(/** @type {any} */ ud, /** @type {string} */ topic) {
	addLogicalSubscription(ud[WS_SUBSCRIPTIONS], topic);
	return beginPendingSubscribe(ud, topic);
}

test('a resume frame serves no history for a membership still waiting to be judged', async () => {
	/** @type {string[][]} */
	const seen = [];
	const { raw, ud, ws } = connectCapturing({
		resume: (_socket, ctx) => { seen.push(Object.keys(ctx.lastSeenSeqs).sort()); }
	});
	assert.equal(await platform.subscribe(ws, 'room:granted'), null);
	const token = unconfirmedMembership(ud, 'room:waiting');
	const frame =
		'{"type":"resume","sessionId":"11111111-1111-4111-8111-111111111111",' +
		'"lastSeenSeqs":{"room:granted":4,"room:waiting":4}}';
	await websocketHandlers.message(raw, frame);
	// Once the attempt lands and records its authority, the grant stands.
	settlePendingSubscribe(ud, 'room:waiting', token, true);
	await websocketHandlers.message(raw, frame);
	assert.deepEqual(seen, [['room:granted'], ['room:granted', 'room:waiting']]);
	__setHooks({});
});

test('the observer lane does not read a membership still waiting to be judged as a grant', async () => {
	const { ud, ws } = connectCapturing({});
	const token = unconfirmedMembership(ud, 'room:waiting');
	assert.equal(await platform.checkSubscribe(ws, 'room:waiting', { requireGrant: true }), 'FORBIDDEN');
	settlePendingSubscribe(ud, 'room:waiting', token, true);
	assert.equal(await platform.checkSubscribe(ws, 'room:waiting', { requireGrant: true }), null);
	__setHooks({});
});
