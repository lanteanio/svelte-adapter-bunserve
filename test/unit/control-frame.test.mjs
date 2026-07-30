import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CONTROL_FLOOD_CLOSE_CODE,
	CONTROL_FRAME_LIMIT,
	MAX_BATCH_TOPICS,
	batchTooLargeFrame,
	controlFloodFrame,
	controlFrameTooLargeFrame,
	isConsumedControlType,
	looksLikeControlFrame
} from '../../src/runtime/utils/control-frame.js';

test('the types the demux consumes are recognized', () => {
	assert.equal(isConsumedControlType('{"type":"subscribe","topic":"t"}'), true);
	assert.equal(isConsumedControlType('{"type":"unsubscribe","topic":"t"}'), true);
	assert.equal(isConsumedControlType('{"type":"subscribe-batch","topics":[]}'), true);
});

test('an application frame beginning {"ty is NOT claimed', () => {
	// The whole point. `{"type": ...}` is the most common app envelope
	// convention there is, so treating the cheap prefix test as proof would
	// destroy any large app message that happens to match and answer it with a
	// protocol error the app never asked for.
	assert.equal(isConsumedControlType('{"type":"chat-message","body":"hello"}'), false);
	assert.equal(isConsumedControlType('{"type":"cursor","x":1}'), false);
	assert.equal(isConsumedControlType('{"typing":true}'), false);
});

test('whitespace variants are still recognized', () => {
	assert.equal(isConsumedControlType('{ "type" : "subscribe" }'), true);
	assert.equal(isConsumedControlType('\n{"type":"subscribe"}'), true);
});

test('a control type hidden past the scanned prefix is not claimed', () => {
	// Bounded scan: refusing to parse attacker-sized input is the reason the
	// ceiling exists, so a frame that buries its type beyond the window is
	// treated as not-ours and handed to the app rather than destroyed.
	const buried = '{"padding":"' + 'x'.repeat(200) + '","type":"subscribe"}';
	assert.equal(isConsumedControlType(buried), false);
});

test('a bare prefix without a complete type value is not claimed', () => {
	assert.equal(isConsumedControlType('{"type":'), false);
	assert.equal(isConsumedControlType('{"type":"'), false);
	assert.equal(isConsumedControlType(''), false);
});

test('the refusal carries the field names the family client gates on', () => {
	// The client checks `typeof msg.code === 'string'` and discards the frame
	// otherwise, so renaming `code` silently defeats the frame's entire
	// purpose - the developer whose control frame overflowed gets nothing.
	const frame = JSON.parse(controlFrameTooLargeFrame(9000));
	assert.equal(frame.type, 'error');
	assert.equal(frame.code, 'CONTROL_FRAME_TOO_LARGE');
	assert.equal(typeof frame.code, 'string');
	assert.equal(frame.size, 9000);
	assert.equal(frame.limit, CONTROL_FRAME_LIMIT);
});

test('the refusal is valid JSON for any size', () => {
	for (const size of [0, 1, 8192, 1048576]) {
		assert.doesNotThrow(() => JSON.parse(controlFrameTooLargeFrame(size)));
	}
});

test('the ceiling is a byte count, not a character count', () => {
	// Enforcing on String.length would admit up to four times this much
	// attacker text into JSON.parse, and the reported size would be measured on
	// a different dimension than the one that rejected it.
	assert.equal(CONTROL_FRAME_LIMIT, 8192);
	const threeByteChar = String.fromCharCode(0x4e00); // CJK, 3 bytes in UTF-8
	const text = threeByteChar.repeat(3000);
	assert.equal(text.length, 3000);
	assert.ok(Buffer.byteLength(text) > CONTROL_FRAME_LIMIT, 'under the char count, over the byte count');
});

test('looksLikeControlFrame keeps the compact fast path', () => {
	assert.equal(looksLikeControlFrame('{"type":"subscribe","topic":"a"}'), true);
	assert.equal(looksLikeControlFrame('{"topic":"a","event":"x"}'), false, 'data envelope');
});

test('looksLikeControlFrame tolerates whitespace, like isConsumedControlType', () => {
	// The two recognisers disagreeing about the same frame is the defect: a
	// pretty-printing client's subscribe was forwarded to the app as ordinary
	// data and never subscribed, silently.
	const pretty = '{ "type": "subscribe", "topic": "a" }';
	assert.equal(looksLikeControlFrame(pretty), true);
	assert.equal(isConsumedControlType(pretty), true, 'the two agree');
	assert.equal(looksLikeControlFrame('\n\t{"type":"subscribe"}'), true);
});

test('looksLikeControlFrame does not claim leading-whitespace data frames', () => {
	assert.equal(looksLikeControlFrame('  {"topic":"a"}'), false);
	assert.equal(looksLikeControlFrame('   '), false);
	assert.equal(looksLikeControlFrame(''), false);
});

test('both recognisers agree that the type key must come FIRST', () => {
	// JSON defines no key order, so this is a protocol requirement rather than
	// an accident of JSON.stringify - and it is one because recognising a
	// reordered key costs a scan on the path every inbound frame takes
	// (measured 14-25 ns/frame against 4.6 ns for the character compare). What
	// has to hold is that the cheap test and the oversize test AGREE, so the
	// demux and the refusal never disagree about the same frame.
	const reordered = '{"ref":1,"type":"subscribe","topic":"a"}';
	assert.equal(looksLikeControlFrame(reordered), false);
	assert.equal(isConsumedControlType(reordered), false, 'and the two agree');
});

test('a deeply buried type key is claimed by neither', () => {
	const buried = '{"topic":"' + 'x'.repeat(200) + '","type":"subscribe"}';
	assert.equal(looksLikeControlFrame(buried), false);
	assert.equal(isConsumedControlType(buried), false);
});

test('looksLikeControlFrame still rejects data envelopes and non-objects', () => {
	assert.equal(looksLikeControlFrame('{"topic":"a","event":"x"}'), false);
	assert.equal(looksLikeControlFrame('["type"]'), false, 'must start with {');
	assert.equal(looksLikeControlFrame(''), false);
});

test('the two recognisers agree on every whitespace shape', () => {
	// They used to disagree on seven constructible inputs, two of them valid
	// JSON - most importantly JSON.stringify(frame, null, 8), whose nine spaces
	// fell outside the cheap test's window while the oversize test still
	// accepted it. Same bound, same character class, both bounded now.
	const nbsp = String.fromCharCode(0x00a0);
	const bom = String.fromCharCode(0xfeff);
	const inputs = [
		JSON.stringify({ type: 'subscribe', topic: 'a' }, null, 8),
		JSON.stringify({ type: 'subscribe', topic: 'a' }, null, 4),
		'         {"type":"subscribe"}',
		'{         "type":"subscribe"}',
		'{' + ' '.repeat(40) + '"type":"subscribe"}',
		nbsp + '{"type":"subscribe"}',
		bom + '{"type":"subscribe"}',
		'{\f"type":"subscribe"}',
		'{\v"type":"subscribe"}',
		'{"type":"subscribe"}',
		'{ "type" : "subscribe" }'
	];
	for (const input of inputs) {
		assert.equal(
			looksLikeControlFrame(input),
			isConsumedControlType(input),
			`disagreement on ${JSON.stringify(input.slice(0, 30))}`
		);
	}
});

test('a pretty-printed control frame is recognised', () => {
	const pretty = JSON.stringify({ type: 'subscribe', topic: 'a' }, null, 8);
	assert.equal(looksLikeControlFrame(pretty), true);
	assert.equal(isConsumedControlType(pretty), true);
});

test('the control-flood refusal carries the code the client gates on', () => {
	// Same `code` key as the oversize refusal: the family client discards a
	// frame whose `code` is not a string, so a differently-shaped refusal is
	// one the developer never sees.
	assert.deepEqual(JSON.parse(controlFloodFrame(4 * 1024 * 1024)), {
		type: 'error',
		code: 'CONTROL_FLOOD',
		limit: 4 * 1024 * 1024
	});
	assert.ok(controlFloodFrame(1).startsWith('{"type":"'));
});

test('an oversized batch is refused with one frame that answers for no topic', () => {
	// Deliberately NOT a subscribe-denied: a denial answers for one topic and
	// the family client keys its denial store by topic name, so the two earlier
	// attempts to say "the whole batch" in a denial shape - both carrying
	// topic: null - were discarded without a trace. `code` is the field those
	// clients gate on for frames that answer for no topic.
	assert.deepEqual(JSON.parse(batchTooLargeFrame(4008)), {
		type: 'error',
		code: 'BATCH_TOO_LARGE',
		limit: 256,
		size: 4008
	});
	assert.ok(!batchTooLargeFrame(300).includes('"topic"'));
	assert.ok(batchTooLargeFrame(300).startsWith('{"type":"'));
});

test('the batch limit stays under what the family clients chunk to', () => {
	// They chunk at 200 topics and 8000 bytes explicitly to stay below this and
	// the parse ceiling, so the refusal above is unreachable for them. Lowering
	// this below 200 would start refusing ordinary reconnects.
	assert.equal(MAX_BATCH_TOPICS, 256);
	assert.ok(MAX_BATCH_TOPICS > 200);
});

test('the control-flood cut is a throttle code, never a terminal one', () => {
	// 1008 is in both family clients' TERMINAL_CLOSE_CODES: cutting with it
	// stops the page reconnecting for good, over a budget an operator can
	// raise. 4429 is their throttle code and reconnects with backoff.
	assert.equal(CONTROL_FLOOD_CLOSE_CODE, 4429);
	assert.notEqual(CONTROL_FLOOD_CLOSE_CODE, 1008);
	// In the private range, so it can never collide with a protocol code.
	assert.ok(CONTROL_FLOOD_CLOSE_CODE >= 4000 && CONTROL_FLOOD_CLOSE_CODE <= 4999);
});
