import { test } from 'node:test';
import assert from 'node:assert/strict';

// The ONE configuration where `__`-prefixed topics clear the system-topic
// guard, and therefore the only place the resume lane's `__proto__` refusal is
// reachable. Every other handler test runs with `WS_OPTIONS = null`, where
// `isSystemTopic` already drops `__proto__` for an unrelated reason and the
// dedicated guard cannot be observed. `config.js` freezes these at module eval,
// and `node --test` gives each file its own process, so this needs its own file.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = { allowSystemTopicSubscribe: true };
globalThis.WS_PATH = '/ws';


const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

function rawSocket() {
	const sent = [];
	const subscribed = new Set();
	return {
		data: {},
		sent,
		subscribed,
		readyState: 1,
		send(payload) {
			sent.push(payload);
			return typeof payload === 'string' ? payload.length : payload.byteLength;
		},
		subscribe(topic) {
			subscribed.add(topic);
			return true;
		},
		unsubscribe: (topic) => subscribed.delete(topic),
		isSubscribed: (topic) => subscribed.has(topic),
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (fn) => fn()
	};
}

function openSocket(hooks) {
	__setHooks(hooks);
	const raw = rawSocket();
	websocketHandlers.open(raw);
	return raw;
}

const send = (raw, frame) => websocketHandlers.message(raw, JSON.stringify(frame));

test('a resume never hands the app __proto__, even where system topics are allowed', async () => {
	// Not about the adapter's own maps - those are null-prototype either way.
	// The hazard is the APP's: a history lookup written as a plain-object
	// allowlist (`if (!ALLOWLIST[topic]) return`) reads `__proto__` truthy off
	// `Object.prototype` and serves history for a topic it never granted. The
	// subscribe path refuses it for exactly that reason, so this lane must too.
	//
	// `__proto__` is a COMPUTED key here on purpose: written as a plain literal
	// it sets the prototype instead of creating an own property, and the frame
	// would carry nothing.
	let ctx = null;
	const raw = openSocket({ resume: (ws, c) => { ctx = c; } });
	await send(raw, {
		type: 'resume',
		sessionId: 's',
		lastSeenSeqs: { room: 1, __presence: 2, ['__proto__']: 3 },
		lastSeenEpochs: { __presence: 7, ['__proto__']: 9 }
	});

	assert.ok(ctx, 'hook ran');
	assert.deepEqual(
		Object.keys(ctx.lastSeenSeqs).sort(),
		['__presence', 'room'],
		'this config allows a system topic through; __proto__ is refused regardless'
	);
	assert.deepEqual(Object.keys(ctx.lastSeenEpochs), ['__presence'], 'and not via the epoch map either');
	assert.equal(Object.getPrototypeOf(ctx.lastSeenSeqs), null, 'the map the hook gets has no prototype');
	websocketHandlers.close(raw, 1000, '');
});

test('the system-topic option really is on, so the test above proves the guard', () => {
	// Guards the guard: if this config stopped taking effect, the assertion
	// above would pass because `isSystemTopic` dropped `__proto__` for its own
	// reason, and the dedicated refusal would be untested while looking covered.
	let ctx = null;
	const raw = openSocket({ resume: (ws, c) => { ctx = c; } });
	send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: { __presence: 1 } });
	assert.ok(ctx && Object.keys(ctx.lastSeenSeqs).includes('__presence'));
	websocketHandlers.close(raw, 1000, '');
});
