import { test } from 'node:test';
import assert from 'node:assert/strict';

// The demux in handler/ws.js is the part of the realtime tier a client talks to
// directly, and until this file existed nothing imported it: it reaches the
// app's hooks through the build-resolved #ws-handler specifier, so it could not
// be loaded without a build. Every defect in it was therefore found by reading
// rather than by a failing test. The resolver hook that makes the gate testable
// makes this testable too.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';


const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { WS_SUBSCRIPTIONS, WS_LEASE, wsCounters } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');
const { MAX_QUEUED_REQUESTS } = await import('../../src/runtime/utils/lease.js');

/**
 * A stand-in for Bun's raw socket. `websocketHandlers` wraps it in the facade,
 * which reads `data` for userData, so the slots the handlers set land here.
 */
function rawSocket() {
	const sent = [];
	const subscribed = new Set();
	return {
		data: upgradeData(),
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
		// The facade's `end(code, reason)` calls raw.close(code, reason) and its
		// `close()` calls raw.terminate() - it never calls raw.end. Modelling
		// this wrong is silent: `close()` discarding its arguments still looks
		// like a working socket, and the first test to assert a close CODE (the
		// 4429 control-flood cut, say) would pin 1000 and pass.
		close(code, reason) {
			this.ended = this.ended ?? { code, reason };
		},
		terminate() {
			this.ended = this.ended ?? { code: 1006, reason: 'terminated' };
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

test('request-n reports a clamped backlog without changing grant eligibility', async () => {
	const raw = openSocket({});
	const previousPeak = wsCounters.leaseSaturationPeak;
	try {
		await send(raw, { type: 'request-n', queued: MAX_QUEUED_REQUESTS });
		assert.equal(raw.data[WS_LEASE], undefined, 'no lease before capability negotiation');
		await send(raw, { type: 'hello', caps: ['lease'] });
		const grant = JSON.parse(raw.sent.at(-1));
		for (const [queued, expected] of [
			[MAX_QUEUED_REQUESTS / 2, 0.5], [MAX_QUEUED_REQUESTS * 100, 1],
			[undefined, 0], [null, 0], [-1, 0], [1.5, 0], ['256', 0], [true, 0], [{}, 0]
		]) {
			wsCounters.leaseSaturationPeak = 0;
			const before = raw.sent.length;
			await send(raw, { type: 'request-n', n: 999999, queued });
			assert.equal(raw.data[WS_LEASE].saturation, expected);
			assert.equal(wsCounters.leaseSaturationPeak, expected);
			assert.equal(raw.sent.length, before + 1, 'every negotiated request receives a grant');
			assert.deepEqual(JSON.parse(raw.sent.at(-1)), grant, 'backlog and n cannot enlarge or deny the grant');
		}
		wsCounters.leaseSaturationPeak = 1;
		await send(raw, { type: 'request-n', queued: 0 });
		assert.equal(wsCounters.leaseSaturationPeak, 1, 'an empty report does not erase another peak');
	} finally {
		websocketHandlers.close(raw, 1000, '');
		wsCounters.leaseSaturationPeak = previousPeak;
	}
});

/** Install hooks and remember them so the close capture can keep them. */
function withHooks(hooks) {
	closeCapture.hooks = hooks;
	__setHooks(hooks);
}

test('a rejecting release hook leaves membership removed at close', async () => {
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
	assert.deepEqual([...raw.subscribed], ['room:1']);

	await send(raw, { type: 'unsubscribe', topic: 'room:1' });
	await settle();
	assert.deepEqual([...raw.subscribed], [], 'the release reaches the socket, not just the set');
	assert.deepEqual([...raw.data[WS_SUBSCRIPTIONS]], []);

	assert.deepEqual(closeAndCapture(raw), []);
});

test('a throwing release hook leaves membership removed at close', async () => {
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

	assert.deepEqual(closeAndCapture(raw), []);
});

test('a release whose hook RESOLVES is discharged and not repeated at close', async () => {
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

	assert.deepEqual(closeAndCapture(raw), []);
});

test('a speculative release is never recorded', async () => {
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

	assert.deepEqual(closeAndCapture(raw), []);
});

test('an app with no unsubscribe hook cannot be flooded off its own releases', async () => {
	const hooks = { subscribe: () => null, close: () => {} };
	withHooks(hooks);
	const raw = openSocket(hooks);

	const TOPICS = 1200;
	for (let i = 0; i < TOPICS; i++) {
		await send(raw, { type: 'subscribe', topic: `room:${i}` });
	}
	await settle();
	assert.equal(raw.data[WS_SUBSCRIPTIONS].size, TOPICS, 'the fixture must actually hold them');

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

	// Held BEFORE the batch, so the batch's already-held short-circuit is one of
	// the branches under test rather than an untaken one.
	await send(raw, { type: 'subscribe', topic: 'held:1' });
	await settle();
	raw.sent.length = 0;

	// Four entries covering four different answer branches: a plain allow, an
	// app denial, a topic that fails wire validation, and one already held.
	// Each has its own frame-building site in the batch path, and each has to
	// name its topic - a summary frame or a null topic in ANY of them is the
	// defect that has reached review twice.
	await send(raw, {
		type: 'subscribe-batch',
		topics: ['room:1', 'denied:1', '__nope', 'held:1'],
		ref: 7
	});
	await settle();

	const frames = raw.sent.map((f) => JSON.parse(f));
	const answers = frames.filter((f) => f.type === 'subscribed' || f.type === 'subscribe-denied');
	assert.equal(answers.length, 4, JSON.stringify(frames));
	// Every answer names its own topic, which is what the client correlates on.
	assert.deepEqual(
		answers.map((f) => f.topic).sort(),
		['__nope', 'denied:1', 'held:1', 'room:1']
	);
	// And none of them carries a non-string topic, which is the exact shape the
	// family client discards silently.
	assert.deepEqual(answers.filter((f) => typeof f.topic !== 'string'), []);

	const denial = answers.find((f) => f.topic === 'denied:1');
	assert.equal(denial.type, 'subscribe-denied');
	assert.equal(denial.reason, 'FORBIDDEN');

	const invalid = answers.find((f) => f.topic === '__nope');
	assert.equal(invalid.type, 'subscribe-denied');
	assert.equal(invalid.reason, 'INVALID_TOPIC');

	const held = answers.find((f) => f.topic === 'held:1');
	assert.equal(held.type, 'subscribed', JSON.stringify(held));
});


test('oversized subscribe batch applies its prefix and denies only the overflow', async () => {
 const raw = openSocket({ subscribe: () => null });
 const topics = Array.from({ length: 257 }, (_, i) => `b:${i}`);
 raw.sent.length = 0;
 await send(raw, { type: 'subscribe-batch', topics, ref: 7 });
 assert.equal(raw.subscribed.size, 256);
 assert.equal(raw.subscribed.has('b:256'), false);
 const frames = raw.sent.map(JSON.parse);
 assert.equal(frames.filter(f => f.type === 'subscribed').length, 256);
 assert.deepEqual(frames.find(f => f.reason === 'BATCH_OVERFLOW'), { type: 'subscribe-denied', topic: 'b:256', ref: 7, reason: 'BATCH_OVERFLOW' });
 raw.readyState = 3;
 websocketHandlers.close(raw, 1000, '');
});


test('held wire subscriptions consult changed application verdicts on both spellings', async () => {
 let denial = null;
 const seen = [];
 const raw = openSocket({ subscribeBatch: (_ws, topics) => {
  seen.push([...topics]);
  return Object.fromEntries(topics.map(topic => [topic, denial]));
 } });
 await send(raw, { type: 'subscribe', topic: 'held', ref: 1 });
 denial = 'FORBIDDEN';
 await send(raw, { type: 'subscribe', topic: 'held', ref: 2 });
 await send(raw, { type: 'subscribe-batch', topics: ['held'], ref: 3 });
 const denied = raw.sent.map(JSON.parse).filter(f => f.type === 'subscribe-denied');
 assert.deepEqual(denied.map(f => [f.ref, f.reason]), [[2, 'FORBIDDEN'], [3, 'FORBIDDEN']]);
 assert.deepEqual(seen, [['held'], ['held'], ['held']]);
 assert.equal(raw.subscribed.has('held'), true);
 raw.readyState = 3;
 websocketHandlers.close(raw, 1000, '');
});

test('batch fallback hooks start together and land in request order', async () => {
	const release = new Map();
	const entered = [];
	const raw = openSocket({ subscribe: (_ws, topic) => {
		entered.push(topic);
		return new Promise((resolve) => release.set(topic, resolve));
	} });
	try {
		const pending = send(raw, { type: 'subscribe-batch', topics: ['a', 'b', 'c'], ref: 1 });
		assert.deepEqual(entered, ['a', 'b', 'c']);
		release.get('c')(null);
		release.get('b')('FORBIDDEN');
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(raw.subscribed.size, 0);
		release.get('a')(null);
		await pending;
		assert.deepEqual([...raw.subscribed], ['a', 'c']);
		const answers = raw.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.ref === 1);
		assert.deepEqual(answers.map((frame) => [frame.topic, frame.type]), [['a', 'subscribed'], ['b', 'subscribe-denied'], ['c', 'subscribed']]);
	} finally { websocketHandlers.close(raw, 1000, ''); }
});

test('batch fallback preserves per-attempt verdicts for duplicate topics', async () => {
	let calls = 0;
	const raw = openSocket({ subscribe: () => ++calls === 1 ? 'FIRST_DENIED' : null });
	try {
		await send(raw, { type: 'subscribe-batch', topics: ['room', 'room'], ref: 4 });
		assert.equal(calls, 2);
		const answers = raw.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.ref === 4);
		assert.deepEqual(answers.map((frame) => frame.reason ?? frame.type), ['FIRST_DENIED', 'subscribed']);
	} finally { websocketHandlers.close(raw, 1000, ''); }
});


test('transport metrics finish after async message failures and report one lifecycle', async () => {
 const previous = wsCounters.transportMetricHooks;
 const events = [];
 let release;
 const parked = new Promise(resolve => { release = resolve; });
 wsCounters.transportMetricHooks = {
  connectionOpen() { events.push('open'); },
  connectionClose(ws, code) { events.push(['close', code]); },
  messageStart(ws, message) { events.push(['start', message]); return failed => events.push(['done', failed]); }
 };
 const raw = openSocket({ message: async () => { await parked; throw new Error('contained'); } });
 const original = console.error; console.error = () => {};
 try {
  const pending = websocketHandlers.message(raw, 'application');
  await Promise.resolve();
  assert.deepEqual(events, ['open', ['start', 'application']]);
  release(); await pending;
  assert.deepEqual(events.at(-1), ['done', true]);
  assert.equal(raw.ended.code, 1011);
  websocketHandlers.close(raw, 1011, '');
  assert.deepEqual(events.at(-1), ['close', 1011]);
 } finally { console.error = original; wsCounters.transportMetricHooks = previous; __setHooks({}); }
});
