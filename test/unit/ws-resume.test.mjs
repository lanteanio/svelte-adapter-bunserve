import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// The resume barrier and its two entry points. The barrier's job is exactly
// one thing: a publish that lands while an async resume hook is reading the
// backend must reach the resuming client, in order, before its subscribed
// ack - not vanish into the window between the backend read and the live
// membership.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';


const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const {
	CONTROL_FLOOD_CLOSE_CODE,
	MAX_BATCH_TOPICS,
	RESUME_INCOMPLETE_CLOSE_CODE
} = await import('../../src/runtime/utils/control-frame.js');
const {
	MAX_CONTROL_EGRESS_BYTES,
	MAX_SEQ_TOPICS,
	chargeControlEgress,
	maxAuthoritativeSeq,
	notePublishedSeq,
	resumeBuffers,
	setServer,
	topicSeqs,
	wsCounters
} = await import('../../src/runtime/handler/ws-state.js');
const {
	beginResumeCapture,
	coveredSeqFor,
	discardResumeCapture,
	flushResumeTopic,
	markResumeTruncated
} = await import('../../src/runtime/handler/resume-buffer.js');
const { captureResumeFrame, MAX_RESUME_BUFFERED_FRAMES } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');
const { SEND_DROPPED } = await import('../../src/runtime/utils/send-result.js');

/**
 * A socket whose send results are scripted; anything past the script succeeds.
 *
 * It records what it was closed with. The flush's last resort, when a socket
 * refuses even the truncation marker, is to close the connection - and a fake
 * without `end` turns that close into a TypeError the flush catches, so the
 * escalation would read as a dead socket instead of being observed.
 */
function scriptedWs(script) {
	const sent = [];
	const closed = [];
	return {
		sent,
		closed,
		send(p) { sent.push(p); return script.length ? script.shift() : 1; },
		end(code, reason) { closed.push({ code, reason }); }
	};
}

/** A socket that is already gone: every send throws, the way the facade does. */
function deadWs() {
	const closed = [];
	return {
		closed,
		send() { throw new Error('Invalid access of closed socket'); },
		end(code, reason) { closed.push({ code, reason }); }
	};
}

/**
 * A socket the control-egress budget actually applies to. The per-connection
 * budget lives in `getUserData`, and a fake without one is charged nothing - so
 * the plain fakes above cannot see whether a send was budgeted or not.
 */
function budgetedWs() {
	const userData = {};
	const sent = [];
	const closed = [];
	return {
		sent,
		closed,
		send(p) { sent.push(p); return 1; },
		end(code, reason) { closed.push({ code, reason }); },
		getUserData: () => userData
	};
}

/**
 * Capture a frame the way a publish does: the seq is noted against the topic's
 * mark before the frame is buffered. That high-water mark is what lets the flush
 * tell a watermark the server could have issued from one it could not, so a test
 * that captures without it is testing a state the runtime never reaches.
 */
function captureLive(topic, seq, envelope, authoritative = true, excludeWs = null) {
	// notePublishedSeq itself, not a copy of its rule: a reimplementation here would
	// keep encoding today's rule after the real one changed, and every test in
	// this file would stay green against a state the runtime no longer reaches.
	notePublishedSeq(topic, seq, authoritative);
	captureResumeFrame(topic, seq, envelope, false, excludeWs, authoritative);
}

function rawSocket() {
	const sent = [];
	const closes = [];
	const subscribed = new Set();
	return {
		data: upgradeData(),
		sent,
		closes,
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
		close(code, reason) { closes.push({ code, reason }); },
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
	maxAuthoritativeSeq.clear();
}

// A double quote is always illegal in a wire topic, and being plain ASCII it
// stays visible in a diff and in an editor. A control byte here makes git
// treat the whole file as binary.
const BAD_TOPIC = 'bad"topic';

// U+202E RIGHT-TO-LEFT OVERRIDE, built from its code point rather than typed.
// A literal one reorders the rest of the line in every editor and diff that
// renders it, which is precisely why the subscribe lane refuses it - and why a
// test for that must not paste one into this file.
const RTL_TOPIC = 'room:' + String.fromCharCode(0x202e) + 'txt.gnp';

/** Every text frame the socket has been sent, parsed. */
function frames(raw) {
	return raw.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f));
}

/** A lastSeenSeqs map naming `n` distinct topics. */
function manyTopics(n) {
	const out = {};
	for (let i = 0; i < n; i++) out['t:' + i] = i;
	return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Module-level Maps are shared by every test here. Clearing them up front rather
// than only at the tail of each body means one failing test cannot cascade into
// a second failure that has nothing to do with what broke.
beforeEach(() => {
	maxAuthoritativeSeq.clear();
	topicSeqs.clear();
	resumeBuffers.clear();
});

test('the barrier holds frames across the window and flushes above the floor', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return 1; } };
	maxAuthoritativeSeq.set('room', 5);
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
	maxAuthoritativeSeq.clear();
});

test('a reported watermark overrides the fallback floor', () => {
	const fakeWs = { sent: [], send(p) { this.sent.push(p); return 1; } };
	const cap = beginResumeCapture(['room'], fakeWs);
	captureLive('room', 1, 'ENV1');
	captureLive('room', 2, 'ENV2');
	flushResumeTopic(cap, 'room', coveredSeqFor({ room: 1 }, 'room'));
	assert.deepEqual(fakeWs.sent, ['ENV2']);
	maxAuthoritativeSeq.clear();
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
	maxAuthoritativeSeq.clear();
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
	maxAuthoritativeSeq.clear();
});

test('a marker the socket refuses is retried, because a refused marker told nobody', () => {
	// The marker is most likely to be refused in exactly the case it exists for:
	// the socket is at or over its limit, which is why the flush gave up. Taking
	// the first attempt as proof the client was told is how the one window that
	// most needs the signal becomes the one window that skips it.
	const ws = scriptedWs([SEND_DROPPED]);
	const cap = beginResumeCapture(['room'], ws);
	markResumeTruncated(cap, 'room');
	const unusable = flushResumeTopic(cap, 'room', undefined);
	assert.equal(ws.sent.length, 2, 'attempted twice, because the first attempt arrived nowhere');
	assert.ok(ws.sent[1].includes('"truncated"'), 'and the retry is the same marker');
	assert.equal(ws.closed.length, 0, 'a client that got it needs no closing');
	assert.equal(unusable, false, 'so the caller carries on and acks');
});

test('a truncation the socket will not take at all closes the connection', () => {
	// The end of the line. There is no way left to tell this client its history
	// has a hole, and staying connected is the one outcome that leaves it
	// silently wrong: the `subscribed` ack would follow and it would go live
	// trusting a gap-fill it never received. The reconnect resumes from the last
	// seq it actually got, so the missed tail is re-delivered rather than lost.
	const ws = scriptedWs([SEND_DROPPED, SEND_DROPPED]);
	const cap = beginResumeCapture(['room'], ws);
	markResumeTruncated(cap, 'room');
	const unusable = flushResumeTopic(cap, 'room', undefined);
	assert.equal(ws.closed.length, 1, 'the connection was closed');
	assert.equal(ws.closed[0].code, RESUME_INCOMPLETE_CLOSE_CODE, 'with the retry-class code');
	assert.equal(unusable, true, 'and the caller is told to stop');
	assert.equal(resumeBuffers.size, 0, 'the buffer still closed');
});

test('a window with nothing left to flush still escalates its own marker', () => {
	// The edge a frame-driven escalation cannot see. Every held frame is already
	// covered by the resume, so the flush sends nothing and learns nothing about
	// the socket - yet the window overflowed, so the client still has a hole. The
	// marker carries that on its own, and its refusal escalates on its own.
	const ws = scriptedWs([SEND_DROPPED, SEND_DROPPED]);
	const cap = beginResumeCapture(['room'], ws);
	for (let i = 1; i <= MAX_RESUME_BUFFERED_FRAMES + 10; i++) captureLive('room', i, 'E' + i);
	const unusable = flushResumeTopic(cap, 'room', MAX_RESUME_BUFFERED_FRAMES + 10);
	assert.ok(
		ws.sent.every((f) => f.includes('"truncated"')),
		'nothing but markers went out - every frame was already covered'
	);
	assert.equal(ws.closed[0] && ws.closed[0].code, RESUME_INCOMPLETE_CLOSE_CODE, 'and it closed');
	assert.equal(unusable, true);
	maxAuthoritativeSeq.clear();
});

test('a refused frame whose marker is also refused closes the connection', () => {
	// The mid-flush half of the same rule: the hole is discovered by a frame the
	// socket would not take, and the marker announcing it fares no better.
	const ws = scriptedWs([1, SEND_DROPPED, SEND_DROPPED]);
	const cap = beginResumeCapture(['room'], ws);
	captureResumeFrame('room', 1, 'ENV1', false, null, true);
	captureResumeFrame('room', 2, 'ENV2', false, null, true);
	captureResumeFrame('room', 3, 'ENV3', false, null, true);
	const unusable = flushResumeTopic(cap, 'room', 0);
	assert.equal(ws.sent.length, 3, 'one frame out, one refused, one marker - then nothing');
	assert.ok(ws.sent[2].includes('"truncated"'), 'the marker was attempted');
	assert.equal(ws.closed[0] && ws.closed[0].code, RESUME_INCOMPLETE_CLOSE_CODE, 'then the close');
	assert.equal(unusable, true);
});

test('a socket that is already gone is not closed a second time', () => {
	// A throw means the connection is finished, not that it is refusing: there is
	// nothing to signal to and nothing to close. Treating the two the same would
	// call end() on a corpse and book the close as our own.
	const ws = deadWs();
	const cap = beginResumeCapture(['room'], ws);
	markResumeTruncated(cap, 'room');
	const unusable = flushResumeTopic(cap, 'room', undefined);
	assert.equal(ws.closed.length, 0, 'nothing was closed');
	assert.equal(unusable, true, 'but the caller still stops');
	assert.equal(resumeBuffers.size, 0, 'and the buffer still closed');
});

test('a healthy flush neither signals nor closes', () => {
	const ws = scriptedWs([]);
	const cap = beginResumeCapture(['room'], ws);
	captureResumeFrame('room', 1, 'ENV1', false, null, true);
	captureResumeFrame('room', 2, 'ENV2', false, null, true);
	const unusable = flushResumeTopic(cap, 'room', 0);
	assert.deepEqual(ws.sent, ['ENV1', 'ENV2'], 'the window went out and nothing else');
	assert.equal(ws.closed.length, 0);
	assert.equal(unusable, false);
});

test('a truncation marker is charged to the control-egress budget', () => {
	// The marker is server egress a client buys by naming topics in a resume or
	// a recover, one frame per topic. That is the shape the control budget
	// exists to bound, so it is charged like every other answer on the channel;
	// uncharged, a resume lane emitting one per topic is an amplifier the
	// budget cannot see.
	const ws = budgetedWs();
	const cap = beginResumeCapture(['room'], ws);
	markResumeTruncated(cap, 'room');
	flushResumeTopic(cap, 'room', undefined);
	const marker = ws.sent[0];
	assert.ok(marker.includes('"truncated"'), 'the marker went out');
	// Exact: the window has room for everything but the marker's own bytes.
	const spent = Buffer.byteLength(marker);
	assert.equal(
		chargeControlEgress(ws, MAX_CONTROL_EGRESS_BYTES - spent),
		true,
		'the rest of the window is still there'
	);
	assert.equal(chargeControlEgress(ws, 1), false, 'and the marker took exactly its own bytes');
});

test('a marker the budget cannot afford cuts the connection instead of vanishing', () => {
	// The over-budget case is the one that decides whether charging the marker
	// is safe. Dropping it silently would reintroduce the gap the signal exists
	// to close: the `subscribed` ack still follows and the client goes live
	// believing its gap-fill completed. Cutting says the same thing louder - a
	// client that reconnects cold-resyncs, which is what the marker was for.
	const ws = budgetedWs();
	assert.equal(chargeControlEgress(ws, MAX_CONTROL_EGRESS_BYTES), true, 'window spent');
	const cap = beginResumeCapture(['room'], ws);
	markResumeTruncated(cap, 'room');
	flushResumeTopic(cap, 'room', undefined);
	assert.ok(!ws.sent.some((f) => f.includes('"truncated"')), 'the marker was not sent');
	assert.equal(ws.closed.length, 1, 'the connection was cut');
	assert.equal(ws.closed[0].code, CONTROL_FLOOD_CLOSE_CODE, 'with the control-flood code');
	assert.equal(resumeBuffers.size, 0, 'and the buffer still closed');
});

// --- publishWireBatch's resume capture -------------------------------------
//
// The batch path stamps and captures its own frames rather than going through
// publish(), so the two can disagree about the same event. These drive it
// through the JSON fast path: the capture happens BEFORE any fan-out, so a
// stateful codec that declines every encode reaches it with no connection that
// wants binary.

/** A stateful codec (wire.state set) whose encode always declines. */
const statefulCodec = () => ({
	capability: 'cap:resume-batch',
	schemaVersion: 1,
	encode: () => null,
	state: {}
});

/** A socket that records envelopes, for the flush to deliver into. */
function collectingWs() {
	const sent = [];
	return { sent, send(p) { sent.push(p); return 1; } };
}

test('publishWireBatch keeps an entry seq as stamped, not through the wire sentinel', () => {
	// The defect was a round-trip through the binary wire's 0 ("no seq"), which
	// cannot tell a stamped seq from an absent one. Publishing 0 is refused
	// outright now - it is the sentinel - so the round-trip is driven with 1,
	// which the old sentinel form also mangled for exactly one value below it.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const ws = collectingWs();
	const cap = beginResumeCapture(['room'], ws);
	platform.publishWireBatch('room', 'moved', [{ data: { x: 1 }, seq: 1 }], statefulCodec());
	flushResumeTopic(cap, 'room', 1);
	assert.deepEqual(ws.sent, [], 'the stamped seq reached the capture and deduped');
	maxAuthoritativeSeq.clear();
});

test('a publish seq of 0 is refused: it is the frame\'s "no seq" sentinel', () => {
	// Pinned HERE as well as in the wire suite because this is the module the
	// distinction matters to: a stamped 0 would be indistinguishable from an
	// absent seq for every binary subscriber.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	assert.throws(
		() => platform.publishWireBatch('room', 'moved', [{ data: { x: 1 }, seq: 0 }], statefulCodec()),
		TypeError
	);
	assert.equal(resumeBuffers.size, 0, 'and it opened no capture on the way out');
	maxAuthoritativeSeq.clear();
});

test('publishWireBatch stamps each entry its own explicit seq', () => {
	// One seq per entry is the documented contract, and it is what makes a
	// partial delivery recoverable: the client reports the last seq it actually
	// holds, and only the entries above it are re-sent.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const ws = collectingWs();
	const cap = beginResumeCapture(['room'], ws);
	platform.publishWireBatch(
		'room',
		'moved',
		[{ data: { x: 1 }, seq: 10 }, { data: { x: 2 }, seq: 11 }, { data: { x: 3 }, seq: 12 }],
		statefulCodec()
	);
	flushResumeTopic(cap, 'room', 11);
	assert.equal(ws.sent.length, 1, 'only the entry above the reported watermark');
	assert.ok(ws.sent[0].includes('"seq":12'), 'and it is the third entry, with its own seq');
	assert.equal(maxAuthoritativeSeq.get('room'), 12, 'the mark took the highest entry seq');
	maxAuthoritativeSeq.clear();
});

test('a batch-level explicit seq throws: one number cannot be one seq per entry', () => {
	// Both ways of absorbing it lose data with nothing for the caller to notice
	// it by. Stamping all N entries with the one number is the sharper of the
	// two: a client holding only part of the batch reports that shared seq as
	// its watermark and the floor then discards the WHOLE batch, including the
	// entries it never received. Publishing seq-less instead only trades that
	// for a silently degraded dedup. So this fails the way a per-entry seq the
	// wire cannot carry already does - one class of misuse, one failure mode.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const ws = collectingWs();
	const cap = beginResumeCapture(['room'], ws);
	const entries = [{ data: { x: 1 } }, { data: { x: 2 } }];
	assert.throws(
		() => platform.publishWireBatch('room', 'moved', entries, statefulCodec(), { seq: 1234 }),
		(err) => err instanceof TypeError && err.message.includes('{ data, seq }'),
		'threw a TypeError naming the per-entry form'
	);
	assert.equal(
		maxAuthoritativeSeq.get('room'),
		undefined,
		'the topic mark was not poisoned with the batch seq'
	);
	flushResumeTopic(cap, 'room', 1234);
	assert.deepEqual(ws.sent, [], 'and not one entry was published on the way out');
	maxAuthoritativeSeq.clear();
});

test('a batch-level explicit seq is refused on an empty batch too', () => {
	// The seq is a property of the CALL, not of this tick's data. Behind the
	// empty-batch no-op, the check would let the misuse hide on exactly the
	// ticks that publish nothing and surface later under load - which is the
	// failure fail-fast exists to prevent.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const before = wsCounters.publishCount;
	assert.throws(
		() => platform.publishWireBatch('room', 'moved', [], statefulCodec(), { seq: 7 }),
		TypeError
	);
	assert.equal(wsCounters.publishCount, before, 'and counted nothing on the way out');
	assert.equal(
		platform.publishWireBatch('room', 'moved', [], statefulCodec(), { seq: true }),
		false,
		'while { seq: true } on an empty batch is still the no-op'
	);
	maxAuthoritativeSeq.clear();
});

test('the stateless reroute carries a per-entry seq through publishWire', () => {
	// A stateless codec is routed per entry through publishWire, which does its
	// own stamping and capture - so the per-entry seq has to survive the hop.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const ws = collectingWs();
	const cap = beginResumeCapture(['room'], ws);
	platform.publishWireBatch(
		'room',
		'moved',
		[{ data: { x: 1 }, seq: 20 }, { data: { x: 2 }, seq: 21 }],
		{ capability: 'cap:resume-stateless', schemaVersion: 1, encode: () => null }
	);
	flushResumeTopic(cap, 'room', 20);
	assert.equal(ws.sent.length, 1, 'the entry at the watermark was deduped, the one above was not');
	assert.ok(ws.sent[0].includes('"seq":21'));
	maxAuthoritativeSeq.clear();
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
	maxAuthoritativeSeq.clear();
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
	maxAuthoritativeSeq.clear();
});

test('a counter publish never writes the explicit mark', () => {
	// The two seq spaces are unrelated: a { seq: true } publish draws from the
	// local per-topic counter, so its value says nothing about the highest seq
	// the cluster has stamped. Writing it here would clobber that mark, downward
	// included, and both consumers of the mark read it as an explicit seq.
	notePublishedSeq('room', 1000, true);
	notePublishedSeq('room', 500, true);
	assert.equal(maxAuthoritativeSeq.get('room'), 1000, 'a late explicit seq does not move it back');
	notePublishedSeq('room', 3, false);
	assert.equal(maxAuthoritativeSeq.get('room'), 1000, 'and a counter seq does not become the mark');
	assert.equal(maxAuthoritativeSeq.has('fresh'), false);
	notePublishedSeq('fresh', 9, false);
	assert.equal(maxAuthoritativeSeq.has('fresh'), false, 'nor creates one');
	maxAuthoritativeSeq.clear();
});

test('an honest watermark survives a counter publish in the window', () => {
	// A reported watermark is trusted only up to what this server has stamped.
	// A { seq: true } publish landing mid-window draws from an unrelated space
	// and must not pull that bound down under an honest report: rejecting one
	// drops the flush back onto its conservative fallback, which turns exact
	// dedup into re-delivery of the whole held window.
	const ws = scriptedWs([]);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 1000, 'ENV1000');
	captureLive('room', 900, 'COVERED900');
	notePublishedSeq('room', 3, false);
	// The hook honestly replayed up to 950: 1000 is past it, 900 is not.
	flushResumeTopic(cap, 'room', 950);
	assert.deepEqual(ws.sent, ['ENV1000'], 'the report is the floor, not the fallback');
	maxAuthoritativeSeq.clear();
});

test('the fallback floor on a mixed topic is the explicit mark, not the counter', () => {
	// A hook that reports nothing falls back to the pre-window mark. On a topic
	// published both ways that mark must still be the explicit high-water seq: a
	// counter value standing in for it sits far below the replayed history, and
	// re-delivers frames the resume already covered.
	const ws = scriptedWs([]);
	notePublishedSeq('room', 1000, true);
	notePublishedSeq('room', 3, false);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 500, 'COVERED500');
	captureLive('room', 1500, 'ENV1500');
	flushResumeTopic(cap, 'room', undefined);
	assert.deepEqual(ws.sent, ['ENV1500'], 'only the frame past the explicit mark');
	maxAuthoritativeSeq.clear();
});

test('a NaN explicit seq neither erases nor seeds a mark', () => {
	// The mark moves only on a strictly greater seq. NaN orders against nothing,
	// so a publish carrying one leaves the mark standing. The alternative is a
	// mark no comparison can use, in place of the high-water seq the flush needs
	// as its ceiling.
	notePublishedSeq('room', 1000, true);
	notePublishedSeq('room', NaN, true);
	assert.equal(maxAuthoritativeSeq.get('room'), 1000, 'the standing mark survives');
	notePublishedSeq('fresh', NaN, true);
	assert.equal(maxAuthoritativeSeq.has('fresh'), false, 'and NaN never becomes one');
	maxAuthoritativeSeq.clear();
});

test('a counter publish keeps a mixed topic recent without changing its mark', () => {
	// A topic hot in the counter lane and rare in the explicit one would
	// otherwise age out of the bounded map while it is still busy, losing the
	// resume floor for exactly the topics most likely to be resumed.
	notePublishedSeq('hot', 7, true);
	for (let i = 0; i < MAX_SEQ_TOPICS - 1; i++) notePublishedSeq('f:' + i, 1, true);
	assert.equal(maxAuthoritativeSeq.size, MAX_SEQ_TOPICS, 'full, with hot the least recent');
	notePublishedSeq('hot', 999, false);
	notePublishedSeq('new', 1, true);
	assert.equal(maxAuthoritativeSeq.get('hot'), 7, 'kept, and its value untouched');
	assert.equal(maxAuthoritativeSeq.has('f:0'), false, 'the least recent topic went instead');
	maxAuthoritativeSeq.clear();
});

test('an eviction cannot pull the ceiling below the pre-window mark', () => {
	// Eviction is the one thing left that lowers a live mark. If the ceiling
	// followed it down, an honest report would be rejected and the fallback -
	// the pre-window mark - would sit ABOVE the value it rejected, dropping
	// in-window frames the hook never covered.
	const ws = scriptedWs([]);
	notePublishedSeq('room', 1000, true);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 800, 'REORDERED800');
	// Push 'room' out of the bounded map, then let a later publish re-seed it low.
	for (let i = 0; i < MAX_SEQ_TOPICS + 1; i++) notePublishedSeq('f:' + i, 1, true);
	assert.equal(maxAuthoritativeSeq.has('room'), false, 'evicted mid-window');
	notePublishedSeq('room', 5, true);
	assert.equal(maxAuthoritativeSeq.get('room'), 5, 're-seeded below the pre-window mark');
	// The hook honestly replayed up to 700; 800 is past it.
	flushResumeTopic(cap, 'room', 700);
	assert.deepEqual(ws.sent, ['REORDERED800'], 'the honest report is still the floor');
	maxAuthoritativeSeq.clear();
});

test('an explicit publish refreshes recency too', () => {
	// The explicit lane marks recency for the same reason the counter lane
	// does. Without it a topic that is hot in the explicit lane keeps its
	// original slot and ages out while it is still busy, losing the resume floor
	// for a topic actively receiving the seqs that floor is made of.
	notePublishedSeq('hot', 1, true);
	for (let i = 0; i < MAX_SEQ_TOPICS - 1; i++) notePublishedSeq('f:' + i, 1, true);
	notePublishedSeq('hot', 2, true);
	notePublishedSeq('new', 1, true);
	assert.equal(maxAuthoritativeSeq.get('hot'), 2, 'kept, and raised');
	assert.equal(maxAuthoritativeSeq.has('f:0'), false, 'the least recent topic went instead');
	// Cleared like its neighbours: leaving the map at its cap hands the next
	// test a different regime than the one it was written against.
	maxAuthoritativeSeq.clear();
});

test('a counter value above the mark cannot raise the ceiling', () => {
	// The ceiling bounds a client-controlled report. A counter that has run
	// further than the cluster seqs must not raise it: the client echoes that
	// number back and every held frame is deduped against a seq the cluster
	// never stamped. This is the gap-producing direction of the same defect.
	const ws = scriptedWs([]);
	notePublishedSeq('room', 10, true);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 11, 'ENV11');
	captureLive('room', 12, 'ENV12');
	notePublishedSeq('room', 5000, false);
	flushResumeTopic(cap, 'room', 4000);
	assert.deepEqual(ws.sent, ['ENV11', 'ENV12'], 'an offset the cluster never stamped is refused');
});

test('an explicit seq of 0 is not deduped against a topic with no mark', () => {
	// A cluster seq space can start at 0, so "no mark" must not read as "covered
	// up to 0" - that dedups the first frame of the topic away against a mark
	// this server never set, and the client has no gap detection.
	const ws = scriptedWs([]);
	assert.equal(maxAuthoritativeSeq.has('room'), false, 'nothing stamped for this topic');
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 0, 'ENV0');
	flushResumeTopic(cap, 'room', undefined);
	assert.deepEqual(ws.sent, ['ENV0'], 'the first frame of a 0-based space is delivered');

	// And where the server really HAS stamped seq 0, a frame at that seq is a
	// duplicate and is still deduped - the distinction is absent-vs-zero, not a
	// blanket exemption for 0.
	const ws2 = scriptedWs([]);
	const cap2 = beginResumeCapture(['room'], ws2);
	captureLive('room', 0, 'DUP0');
	captureLive('room', 1, 'ENV1');
	flushResumeTopic(cap2, 'room', undefined);
	assert.deepEqual(ws2.sent, ['ENV1'], 'a real mark of 0 still covers seq 0');
});

test('a hook returning NaN reaches the flush as a floor, through coveredSeqFor', () => {
	// End to end, because the flush's own NaN handling is not what changed -
	// coveredSeqFor no longer screens it out, and that composition is the only
	// path production takes.
	const ws = scriptedWs([]);
	notePublishedSeq('room', 50, true);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 40, 'REORDERED40');
	flushResumeTopic(cap, 'room', coveredSeqFor({ room: NaN }, 'room'));
	assert.deepEqual(ws.sent, ['REORDERED40'], 'nonsense report dedups nothing');
	maxAuthoritativeSeq.clear();
});

test('a NaN covered seq deduplicates nothing rather than falling back', () => {
	// A hook that reported nonsense has said nothing about what it covered. The
	// conservative pre-window floor would silently DROP a frame captured below
	// it - which a reordered cluster seq can be - while re-delivering cannot
	// lose anything.
	const ws = scriptedWs([]);
	maxAuthoritativeSeq.set('room', 50);
	const cap = beginResumeCapture(['room'], ws);
	captureLive('room', 40, 'REORDERED');
	flushResumeTopic(cap, 'room', NaN);
	assert.deepEqual(ws.sent, ['REORDERED'], 'delivered, not dropped under the pre-window floor');
	maxAuthoritativeSeq.clear();
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
	maxAuthoritativeSeq.clear();
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

test('standalone resume forwards every string session id and both complete maps', async () => {
	const maps = {
		lastSeenSeqs: { room: 1, '__realtime': 2, ['__proto__']: 3, [BAD_TOPIC]: 4 },
		lastSeenEpochs: { room: 7, missing: 9, ['__proto__']: 4 }
	};
	for (const sessionId of ['', 's'.repeat(300), 'bad' + String.fromCharCode(0)]) {
		let ctx;
		const raw = openSocket({ resume: (_ws, value) => { ctx = value; } });
		await send(raw, { type: 'resume', sessionId, ...maps });
		assert.equal(ctx.sessionId, sessionId);
		assert.deepEqual(ctx.lastSeenSeqs, maps.lastSeenSeqs);
		assert.deepEqual(ctx.lastSeenEpochs, maps.lastSeenEpochs);
		assert.deepEqual(raw.sent.filter((frame) => !frame.includes('welcome')), ['{"type":"resumed"}']);
		cleanup(raw);
	}
});

test('standalone resume forwards maps larger than a subscribe batch without truncation', async () => {
	let ctx;
	const raw = openSocket({ resume: (_ws, value) => { ctx = value; } });
	const lastSeenSeqs = Object.fromEntries(Array.from({ length: MAX_BATCH_TOPICS + 1 }, (_, i) => ['t' + i, i]));
	const lastSeenEpochs = Object.fromEntries(Array.from({ length: MAX_BATCH_TOPICS + 1 }, (_, i) => ['e' + i, i]));
	await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs, lastSeenEpochs });
	assert.deepEqual(ctx.lastSeenSeqs, lastSeenSeqs);
	assert.deepEqual(ctx.lastSeenEpochs, lastSeenEpochs);
	assert.ok(raw.sent.includes('{"type":"resumed"}'));
	cleanup(raw);
});

test('standalone resume preserves array maps and treats non-object epochs as absent', async () => {
	for (const epochs of [[1, 2], null, 'invalid', 3]) {
		let ctx;
		const raw = openSocket({ resume: (_ws, value) => { ctx = value; } });
		await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: [1, 2], lastSeenEpochs: epochs });
		assert.deepEqual(ctx.lastSeenSeqs, [1, 2]);
		assert.deepEqual(ctx.lastSeenEpochs, Array.isArray(epochs) ? epochs : undefined);
		cleanup(raw);
	}
});

test('a hookless resume still acks so the client can go live', async () => {
	const raw = openSocket({});
	await send(raw, { type: 'resume', sessionId: '', lastSeenSeqs: {} });
	assert.ok(raw.sent.includes('{"type":"resumed"}'));
	cleanup(raw);
});

test('standalone resume leaves watermark validation to the application', async () => {
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
		{ good: 5, zero: 0, bad: 'x', huge: null, obj: { n: 1 }, neg: -1, negFrac: -0.5, frac: 2.5, big: 1e308 },
		'every JSON value reaches the application unchanged'
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

test('subscribe recovery validates epochs while standalone resume forwards them', async () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const seen = [];
	const raw = openSocket({ subscribe: () => null, resume: (_ws, ctx) => { seen.push(ctx.lastSeenEpochs); } });
	for (const epoch of [-5, 2.5]) {
		await send(raw, { type: 'subscribe', topic: 'room' + epoch, ref: 1, recover: { offset: 0, epoch } });
		await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: { room: 0 }, lastSeenEpochs: { room: epoch } });
	}
	assert.deepEqual(seen, [undefined, { room: -5 }, undefined, { room: 2.5 }]);
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

test('every pipelined standalone resume reaches the hook and is acknowledged', async () => {
	let release;
	const barrier = new Promise((resolve) => { release = resolve; });
	let entered = 0;
	const raw = openSocket({ resume: async () => { entered++; await barrier; } });
	const pending = Array.from({ length: 80 }, (_, i) => send(raw, {
		type: 'resume', sessionId: 's' + i, lastSeenSeqs: { room: i }
	}));
	assert.equal(entered, 80);
	assert.equal(raw.sent.filter((f) => f === '{"type":"resumed"}').length, 0);
	release();
	await Promise.all(pending);
	assert.equal(raw.sent.filter((f) => f === '{"type":"resumed"}').length, 80);
	assert.equal(raw.sent.filter((f) => f.includes('RESUME_RATE_LIMITED')).length, 0);
	cleanup(raw);
});

test('a failed standalone resume hook is contained and still acknowledged', async () => {
	const saved = console.error;
	console.error = () => {};
	try {
		for (const resume of [() => { throw new Error('backend down'); }, async () => { throw new Error('backend down'); }]) {
			const raw = openSocket({ resume });
			await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: { room: 1 } });
			assert.deepEqual(raw.sent.filter((frame) => !frame.includes('welcome')), ['{"type":"resumed"}']);
			cleanup(raw);
		}
	} finally { console.error = saved; }
});

test('a resume hook can succeed after repeated failures', async () => {
	const realError = console.error;
	console.error = () => {};
	try {
		let boom = true;
		let ran = 0;
		const raw = openSocket({
			resume: () => {
				ran++;
				if (boom) throw new Error('backend down');
			}
		});
		for (let i = 0; i < 65; i++) {
			await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: { room: i } });
		}
		assert.equal(ran, 65, 'every throwing resume still reached the hook');
		assert.equal(
			raw.sent.filter((f) => f.includes('RESUME_RATE_LIMITED')).length,
			0,
			'no follower-only resume refusal was sent'
		);
		boom = false;
		await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs: { room: 99 } });
		assert.equal(ran, 66, 'and the connection still works after 65 throws');
		assert.ok(raw.sent.includes('{"type":"resumed"}'), 'acked');
		cleanup(raw);
	} finally {
		console.error = realError;
	}
});

test('a recover hook that throws signals truncation instead of claiming coverage', async () => {
	// THIS is the lane the family client actually uses - it merges recovery into
	// its subscribe-batch rather than sending a standalone resume frame. The
	// `subscribed` ack that ends this lane says the subscription took; without a
	// marker it also implies the gap-fill happened, and the client has no way to
	// tell its history has a hole. The marker is the vocabulary that client
	// already implements: drop the stored per-topic offset and cold-resync.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const realError = console.error;
	console.error = () => {};
	try {
		const raw = openSocket({
			subscribe: () => null,
			resume: () => { throw new Error('backend down'); }
		});
		await send(raw, { type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 5 } });
		const parsed = frames(raw);
		const markerAt = parsed.findIndex(
			(f) => f.topic === '__replay:room' && f.event === 'truncated'
		);
		const ackAt = parsed.findIndex((f) => f.type === 'subscribed');
		assert.ok(markerAt !== -1, 'the client is told this gap-fill is incomplete');
		assert.ok(ackAt !== -1, 'the subscription still took - a failed gap-fill is not a denial');
		assert.ok(markerAt < ackAt, 'and the marker arrives BEFORE the ack that says go live');
		cleanup(raw);
	} finally {
		console.error = realError;
	}
});

test('a recover the client cannot be told about is closed, not acked', async () => {
	// The whole point of the escalation, driven through the lane the family
	// client uses. Everything this socket is handed is refused, so the marker
	// cannot land - and the `subscribed` ack is exactly what must NOT follow,
	// because it is the frame that tells the client to go live.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const realError = console.error;
	console.error = () => {};
	try {
		__setHooks({
			subscribe: () => null,
			resume: () => { throw new Error('backend down'); }
		});
		const raw = rawSocket();
		// Bun's "rejected", which the facade maps to the drop sentinel.
		raw.send = (payload) => { raw.sent.push(payload); return 0; };
		websocketHandlers.open(raw);
		await send(raw, { type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 5 } });
		assert.ok(
			!frames(raw).some((f) => f.type === 'subscribed'),
			'no ack for a gap-fill the client was never told was incomplete'
		);
		assert.equal(raw.closes.length, 1, 'the connection was closed instead');
		assert.equal(raw.closes[0].code, RESUME_INCOMPLETE_CLOSE_CODE);
		cleanup(raw);
	} finally {
		console.error = realError;
	}
});

test('a recover hook that succeeds signals no truncation', async () => {
	// The other half: the marker must not fire on the ordinary path, or a client
	// would cold-resync after every successful gap-fill and the signal would mean
	// nothing.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const raw = openSocket({ subscribe: () => null, resume: () => ({ room: 5 }) });
	await send(raw, { type: 'subscribe', topic: 'room', ref: 1, recover: { offset: 5 } });
	const parsed = frames(raw);
	assert.ok(!parsed.some((f) => f.event === 'truncated'), 'no marker on a clean recover');
	assert.ok(parsed.some((f) => f.type === 'subscribed'), 'and the ack still went out');
	cleanup(raw);
});

test('pipelined recover subscribes are bounded by pending attempts', async () => {
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
	// Recovery holds its pending attempt until the hook and landing settle.
	const sends = [];
	for (let i = 0; i < 4097; i++) {
		sends.push(send(raw, { type: 'subscribe', topic: 'r:' + i, ref: i, recover: { offset: 0 } }));
	}
	await Promise.all(sends);
	assert.equal(peak, 4096);
	const frames = raw.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f));
	const denied = frames.filter((f) => f.type === 'subscribe-denied' && f.reason === 'RATE_LIMITED');
	assert.ok(denied.length >= 1, 'the overflow is refused, not silently serialized');
	assert.equal(resumeBuffers.size, 0, 'no buffer leaked');
	cleanup(raw);
});

test('publish marks the explicit lane only, under the monotone guard', () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	platform.publish('counter', 'e', 1, { seq: true });
	platform.publish('counter', 'e', 2, { seq: true });
	assert.equal(maxAuthoritativeSeq.has('counter'), false, 'the counter lane marks nothing');
	// An explicit authoritative seq arriving late must not move the max back.
	platform.publish('auth', 'e', 1, { seq: 50 });
	platform.publish('auth', 'e', 2, { seq: 40 });
	assert.equal(maxAuthoritativeSeq.get('auth'), 50);
	// The same topic published both ways: the counter publish keeps it recent
	// and leaves the value alone.
	platform.publish('auth', 'e', 3, { seq: true });
	assert.equal(maxAuthoritativeSeq.get('auth'), 50, 'a counter publish clobbers nothing');
	topicSeqs.clear();
	maxAuthoritativeSeq.clear();
});

test('maxAuthoritativeSeq is bounded so unique-topic publishes do not leak', () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	// Far more distinct topics than the cap. A leak would keep every one.
	for (let i = 0; i < 10_050; i++) {
		platform.publish('room:' + i, 'e', i, { seq: i + 1 });
	}
	assert.ok(maxAuthoritativeSeq.size <= 10_000, `bounded, saw ${maxAuthoritativeSeq.size}`);
	// The most recent topics survive; the oldest were evicted.
	assert.ok(maxAuthoritativeSeq.has('room:10049'), 'the newest topic is retained');
	assert.ok(!maxAuthoritativeSeq.has('room:0'), 'the oldest topic was evicted');
	// The counter lane cannot grow this map at all, so the same publish volume
	// on { seq: true } topics costs it nothing to bound.
	maxAuthoritativeSeq.clear();
	for (let i = 0; i < 10_050; i++) {
		platform.publish('c:' + i, 'e', i, { seq: true });
	}
	assert.equal(maxAuthoritativeSeq.size, 0, 'counter publishes leave no entries at all');
	topicSeqs.clear();
	maxAuthoritativeSeq.clear();
});

test('a batch-level seq that is not a seq option is refused before any entry', () => {
	// The counter is what a string used to reach, per entry, on a call whose
	// whole point was one authoritative seq each. Refused up front so the batch
	// is whole or nothing in this direction too, exactly as the numeric
	// batch-level form is.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const ws = collectingWs();
	const cap = beginResumeCapture(['room'], ws);
	const entries = [{ data: { x: 1 } }, { data: { x: 2 } }];
	assert.throws(
		() => platform.publishWireBatch('room', 'moved', entries, statefulCodec(), { seq: '1234' }),
		(err) => err instanceof TypeError && err.message.includes('publish seq must be a positive integer number or bigint'),
		'threw naming the legal spellings'
	);
	flushResumeTopic(cap, 'room', 0);
	assert.deepEqual(ws.sent, [], 'and nothing was published on the way out');
	maxAuthoritativeSeq.clear();
});

test('an entry seq that is not a number is refused by position', () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const entries = [{ data: { x: 1 } }, { data: { x: 2 }, seq: '9' }];
	assert.throws(
		() => platform.publishWireBatch('room', 'moved', entries, statefulCodec()),
		(err) => err instanceof TypeError && err.message.includes('entry 1'),
		'named the entry that carried it'
	);
	maxAuthoritativeSeq.clear();
});

test('an entry seq of null publishes that entry seq-less, overriding the batch', () => {
	// What a nullable authority column reads as, per row: this row has no
	// cluster seq. Inheriting the batch's counter for it would mark the row
	// with a value from another sequence space rather than leaving it unmarked
	// as the column said. Every entry form but `undefined` is an OVERRIDE.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const ws = collectingWs();
	const cap = beginResumeCapture(['room'], ws);
	platform.publishWireBatch(
		'room',
		'moved',
		[{ data: { x: 1 }, seq: null }, { data: { x: 2 } }, { data: { x: 3 }, seq: false }],
		statefulCodec()
	);
	flushResumeTopic(cap, 'room', 0);
	assert.equal(ws.sent.length, 3, 'every entry went out');
	assert.equal(ws.sent[0].includes('"seq"'), false, 'null is no-seq for that entry');
	assert.ok(ws.sent[1].includes('"seq":1'), 'absent still inherits, and the counter starts at 1');
	assert.equal(ws.sent[2].includes('"seq"'), false, 'false says the same thing as null');
	assert.equal(
		maxAuthoritativeSeq.get('room'),
		undefined,
		'and a counter seq marks nothing'
	);
	maxAuthoritativeSeq.clear();
});

test('an entry seq of true draws the counter for that entry alone', () => {
	// The mirror override: a batch publishing seq-less can still give one entry
	// the counter, which is the shape a mixed tick takes.
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const ws = collectingWs();
	const cap = beginResumeCapture(['room'], ws);
	platform.publishWireBatch(
		'room',
		'moved',
		[{ data: { x: 1 } }, { data: { x: 2 }, seq: true }],
		statefulCodec(),
		{ seq: false }
	);
	flushResumeTopic(cap, 'room', 0);
	assert.equal(ws.sent[0].includes('"seq"'), false, 'the batch asked for no seq');
	assert.ok(ws.sent[1].includes('"seq":1'), 'and this entry overrode it with the counter');
	assert.equal(maxAuthoritativeSeq.get('room'), undefined, 'a counter draw marks nothing');
	maxAuthoritativeSeq.clear();
});


test('subscribe batch recovers all allowed topics in one call before their acks', async () => {
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	const calls = [];
	const raw = openSocket({
		subscribeBatch: () => ({ denied: 'FORBIDDEN' }),
		resume: async (_ws, ctx) => {
			calls.push(ctx);
			platform.publish('a', 'live', 1, { seq: 2 });
			platform.publish('b', 'live', 2, { seq: 3 });
			await new Promise(resolve => setImmediate(resolve));
			return { a: 1, b: 2 };
		}
	});
	await send(raw, { type: 'subscribe-batch', topics: ['a', 'b', 'denied'], ref: 41,
		recover: { a: { offset: 1, epoch: 7 }, b: { offset: 2, epoch: 'bad' }, denied: { offset: 0 } } });
	assert.equal(calls.length, 1);
	assert.deepEqual({ ...calls[0].lastSeenSeqs }, { a: 1, b: 2 });
	assert.deepEqual({ ...calls[0].lastSeenEpochs }, { a: 7 });
	assert.equal(Object.getPrototypeOf(calls[0].lastSeenSeqs), Object.prototype);
	assert.equal(Object.getPrototypeOf(calls[0].lastSeenEpochs), Object.prototype);
	assert.equal(calls[0].lastSeenSeqs.hasOwnProperty('a'), true);
	assert.equal(calls[0].lastSeenEpochs.hasOwnProperty('a'), true);
	const out = frames(raw);
	for (const topic of ['a', 'b']) {
		assert.ok(out.findIndex(f => f.topic === topic && f.event === 'live') < out.findIndex(f => f.topic === topic && f.type === 'subscribed'));
	}
	assert.equal(out.find(f => f.topic === 'denied').reason, 'FORBIDDEN');
	assert.equal(resumeBuffers.size, 0);
	cleanup(raw);
});

test('batch recover without a ref refuses history named outside its topics before any hook', async () => {
	let called = 0;
	const raw = openSocket({ subscribe: () => { called++; }, resume: () => { called++; } });
	await send(raw, { type: 'subscribe-batch', topics: ['a'], recover: { outside: { offset: 0 } } });
	assert.equal(called, 0);
	assert.deepEqual(frames(raw).at(-1), { type: 'error', code: 'RECOVER_REQUIRES_REF', topic: null });
	await send(raw, { type: 'subscribe-batch', topics: ['a'], recover: { a: { offset: 'bad' } } });
	assert.equal(called, 1);
	cleanup(raw);
});

test('batch recovery rechecks revocation after authorization and never serves denied history', async () => {
	let resumed = false;
	const raw = openSocket({ subscribeBatch: (ws) => { platform.unsubscribe(ws, 'revoked'); return {}; },
		resume: () => { resumed = true; } });
	await send(raw, { type: 'subscribe-batch', topics: ['revoked'], ref: 3, recover: { revoked: { offset: 0 } } });
	assert.equal(resumed, false);
	assert.equal(frames(raw).at(-1).reason, 'FORBIDDEN');
	assert.equal(resumeBuffers.size, 0);
	cleanup(raw);
});

test('batch recovery discards every capture if the socket closes inside resume', async () => {
	const raw = openSocket({ subscribe: () => null, resume: () => { raw.readyState = 3; } });
	await send(raw, { type: 'subscribe-batch', topics: ['a', 'b'], ref: 4, recover: { a: { offset: 0 }, b: { offset: 0 } } });
	assert.equal(resumeBuffers.size, 0);
	cleanup(raw);
});
