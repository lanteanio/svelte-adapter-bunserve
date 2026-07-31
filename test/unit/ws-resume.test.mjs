import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The resume barrier and its two entry points. The barrier's job is exactly
// one thing: a publish that lands while an async resume hook is reading the
// backend must reach the resuming client, in order, before its subscribed
// ack - not vanish into the window between the backend read and the live
// membership.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const {
	maxSeenSeq,
	resumeBuffers,
	setServer,
	topicSeqs
} = await import('../../src/runtime/handler/ws-state.js');
const {
	beginResumeCapture,
	coveredSeqFor,
	discardResumeCapture,
	flushResumeTopic
} = await import('../../src/runtime/handler/resume-buffer.js');
const { captureResumeFrame, MAX_RESUME_BUFFERED_FRAMES } = await import(
	'../../src/runtime/handler/ws-state.js'
);
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
		unsubscribe(topic) {
			return subscribed.delete(topic);
		},
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

async function send(raw, frame) {
	await websocketHandlers.message(raw, JSON.stringify(frame));
}

function cleanup(raw) {
	websocketHandlers.close(raw, 1000, '');
	topicSeqs.clear();
	maxSeenSeq.clear();
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('the barrier holds frames across the window and flushes above the floor', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return p.length; } };
	maxSeenSeq.set('room', 5);
	const cap = beginResumeCapture(['room'], fakeWs);
	assert.equal(resumeBuffers.size, 1);
	// Authoritative (explicit-seq) frames: they share the floor's seq space,
	// so the floor dedups them. A counter frame would never be deduped.
	captureResumeFrame('room', 5, 'ENV5', false, null, true);
	captureResumeFrame('room', 6, 'ENV6', false, null, true);
	captureResumeFrame('room', 7, 'ENV7', false, null, true);
	captureResumeFrame('other', 1, 'OTHER', false, null, true);
	// No coveredSeq reported: the pre-window max (5) is the floor.
	flushResumeTopic(cap, 'room', undefined);
	assert.deepEqual(fakeWs.sent, ['ENV6', 'ENV7'], 'only frames past the floor, in order');
	assert.equal(resumeBuffers.size, 0, 'the buffer closed');
	maxSeenSeq.clear();
});

test('a reported watermark overrides the fallback floor', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return p.length; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	captureResumeFrame('room', 1, 'ENV1', false, null, true);
	captureResumeFrame('room', 2, 'ENV2', false, null, true);
	flushResumeTopic(cap, 'room', coveredSeqFor({ room: 1 }, 'room'));
	assert.deepEqual(fakeWs.sent, ['ENV2']);
});

test('seq-less frames always flush; discard delivers nothing', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return p.length; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	captureResumeFrame('room', null, 'PLAIN', false);
	flushResumeTopic(cap, 'room', 999);
	assert.deepEqual(fakeWs.sent, ['PLAIN'], 'a seq-less frame cannot be deduped, so it flushes');

	const fakeWs2 = { sent: [], send(p) { this.sent.push(p); return p.length; } };
	const cap2 = beginResumeCapture(['room'], fakeWs2);
	captureResumeFrame('room', 1, 'ENV', false);
	discardResumeCapture(cap2);
	assert.deepEqual(fakeWs2.sent, []);
	assert.equal(resumeBuffers.size, 0);
});

test('an overflowed window signals truncation FIRST, then best-effort frames', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return p.length; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	for (let i = 1; i <= MAX_RESUME_BUFFERED_FRAMES + 10; i++) {
		captureResumeFrame('room', i, 'E' + i, false, null, true);
	}
	flushResumeTopic(cap, 'room', MAX_RESUME_BUFFERED_FRAMES - 1);
	assert.ok(fakeWs.sent[0].includes('"__replay:room"'), 'truncation marker first');
	assert.ok(fakeWs.sent[0].includes('"truncated"'));
	assert.equal(fakeWs.sent[1], 'E' + MAX_RESUME_BUFFERED_FRAMES, 'then the surviving tail');
});

test('a counter frame is never deduped against an explicit floor (no mixed-space gap)', () => {
	// A topic stamped explicit seq 1000 then a {seq:true} counter frame (seq 1)
	// during the window: the counter frame lives in a different seq space and
	// must NOT be dropped by the explicit floor.
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return p.length; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	captureResumeFrame('room', 1, 'COUNTER1', false, null, false);
	captureResumeFrame('room', 1000, 'EXPLICIT1000', false, null, true);
	flushResumeTopic(cap, 'room', 1000);
	assert.deepEqual(fakeWs.sent, ['COUNTER1'], 'the counter frame flushes, the explicit one is covered');
});

test('a publish that excludes the resuming socket does not flush to it', () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return p.length; }, getUserData: () => ({}) };
	const cap = beginResumeCapture(['room'], fakeWs);
	// A publish excluding exactly this connection must skip its buffer.
	captureResumeFrame('room', 1, 'ENV1', false, fakeWs, false);
	captureResumeFrame('room', 2, 'ENV2', false, null, false);
	flushResumeTopic(cap, 'room', undefined);
	assert.deepEqual(fakeWs.sent, ['ENV2'], 'the excluded frame never reached the resuming socket');
	maxSeenSeq.clear();
});

test('coveredSeqFor tolerates every hook-return shape', () => {
	assert.equal(coveredSeqFor(7, 'room'), 7);
	assert.equal(coveredSeqFor({ room: 3 }, 'room'), 3);
	assert.equal(coveredSeqFor({ other: 3 }, 'room'), undefined);
	assert.equal(coveredSeqFor(null, 'room'), undefined);
	assert.equal(coveredSeqFor('7', 'room'), undefined);
	const throwing = new Proxy({}, { get() { throw new Error('lazy row'); } });
	assert.equal(coveredSeqFor(throwing, 'room'), undefined);
});

test('a publish during an async recover reaches the client before its ack', async () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	let resumeCtx = null;
	const hooks = {
		subscribe: () => null,
		resume: async (ws, ctx) => {
			resumeCtx = ctx;
			// The backend read yields; a live publish lands inside the window.
			await tick();
			platform.publish('room', 'made', { n: 'during' }, { seq: true });
			await tick();
			return { room: ctx.lastSeenSeqs.room };
		}
	};
	const raw = openSocket(hooks);
	await send(raw, { type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
	assert.ok(resumeCtx, 'the resume hook ran');
	assert.deepEqual(resumeCtx.lastSeenSeqs, { room: 0 });
	const frames = raw.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f));
	const liveAt = frames.findIndex((f) => f.event === 'made');
	const ackAt = frames.findIndex((f) => f.type === 'subscribed');
	assert.ok(liveAt !== -1, 'the window frame was delivered to the resuming client');
	assert.ok(ackAt !== -1);
	assert.ok(liveAt < ackAt, 'window frame precedes the subscribed ack');
	assert.equal(resumeBuffers.size, 0, 'no buffer leaked');
	cleanup(raw);
});

test('an unsubscribe landing mid-recover cancels the install and the flush', async () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	let release = null;
	const gate = new Promise((r) => { release = r; });
	const hooks = {
		subscribe: () => null,
		unsubscribe: () => null,
		resume: async () => {
			platform.publish('room', 'made', { n: 1 }, { seq: true });
			await gate;
		}
	};
	const raw = openSocket(hooks);
	const pending = send(raw, { type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 0 } });
	await tick();
	await send(raw, { type: 'unsubscribe', topic: 'room' });
	release();
	await pending;
	const frames = raw.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f));
	assert.ok(
		frames.some((f) => f.type === 'subscribe-denied' && f.topic === 'room'),
		`the cancelled subscribe is denied, got ${JSON.stringify(frames.map((f) => f.type ?? f.event))}`
	);
	assert.ok(!frames.some((f) => f.event === 'made'), 'no buffered frame leaked to a non-member');
	assert.ok(!raw.subscribed.has('room'), 'nothing installed');
	assert.equal(resumeBuffers.size, 0);
	cleanup(raw);
});

test('a denied gate never runs the resume hook', async () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	let resumed = 0;
	const hooks = {
		subscribe: () => 'FORBIDDEN',
		resume: () => { resumed++; }
	};
	const raw = openSocket(hooks);
	await send(raw, { type: 'subscribe', topic: 'secret', ref: 1, recover: { offset: 3 } });
	assert.equal(resumed, 0, 'replay history is never served ahead of a refusal');
	const frames = raw.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f));
	assert.ok(frames.some((f) => f.type === 'subscribe-denied'));
	cleanup(raw);
});

test('the standalone resume frame filters topics and always acks', async () => {
	let ctx = null;
	const hooks = { resume: (ws, c) => { ctx = c; } };
	const raw = openSocket(hooks);
	await send(raw, {
		type: 'resume',
		sessionId: 'prev-session',
		lastSeenSeqs: { room: 7, 'bad topic': 1, __system: 2, other: 3 },
		lastSeenEpochs: { room: 123 }
	});
	assert.ok(ctx, 'hook ran');
	assert.deepEqual({ ...ctx.lastSeenSeqs }, { room: 7, other: 3 }, 'invalid and system topics filtered');
	assert.equal(ctx.sessionId, 'prev-session');
	assert.deepEqual(ctx.lastSeenEpochs, { room: 123 });
	assert.ok(raw.sent.some((f) => f === '{"type":"resumed"}'), 'acked');
	cleanup(raw);
});

test('a hookless resume still acks so the client can go live', async () => {
	const raw = openSocket({});
	await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: { room: 1 } });
	assert.ok(raw.sent.some((f) => f === '{"type":"resumed"}'));
	cleanup(raw);
});

test('the resume frame forwards only finite numeric watermarks to the hook', async () => {
	let ctx = null;
	const raw = openSocket({ resume: (ws, c) => { ctx = c; } });
	await send(raw, {
		type: 'resume',
		sessionId: 's',
		lastSeenSeqs: { good: 5, bad: 'x', huge: 1e999, obj: { n: 1 } }
	});
	assert.deepEqual({ ...ctx.lastSeenSeqs }, { good: 5 }, 'non-finite and non-numeric values dropped');
	cleanup(raw);
});

test('pipelined resume frames are bounded by the gate counter', async () => {
	let inFlight = 0;
	let peak = 0;
	const raw = openSocket({
		resume: async () => {
			inFlight++;
			if (inFlight > peak) peak = inFlight;
			await tick();
			inFlight--;
		}
	});
	const sends = [];
	for (let i = 0; i < 80; i++) {
		sends.push(send(raw, { type: 'resume', sessionId: 's' + i, lastSeenSeqs: { room: i } }));
	}
	await Promise.all(sends);
	assert.ok(peak <= 64, `concurrent resume hooks bounded, saw ${peak}`);
	// Every frame still acked, even the ones that skipped the hook under load.
	const acks = raw.sent.filter((f) => f === '{"type":"resumed"}');
	assert.equal(acks.length, 80, 'every resume frame acked so no client is left hanging');
	cleanup(raw);
});

test('pipelined recover subscribes are bounded by the gate counter', async () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	let inFlight = 0;
	let peak = 0;
	const hooks = {
		subscribe: () => null,
		resume: async () => {
			inFlight++;
			if (inFlight > peak) peak = inFlight;
			await tick();
			inFlight--;
		}
	};
	const raw = openSocket(hooks);
	// Far more pipelined recover frames than the per-connection gate bound
	// (64). Without the bound each one opens a concurrent backend read plus a
	// live-frame buffer.
	const sends = [];
	for (let i = 0; i < 80; i++) {
		sends.push(send(raw, { type: 'subscribe', topic: 'r:' + i, ref: i, recover: { offset: 0 } }));
	}
	await Promise.all(sends);
	assert.ok(peak <= 64, `concurrent resume hooks bounded, saw ${peak}`);
	const frames = raw.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f));
	const denied = frames.filter((f) => f.type === 'subscribe-denied' && f.reason === 'RATE_LIMITED');
	assert.ok(denied.length >= 1, 'the overflow is refused, not silently serialized');
	assert.equal(resumeBuffers.size, 0, 'no buffer leaked');
	cleanup(raw);
});

test('publish records the max seen seq; explicit seqs take the monotone guard', () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	platform.publish('seen', 'e', 1, { seq: true });
	platform.publish('seen', 'e', 2, { seq: true });
	assert.equal(maxSeenSeq.get('seen'), 2);
	// An explicit authoritative seq arriving late must not move the max back.
	platform.publish('auth', 'e', 1, { seq: 50 });
	platform.publish('auth', 'e', 2, { seq: 40 });
	assert.equal(maxSeenSeq.get('auth'), 50);
	topicSeqs.clear();
	maxSeenSeq.clear();
});

test('maxSeenSeq is LRU-bounded so unique-topic publishes do not leak', () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	// Far more distinct topics than the cap. A leak would keep every one.
	for (let i = 0; i < 10_050; i++) {
		platform.publish('room:' + i, 'e', i, { seq: true });
	}
	assert.ok(maxSeenSeq.size <= 10_000, `bounded, saw ${maxSeenSeq.size}`);
	// The most recent topics survive; the oldest were evicted.
	assert.ok(maxSeenSeq.has('room:10049'), 'the newest topic is retained');
	assert.ok(!maxSeenSeq.has('room:0'), 'the oldest topic was evicted');
	topicSeqs.clear();
	maxSeenSeq.clear();
});
