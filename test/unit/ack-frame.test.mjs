import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	isEchoableRef,
	subscribeDeniedFrame,
	subscribedFrame,
	unsubscribeDeniedFrame,
	unsubscribedFrame
} from '../../src/runtime/utils/ack-frame.js';

/** Every ack the demux can emit, built with the same topic and ref. */
function everyAck(topic, ref) {
	return [
		['subscribed', subscribedFrame(topic, ref, 7)],
		['subscribe-denied', subscribeDeniedFrame(topic, ref, 'FORBIDDEN')],
		['unsubscribed', unsubscribedFrame(topic, ref)],
		['unsubscribe-denied', unsubscribeDeniedFrame(topic, ref, 'INVALID_TOPIC')]
	];
}

test('every ack names the topic the client sent', () => {
	// The defect this pins: a frame that does not carry the topic is discarded
	// by the family client (`typeof msg.topic === 'string'`), so the server
	// refuses and the client never learns. It shipped twice - once as a batch
	// summary, once as the batch OVERFLOW summary - and both times it was
	// silent on both sides.
	for (const [type, frame] of everyAck('room:1', 4)) {
		const parsed = JSON.parse(frame);
		assert.equal(parsed.type, type);
		assert.equal(parsed.topic, 'room:1', `${type} lost its topic`);
		assert.equal(parsed.ref, 4);
	}
});

test('every ack puts type first, which the recognisers anchor on', () => {
	for (const [type, frame] of everyAck('room:1', 4)) {
		assert.equal(Object.keys(JSON.parse(frame))[0], 'type', `${type} reordered its keys`);
		assert.ok(frame.startsWith('{"type":"'), `${type} is not recognisable by prefix`);
	}
});

test('a non-string topic is echoed as sent, not normalised', () => {
	// The client correlates the denial against what it put on the wire.
	// String(topic) would answer "[object Object]", which matches nothing it
	// is holding, and the entry stays pending forever.
	assert.deepEqual(JSON.parse(subscribeDeniedFrame({ a: 1 }, 2, 'INVALID_TOPIC')), {
		type: 'subscribe-denied',
		topic: { a: 1 },
		ref: 2,
		reason: 'INVALID_TOPIC'
	});
	assert.deepEqual(JSON.parse(subscribeDeniedFrame(17, 2, 'INVALID_TOPIC')).topic, 17);
});

test('a string ref survives as a string', () => {
	// Refs are echoed, not parsed: a client keying a pending map on "a1" must
	// get "a1" back, not 0 or null.
	assert.equal(JSON.parse(subscribedFrame('room:1', 'a1', 3)).ref, 'a1');
});

test('a topic carrying JSON metacharacters cannot break the frame', () => {
	const hostile = 'room:"},{"type":"subscribed","topic":"admin';
	const parsed = JSON.parse(subscribeDeniedFrame(hostile, 1, 'INVALID_TOPIC'));
	assert.equal(parsed.topic, hostile);
	assert.equal(parsed.type, 'subscribe-denied');
});

test('subscribed carries the epoch the client resumes against', () => {
	assert.equal(JSON.parse(subscribedFrame('room:1', 1, 42)).epoch, 42);
});

// U+FFFD: three UTF-8 bytes in one UTF-16 unit. Built rather than written
// literally so this file stays ASCII, which the repo sweep enforces.
const WIDE = String.fromCharCode(0xfffd);

test('a ref is capped in BYTES, not UTF-16 units', () => {
	// The cap protects a budget charged in bytes. 128 U+FFFD characters are
	// length 128 and 384 bytes, so a length-based cap let three times the
	// intended ref into every echoed frame - multiplied by the batch size,
	// because a batch is answered per entry.
	const wide = WIDE.repeat(128);
	assert.equal(wide.length, 128);
	assert.equal(Buffer.byteLength(wide), 384);
	assert.equal(isEchoableRef(wide), false);
	// 42 wide characters are 126 bytes and fit; 43 are 129 and do not.
	assert.equal(isEchoableRef(WIDE.repeat(42)), true);
	assert.equal(isEchoableRef(WIDE.repeat(43)), false);
});

test('the ref fast path agrees with the measured path at the boundary', () => {
	// ASCII: 128 bytes fits, 129 does not. The short-string shortcut must not
	// let this disagree with Buffer.byteLength.
	assert.equal(isEchoableRef('a'.repeat(128)), true);
	assert.equal(isEchoableRef('a'.repeat(129)), false);
	for (let n = 0; n <= 200; n++) {
		const ascii = 'a'.repeat(n);
		assert.equal(isEchoableRef(ascii), Buffer.byteLength(ascii) <= 128, `ascii ${n}`);
		const wide = WIDE.repeat(n);
		assert.equal(isEchoableRef(wide), Buffer.byteLength(wide) <= 128, `wide ${n}`);
	}
});

test('numbers always round-trip and other shapes are treated as absent', () => {
	assert.equal(isEchoableRef(0), true);
	assert.equal(isEchoableRef(-1), true);
	assert.equal(isEchoableRef(1e308), true);
	assert.equal(isEchoableRef(undefined), false);
	assert.equal(isEchoableRef(null), false);
	assert.equal(isEchoableRef({}), false);
	assert.equal(isEchoableRef(['a']), false);
	assert.equal(isEchoableRef(true), false);
});

test('a non-finite ref is not echoable', () => {
	// JSON.stringify writes Infinity and NaN as `null`, which is this adapter's
	// own spelling for "no ref", so echoing one hands the client an ack it
	// cannot tell apart from an unsolicited frame. `1e999` parses to Infinity,
	// so an ordinary-looking literal reaches this.
	assert.equal(isEchoableRef(Infinity), false);
	assert.equal(isEchoableRef(-Infinity), false);
	assert.equal(isEchoableRef(NaN), false);
	assert.equal(isEchoableRef(JSON.parse('{"ref":1e999}').ref), false);
	// Ordinary refs are unaffected, including the falsy one.
	assert.equal(isEchoableRef(0), true);
	assert.equal(isEchoableRef(-1), true);
	assert.equal(isEchoableRef(1.5), true);
	assert.equal(isEchoableRef(Number.MAX_SAFE_INTEGER), true);
});
