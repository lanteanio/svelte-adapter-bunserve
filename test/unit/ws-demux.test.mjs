import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The demux in handler/ws.js is the part of the realtime tier a client talks to
// directly, and until this file existed nothing imported it: it reaches the
// app's hooks through the build-injected WS_HANDLER specifier, so it could not
// be loaded without a build. Every defect in it was therefore found by reading
// rather than by a failing test. The resolver hook that makes the gate testable
// makes this testable too.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { WS_PLATFORM, WS_SUBSCRIPTIONS, pendingReleaseTopics } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

/**
 * A stand-in for Bun's raw socket. `websocketHandlers` wraps it in the facade,
 * which reads `data` for userData, so the slots the handlers set land here.
 */
function rawSocket() {
	const sent = [];
	const subscribed = new Set();
	return {
		data: {},
		sent,
		subscribed,
		ended: null,
		readyState: 1,
		send(payload) {
			sent.push(payload);
			return payload.length;
		},
		subscribe(topic) {
			subscribed.add(topic);
			return true;
		},
		unsubscribe(topic) {
			return subscribed.delete(topic);
		},
		isSubscribed: (topic) => subscribed.has(topic),
		end(code, reason) {
			this.ended = { code, reason };
		},
		close() {
			this.ended = this.ended ?? { code: 1000, reason: '' };
		},
		getBufferedAmount: () => 0,
		cork: (fn) => fn()
	};
}

/** Open a connection through the real `open` handler so its slots are real. */
function openSocket(hooks) {
	__setHooks(hooks);
	const raw = rawSocket();
	websocketHandlers.open(raw);
	return raw;
}

/** Drive one client text frame through the real demux. */
async function send(raw, frame) {
	await websocketHandlers.message(raw, JSON.stringify(frame));
}

/** Let queued microtasks and the hook queue settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The topics the app's close hook was told to tear down. */
function closeAndCapture(raw) {
	let seen = null;
	const previous = closeCapture.hooks;
	__setHooks({ ...previous, close: (ws, ctx) => { seen = [...ctx.subscriptions].sort(); } });
	websocketHandlers.close(raw, 1000, '');
	return seen;
}
const closeCapture = { hooks: {} };

/** Install hooks and remember them so the close capture can keep them. */
function withHooks(hooks) {
	closeCapture.hooks = hooks;
	__setHooks(hooks);
}

test('a release whose hook REJECTS is still owed, and the close hook is told', async () => {
	// The distinction the dispatch exists to make. A hook that rejects ran the
	// app's code but released nothing - an awaited roster delete against a
	// backend that is down - so discharging its debt means the close hook is
	// not told either and the entry leaks with no client involved. Settling on
	// rejection as well as resolution is exactly the behaviour that reverting
	// to a `finally` (or to callHook, which turns a rejection into a
	// resolution) would restore, and this is what fails when it does.
	const hooks = {
		subscribe: () => null,
		unsubscribe: () => Promise.reject(new Error('redis is down')),
		close: () => {}
	};
	withHooks(hooks);
	const raw = openSocket(hooks);

	await send(raw, { type: 'subscribe', topic: 'room:1' });
	await settle();
	assert.deepEqual([...raw.data[WS_SUBSCRIPTIONS]], ['room:1']);

	await send(raw, { type: 'unsubscribe', topic: 'room:1' });
	await settle();
	// The release itself happened, so the topic is out of the live set...
	assert.deepEqual([...raw.data[WS_SUBSCRIPTIONS]], []);
	// ...but the teardown was never performed, so it is still owed.
	assert.deepEqual([...pendingReleaseTopics(raw.data)], ['room:1']);

	assert.deepEqual(closeAndCapture(raw), ['room:1']);
});

test('a release whose hook throws synchronously is still owed', async () => {
	// Same requirement on the other throw path: a hook that throws before its
	// first await released nothing either.
	const hooks = {
		subscribe: () => null,
		unsubscribe: () => { throw new Error('the hook threw'); },
		close: () => {}
	};
	withHooks(hooks);
	const raw = openSocket(hooks);

	await send(raw, { type: 'subscribe', topic: 'room:1' });
	await settle();
	await send(raw, { type: 'unsubscribe', topic: 'room:1' });
	await settle();

	assert.deepEqual([...pendingReleaseTopics(raw.data)], ['room:1']);
	assert.deepEqual(closeAndCapture(raw), ['room:1']);
});

test('a release whose hook RESOLVES is discharged and not repeated at close', async () => {
	// The other half: teardown the app already performed must not be handed to
	// the close hook, or every ordinary release would be torn down twice.
	const hooks = {
		subscribe: () => null,
		unsubscribe: () => Promise.resolve(),
		close: () => {}
	};
	withHooks(hooks);
	const raw = openSocket(hooks);

	await send(raw, { type: 'subscribe', topic: 'room:1' });
	await settle();
	await send(raw, { type: 'unsubscribe', topic: 'room:1' });
	await settle();

	assert.deepEqual([...pendingReleaseTopics(raw.data)], []);
	assert.deepEqual(closeAndCapture(raw), []);
});

test('a speculative release is never recorded', async () => {
	// A topic this connection never held costs a client nothing to invent, so
	// recording those is how the record becomes a memory amplifier: a client
	// that never subscribes to anything could fill it to the ceiling and push
	// every genuine release out.
	const hooks = {
		subscribe: () => null,
		unsubscribe: () => Promise.reject(new Error('would be owed if recorded')),
		close: () => {}
	};
	withHooks(hooks);
	const raw = openSocket(hooks);

	for (let i = 0; i < 50; i++) {
		await send(raw, { type: 'unsubscribe', topic: `never-held:${i}` });
	}
	await settle();

	assert.deepEqual([...pendingReleaseTopics(raw.data)], []);
	assert.deepEqual(closeAndCapture(raw), []);
});

test('an app with no unsubscribe hook cannot be flooded off its own releases', async () => {
	// With no hook exported there is no app teardown to run, so a release must
	// not occupy the deferral queue. Enqueuing a no-op per release let a client
	// pipeline past the backlog and be closed 4429 over hooks that do not
	// exist.
	const hooks = { subscribe: () => null, close: () => {} };
	withHooks(hooks);
	const raw = openSocket(hooks);

	// The topics have to be genuinely HELD, or the releases take the
	// speculative lane, which yields with `refused` and never overflows.
	const TOPICS = 1200;
	for (let i = 0; i < TOPICS; i++) {
		await send(raw, { type: 'subscribe', topic: `room:${i}` });
	}
	await settle();
	assert.equal(raw.data[WS_SUBSCRIPTIONS].size, TOPICS, 'the fixture must actually hold them');

	// NOT awaited between frames: Bun does not await the message handler, so a
	// client pipelines the whole burst into one read and every frame runs to
	// its first suspension before any of them resume. Awaiting each frame here
	// drains the microtask queue in between, the backlog never builds, and the
	// bound is never reached - which is the shape that hid this.
	const inflight = [];
	for (let i = 0; i < TOPICS; i++) {
		inflight.push(websocketHandlers.message(raw, JSON.stringify({
			type: 'unsubscribe',
			topic: `room:${i}`
		})));
	}
	await Promise.all(inflight);
	await settle();

	assert.equal(raw.ended, null, 'no hook to defer means nothing to overflow');
	assert.deepEqual([...pendingReleaseTopics(raw.data)], []);
});

test('the demux answers a subscribe-batch per entry', async () => {
	// The frame shape the family client keys its denial store and per-topic
	// epochs off. A summary frame it does not recognise loses every denial, and
	// that regression has reached review twice; the unit suite could not see it
	// because nothing imported this module.
	const hooks = {
		subscribe: (ws, topic) => (topic === 'denied:1' ? 'FORBIDDEN' : null),
		close: () => {}
	};
	withHooks(hooks);
	const raw = openSocket(hooks);
	raw.sent.length = 0;

	await send(raw, { type: 'subscribe-batch', topics: ['room:1', 'denied:1', 'room:2'], ref: 7 });
	await settle();

	const frames = raw.sent.map((f) => JSON.parse(f));
	const answers = frames.filter((f) => f.type === 'subscribed' || f.type === 'subscribe-denied');
	assert.equal(answers.length, 3, JSON.stringify(frames));
	// Every answer names its own topic, which is what the client correlates on.
	assert.deepEqual(
		answers.map((f) => f.topic).sort(),
		['denied:1', 'room:1', 'room:2']
	);
	const denial = answers.find((f) => f.topic === 'denied:1');
	assert.equal(denial.type, 'subscribe-denied');
	assert.equal(denial.reason, 'FORBIDDEN');
});
