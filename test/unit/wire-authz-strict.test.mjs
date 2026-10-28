import { test } from 'node:test';
import assert from 'node:assert/strict';

// THE `'strict'` POSTURE ON THE OBSERVER LANE. Strict makes the server grant a
// second authority no app hook can speak for, so `platform.checkSubscribe`
// with `requireGrant` has to hold the grant across its hook await: the hook is
// app code that can park for a database round trip, and a revocation landing
// in that window means the answer must be a refusal. Reading the grant only on
// the way in answers for a connection's rights as they were, not as they are.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	authorizeWireSubscribe: 'strict'
};

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

/** The minimum of Bun's ServerWebSocket these lanes touch. */
function rawSocket() {
	const joined = new Set();
	const raw = {
		joined,
		data: upgradeData(),
		readyState: 1,
		send(payload) { return payload.length; },
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

test('a revoke while the observer gate is parked refuses the snapshot', async () => {
	let park = null;
	let ws = null;
	__setHooks({
		open: (socket) => { ws = socket; },
		subscribe: async () => {
			if (park) await park.promise;
			return null;
		}
	});
	const raw = rawSocket();
	websocketHandlers.open(raw);

	// The connection legitimately holds the topic when the snapshot is asked for.
	assert.equal(await platform.subscribe(ws, 'room:1'), null);

	park = deferred();
	const answer = platform.checkSubscribe(ws, 'room:1', { requireGrant: true });
	// The grant is revoked while the app's hook is still parked.
	platform.unsubscribe(ws, 'room:1');
	park.resolve();
	assert.equal(
		await answer,
		'FORBIDDEN',
		'a snapshot was authorized on a grant that had already been revoked'
	);
	__setHooks({});
});

test('an unrevoked grant still passes, so the re-check refuses nothing legitimate', async () => {
	let ws = null;
	__setHooks({
		open: (socket) => { ws = socket; },
		subscribe: async () => null
	});
	const raw = rawSocket();
	websocketHandlers.open(raw);
	assert.equal(await platform.subscribe(ws, 'room:2'), null);
	assert.equal(await platform.checkSubscribe(ws, 'room:2', { requireGrant: true }), null);
	__setHooks({});
});
