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
	noteMaxSeen,
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
const { SEND_DROPPED } = await import('../../src/runtime/utils/send-result.js');

/** A socket whose send results are scripted; anything past the script succeeds. */
function scriptedWs(script) {
	const sent = [];
	return { sent, send(p) { sent.push(p); return script.length ? script.shift() : 1; } };
}

/**
 * Capture a frame the way a publish does: the seq is recorded as SEEN before
 * the frame is buffered. That high-water mark is what lets the flush tell a
 * watermark the server could have issued from one it could not, so a test that
 * captures without it is testing a state the runtime never reaches.
 */
function captureLive(topic, seq, envelope, authoritative = true, excludeWs = null) {
	// noteMaxSeen itself, not a copy of its rule: a reimplementation here would
	// keep encoding today's rule after the real one changed, and every test in
	// this file would stay green against a state the runtime no longer reaches.
	noteMaxSeen(topic, seq, authoritative);
	captureResumeFrame(topic, seq, envelope, false, excludeWs, authoritative);
}

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

// A double quote is always illegal in a wire topic, and being plain ASCII it
// stays visible in a diff and in an editor. A control byte here makes git
// treat the whole file as binary.
const BAD_TOPIC = 'bad"topic';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('the barrier holds frames across the window and flushes above the floor', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return 1; } };
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
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return 1; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	captureLive('room', 1, 'ENV1');
	captureLive('room', 2, 'ENV2');
	flushResumeTopic(cap, 'room', coveredSeqFor({ room: 1 }, 'room'));
	assert.deepEqual(fakeWs.sent, ['ENV2']);
	maxSeenSeq.clear();
});

test('seq-less frames always flush; discard delivers nothing', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return 1; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	captureResumeFrame('room', null, 'PLAIN', false);
	flushResumeTopic(cap, 'room', 999);
	assert.deepEqual(fakeWs.sent, ['PLAIN'], 'a seq-less frame cannot be deduped, so it flushes');

	const fakeWs2 = { sent: [], send(p) { this.sent.push(p); return 1; } };
	const cap2 = beginResumeCapture(['room'], fakeWs2);
	captureResumeFrame('room', 1, 'ENV', false);
	discardResumeCapture(cap2);
	assert.deepEqual(fakeWs2.sent, []);
	assert.equal(resumeBuffers.size, 0);
});

test('an overflowed window signals truncation FIRST, then best-effort frames', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return 1; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	for (let i = 1; i <= MAX_RESUME_BUFFERED_FRAMES + 10; i++) {
		captureLive('room', i, 'E' + i);
	}
	flushResumeTopic(cap, 'room', MAX_RESUME_BUFFERED_FRAMES - 1);
	assert.ok(fakeWs.sent[0].includes('"__replay:room"'), 'truncation marker first');
	assert.ok(fakeWs.sent[0].includes('"truncated"'));
	assert.equal(fakeWs.sent[1], 'E' + MAX_RESUME_BUFFERED_FRAMES, 'then the surviving tail');
	maxSeenSeq.clear();
});

test('a refused gap-fill frame stops the flush and signals truncation', () => {
	// The ack that follows this flush tells the client to go live. A frame the
	// socket refused past its backpressure limit is a hole the client has no way
	// to detect, so the flush stops pushing into a refusing socket and says so on
	// the replay channel instead of going quiet.
	const ws = scriptedWs([1, SEND_DROPPED]);
	const cap = beginResumeCapture(['room'], ws);
	captureResumeFrame('room', 1, 'ENV1', false, null, true);
	captureResumeFrame('room', 2, 'ENV2', false, null, true);
	captureResumeFrame('room', 3, 'ENV3', false, null, true);
	flushResumeTopic(cap, 'room', 0);
	assert.equal(ws.sent[0], 'ENV1', 'the accepted frame went out');
	assert.equal(ws.sent[1], 'ENV2', 'the refused frame was attempted once');
	assert.ok(ws.sent[2] && ws.sent[2].includes('"truncated"'), 'truncation signalled');
	assert.ok(ws.sent[2].includes('"__replay:room"'), 'on this topic\'s replay channel');
	assert.equal(ws.sent.length, 3, 'ENV3 was never pushed into a socket already refusing');
	assert.equal(resumeBuffers.size, 0, 'the buffer still closed');
});

test('an overflowed window that also drops signals exactly once', () => {
	// The overflow branch already signalled up front; a drop during the
	// best-effort tail must not send a second marker - AND must still stop the
	// tail. The floor leaves several frames eligible on purpose: with only one
	// there is nothing after the drop, so the break itself goes uncovered.
	const ws = scriptedWs([1, 1, SEND_DROPPED]);
	const cap = beginResumeCapture(['room'], ws);
	for (let i = 1; i <= MAX_RESUME_BUFFERED_FRAMES + 10; i++) {
		captureLive('room', i, 'E' + i);
	}
	flushResumeTopic(cap, 'room', MAX_RESUME_BUFFERED_FRAMES - 6);
	const markers = ws.sent.filter((f) => typeof f === 'string' && f.includes('"truncated"'));
	assert.equal(markers.length, 1, 'signalled once, up front');
	// marker, one accepted frame, one refused frame - and then nothing.
	assert.equal(ws.sent.length, 3, 'the tail stopped at the refusal');
	maxSeenSeq.clear();
});

test('a counter frame is never deduped against an explicit floor (no mixed-space gap)', () => {
	// A topic stamped explicit seq 1000 then a {seq:true} counter frame (seq 1)
	// during the window: the counter frame lives in a different seq space and
	// must NOT be dropped by the explicit floor.
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return 1; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	captureLive('room', 1, 'COUNTER1', false);
	captureLive('room', 1000, 'EXPLICIT1000');
	flushResumeTopic(cap, 'room', 1000);
	assert.deepEqual(fakeWs.sent, ['COUNTER1'], 'the counter frame flushes, the explicit one is covered');
	maxSeenSeq.clear();
});

test('a covered seq above anything the server stamped cannot wipe the window', () => {
	// The hook's RETURN becomes the dedup floor, and echoing the client's own
	// offset back is the natural hook shape - this repo's own fixture does it.
	// So without a ceiling a client sending an absurd offset has its entire held
	// window discarded, silently, by the machinery that exists to prevent gaps.
	const ws = scriptedWs([]);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 10, 'ENV10');
	captureLive('room', 11, 'ENV11');
	flushResumeTopic(cap, 'room', 1e308);
	assert.deepEqual(ws.sent, ['ENV10', 'ENV11'], 'the window survives an impossible floor');
	maxSeenSeq.clear();
});

test('a counter publish cannot lower the ceiling below the pre-window mark', () => {
	// noteMaxSeen guards monotonicity only for explicit seqs, so a { seq: true }
	// publish overwrites the mark DOWNWARD. If the ceiling followed it, a
	// reported watermark would be rejected and the fallback - the pre-window
	// mark - would sit ABOVE the value it rejected, discarding in-window frames
	// the hook never covered. That is a silent gap made by the anti-gap guard.
	const ws = scriptedWs([]);
	noteMaxSeen('room', 1000, true);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 800, 'REORDERED800');
	noteMaxSeen('room', 3, false);
	assert.equal(maxSeenSeq.get('room'), 3, 'the counter publish really did lower the mark');
	// The hook honestly replayed up to 700 and stopped; 800 is past it.
	flushResumeTopic(cap, 'room', 700);
	assert.deepEqual(ws.sent, ['REORDERED800'], 'the uncovered frame is delivered, not deduped');
	maxSeenSeq.clear();
});

test('a hook returning NaN reaches the flush as a floor, through coveredSeqFor', () => {
	// End to end, because the flush's own NaN handling is not what changed -
	// coveredSeqFor no longer screens it out, and that composition is the only
	// path production takes.
	const ws = scriptedWs([]);
	noteMaxSeen('room', 50, true);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 40, 'REORDERED40');
	flushResumeTopic(cap, 'room', coveredSeqFor({ room: NaN }, 'room'));
	assert.deepEqual(ws.sent, ['REORDERED40'], 'nonsense report dedups nothing');
	maxSeenSeq.clear();
});

test('a NaN covered seq deduplicates nothing rather than falling back', () => {
	// A hook that reported nonsense has said nothing about what it covered. The
	// conservative pre-window floor would silently DROP a frame captured below
	// it - which a reordered cluster seq can be - while re-delivering cannot
	// lose anything.
	const ws = scriptedWs([]);
	maxSeenSeq.set('room', 50);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 40, 'REORDERED');
	flushResumeTopic(cap, 'room', NaN);
	assert.deepEqual(ws.sent, ['REORDERED'], 'delivered, not dropped under the pre-window floor');
	maxSeenSeq.clear();
});

test('a publish that excludes the resuming socket does not flush to it', () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return 1; }, getUserData: () => ({}) };
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
	// Reported values pass through as reported, magnitude and all. Whether one
	// is USABLE as a dedup floor depends on the topic high-water mark, which
	// this pure helper cannot see - flushResumeTopic decides that.
	assert.equal(coveredSeqFor(Infinity, 'room'), Infinity, 'bare Infinity');
	assert.equal(coveredSeqFor({ room: 1e308 }, 'room'), 1e308, 'per-topic magnitude');
	assert.ok(Number.isNaN(coveredSeqFor({ room: NaN }, 'room')), 'NaN survives as NaN');
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
		lastSeenSeqs: { room: 7, [BAD_TOPIC]: 1, __system: 2, other: 3 },
		lastSeenEpochs: { room: 123 }
	});
	assert.ok(ctx, 'hook ran');
	assert.deepEqual({ ...ctx.lastSeenSeqs }, { room: 7, other: 3 }, 'invalid and system topics filtered');
	assert.equal(ctx.sessionId, 'prev-session');
	assert.deepEqual({ ...ctx.lastSeenEpochs }, { room: 123 });
	assert.ok(raw.sent.some((f) => f === '{"type":"resumed"}'), 'acked');
	cleanup(raw);
});

test('a hookless resume still acks so the client can go live', async () => {
	const raw = openSocket({});
	await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: { room: 1 } });
	assert.ok(raw.sent.some((f) => f === '{"type":"resumed"}'));
	cleanup(raw);
});

test('the resume frame refuses only watermarks the wire cannot mean', async () => {
	let ctx = null;
	const raw = openSocket({ resume: (ws, c) => { ctx = c; } });
	await send(raw, {
		type: 'resume',
		sessionId: 's',
		lastSeenSeqs: {
			good: 5,
			zero: 0,
			bad: 'x',
			huge: 1e999,
			obj: { n: 1 },
			neg: -1,
			negFrac: -0.5,
			// These two SURVIVE. An explicit `{ seq: <number> }` publish is passed
			// through verbatim, so a fractional cursor or one past 2^53 is a
			// watermark this server put on the wire. Refusing it would drop the
			// topic from the map the hook gap-fills from and still ack `resumed`.
			frac: 2.5,
			big: 1e308
		}
	});
	assert.ok(ctx, 'hook ran');
	assert.deepEqual(
		{ ...ctx.lastSeenSeqs },
		{ good: 5, zero: 0, frac: 2.5, big: 1e308 },
		'0 is "seen nothing yet"; only what the wire cannot mean is refused'
	);
	cleanup(raw);
});

test('an omitted epoch map reaches the hook as undefined, not an empty object', async () => {
	// The recover lane reports "no epoch known" by passing undefined. If this
	// lane passed {} instead, a hook keying on the difference would read a
	// client that sent nothing as a client that sent an empty map.
	let ctx = null;
	const raw = openSocket({ resume: (ws, c) => { ctx = c; } });
	await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: { room: 1 } });
	assert.ok(ctx, 'hook ran');
	assert.equal(ctx.lastSeenEpochs, undefined);
	cleanup(raw);
});

test('both resume entry points hold the epoch to the same rule', async () => {
	// A `resume` frame and a `subscribe` carrying `recover` feed the SAME hook
	// argument. When the two lanes disagreed, identical client state produced
	// two different gap-fill decisions depending on which frame carried it:
	// recover took Number.isInteger (so -5 passed) and resume took
	// Number.isFinite (so 2.5 passed).
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const seen = [];
	const raw = openSocket({
		subscribe: () => null,
		resume: (ws, c) => { seen.push(c.lastSeenEpochs); }
	});
	const epochs = [-5, 2.5];
	for (let i = 0; i < epochs.length; i++) {
		const epoch = epochs[i];
		await send(raw, {
			type: 'subscribe',
			topic: 'room' + i,
			ref: i + 1,
			recover: { offset: 0, epoch }
		});
		await send(raw, {
			type: 'resume',
			sessionId: 's',
			lastSeenSeqs: { room: 0 },
			lastSeenEpochs: { room: epoch }
		});
	}
	assert.equal(seen.length, 4, 'both lanes ran the hook for both values');
	// Asserted on the values themselves, not on a spread of them: `{ ...x }` is
	// `{}` for undefined AND for an empty map, so spreading here would hide the
	// very difference the test above declares hooks key on.
	assert.equal(seen[0], undefined, 'recover refuses a negative epoch, reporting absence');
	assert.notEqual(seen[1], undefined, 'resume sends a map, so the hook sees one');
	assert.equal(Object.keys(seen[1]).length, 0, 'with the refused entry removed');
	assert.equal(seen[2], undefined, 'recover refuses a fractional epoch');
	assert.notEqual(seen[3], undefined);
	assert.equal(Object.keys(seen[3]).length, 0, 'and so does resume');
	cleanup(raw);
});

test('a recover offset the wire cannot mean subscribes plainly', async () => {
	// No gap-fill rather than a gap-fill from a fabricated offset: the hook
	// queries a backend with this value.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	let ran = 0;
	const raw = openSocket({ subscribe: () => null, resume: () => { ran++; } });
	await send(raw, { type: 'subscribe', topic: 'a', ref: 1, recover: { offset: -1 } });
	assert.equal(ran, 0, 'a negative offset is not a recover');
	await send(raw, { type: 'subscribe', topic: 'b', ref: 2, recover: { offset: 1e999 } });
	assert.equal(ran, 0, 'nor is a non-finite one');
	await send(raw, { type: 'subscribe', topic: 'c', ref: 3, recover: { offset: '5' } });
	assert.equal(ran, 0, 'nor a string');
	// And the other direction, which is the one that bites: refusing does not
	// clamp, it skips the gap-fill entirely and still acks. An app cursor must
	// survive.
	await send(raw, { type: 'subscribe', topic: 'd', ref: 4, recover: { offset: 2.5 } });
	assert.equal(ran, 1, 'a fractional app cursor DOES gap-fill');
	await send(raw, { type: 'subscribe', topic: 'e', ref: 5, recover: { offset: 1e308 } });
	assert.equal(ran, 2, 'and so does one past 2^53');
	cleanup(raw);
});

test('the epoch map is filtered exactly like the watermark map', async () => {
	// It rides into the same hook, so it takes the same topic validation,
	// system-topic guard, value check, and null prototype.
	let ctx = null;
	const raw = openSocket({ resume: (ws, c) => { ctx = c; } });
	await send(raw, {
		type: 'resume',
		sessionId: 's',
		lastSeenSeqs: { room: 1 },
		lastSeenEpochs: { room: 7, __system: 9, [BAD_TOPIC]: 3, neg: -5, frac: 2.5, str: 'x' }
	});
	assert.ok(ctx, 'hook ran');
	assert.deepEqual({ ...ctx.lastSeenEpochs }, { room: 7 }, 'only the valid topic and value survive');
	assert.equal(
		Object.getPrototypeOf(ctx.lastSeenEpochs),
		null,
		'null prototype, so a __proto__ key cannot reach the hook as inherited state'
	);
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
