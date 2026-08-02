import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	isValidResumeEpoch,
	isValidResumeSeq,
	isValidResumeSessionId
} from '../../src/runtime/utils/resume-input.js';

// The two client-supplied resume quantities. These rules are shared by both
// lanes that feed the app's resume hook (the `resume` frame and a `subscribe`
// carrying `recover`), which is the whole reason they live in one module: the
// lanes disagreed once, so the same client state produced two different
// gap-fill decisions depending on which frame carried it.
//
// The direction that matters most here is OVER-strictness. Refusing a value
// does not clamp it, it drops the topic from the map the hook gap-fills from,
// and the client is still told to go live - so a rule that is too tight
// manufactures the silent gap the whole barrier exists to prevent.

test('a watermark is any finite, non-negative number', () => {
	assert.equal(isValidResumeSeq(0), true, '0 is "seen nothing yet"');
	assert.equal(isValidResumeSeq(1), true);
	assert.equal(isValidResumeSeq(-0), true, '-0 === 0 and stringifies as "0"');

	// Unrepresentable, not merely unusual: the frame varint encodes -1 and
	// parses it back as 127, so a negative watermark names a frame no client
	// can be holding.
	assert.equal(isValidResumeSeq(-1), false);
	assert.equal(isValidResumeSeq(-0.5), false);
	assert.equal(isValidResumeSeq(Infinity), false);
	assert.equal(isValidResumeSeq(-Infinity), false);
	assert.equal(isValidResumeSeq(NaN), false);
});

test('a watermark the server itself issued round-trips, however large or fractional', () => {
	// The explicit `{ seq: <number> }` lane carries the app's own cursor, and it
	// is the cluster-authoritative one - the only one the resume floor dedups
	// against. Apps relay event-store cursors through it. Refusing one here
	// would drop its topic from the hook's map and then ack `resumed` anyway: a
	// silent gap.
	assert.equal(isValidResumeSeq(Number.MAX_SAFE_INTEGER), true);
	assert.equal(isValidResumeSeq(Number.MAX_SAFE_INTEGER + 1), true, 'a snowflake id');
	assert.equal(isValidResumeSeq(9007199254740992), true, 'a Kafka offset past 2^53');
	assert.equal(isValidResumeSeq(1e308), true, 'absurd, but the app owns this space');
	// Accepted here even though the PUBLISH side now refuses it (publish-seq.js
	// requires an integer). The asymmetry is deliberate: this rule governs what
	// a client may be holding - from an older build, or another node in a
	// cluster - and tightening it to match would drop those topics and
	// manufacture the gap above. Refusing on publish THROWS, at the app that
	// chose the value; refusing here would cost a client its history.
	assert.equal(isValidResumeSeq(2.5), true, 'an app cursor need not be an integer');
});

test('an epoch is a non-negative integer, unbounded above', () => {
	// Unlike a watermark, an epoch has no app-supplied lane: it is only ever
	// minted by the server (a random uint32) and echoed back, so requiring an
	// integer here cannot refuse a value the server issued. No ceiling, since
	// an app running its own cluster epoch scheme may number past 2^32, and it
	// is only ever compared for equality.
	assert.equal(isValidResumeEpoch(0), true);
	assert.equal(isValidResumeEpoch(0xffffffff), true, 'the top of the uint32 range');
	assert.equal(isValidResumeEpoch(2 ** 40), true, 'an app-supplied cluster epoch');

	assert.equal(isValidResumeEpoch(-1), false, 'the server never issues a negative epoch');
	assert.equal(isValidResumeEpoch(2.5), false, 'nor a fractional one');
	assert.equal(isValidResumeEpoch(Infinity), false);
	assert.equal(isValidResumeEpoch(NaN), false);
});

test('neither rule admits a non-number, however number-like', () => {
	for (const v of ['5', '', null, undefined, {}, [], [5], true, false, 5n]) {
		assert.equal(isValidResumeSeq(v), false, `seq refused: ${String(v)}`);
		assert.equal(isValidResumeEpoch(v), false, `epoch refused: ${String(v)}`);
	}
});

// The third client-supplied quantity on this lane. Unlike the two above it is
// opaque to the adapter - it is handed to the app's hook, which queries a
// backend with it - so the rules are a bound and a character scan, not a shape.

test('a session id is a bounded string of printable ASCII', () => {
	assert.equal(isValidResumeSessionId('prev-session'), true);
	assert.equal(
		isValidResumeSessionId('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
		true,
		'the shape the server itself mints'
	);
	assert.equal(isValidResumeSessionId('x'.repeat(128)), true, 'the cap itself is allowed');
	assert.equal(isValidResumeSessionId('x'.repeat(129)), false, 'one past it is not');
	assert.equal(isValidResumeSessionId(''), false, 'an empty id identifies no session');

	// The scan, not the length, is what keeps a crafted value out of the app's
	// backend query and out of whatever logs it.
	assert.equal(isValidResumeSessionId('a' + String.fromCharCode(0) + 'b'), false, 'NUL');
	assert.equal(isValidResumeSessionId('a\nb'), false, 'newline');
	assert.equal(isValidResumeSessionId('a"b'), false, 'quote');
	assert.equal(isValidResumeSessionId('a\\b'), false, 'backslash');
});

test('a session id is printable ASCII, which is a stricter bound than "no control byte"', () => {
	// Barring `< 32` alone is NOT the same bound, and the difference is the part
	// that matters: each of these survives a control-byte scan and can still
	// corrupt a log line or a rendered admin table. Built from code points so
	// none of them appears literally in this file.
	assert.equal(isValidResumeSessionId('sess-' + String.fromCharCode(0x7f)), false, 'DEL');
	assert.equal(isValidResumeSessionId('sess-' + String.fromCharCode(0x85)), false, 'NEL, a C1 control');
	assert.equal(isValidResumeSessionId('sess-' + String.fromCharCode(0x202e)), false, 'the bidi override');
	assert.equal(
		isValidResumeSessionId('sess-' + String.fromCharCode(0x2028)),
		false,
		'the line separator JSON.stringify emits RAW'
	);
	assert.equal(isValidResumeSessionId('sess-' + String.fromCharCode(0xfeff)), false, 'the BOM');
	assert.equal(isValidResumeSessionId('sess-' + String.fromCharCode(0x00e9)), false, 'and ordinary non-ASCII');

	// Printable ASCII is also what makes the 128 bound unambiguous: a character
	// IS a byte here, so no multi-byte id can argue its way past it.
	assert.equal(Buffer.byteLength('x'.repeat(128)), 128);
});

test('a session id must be a string', () => {
	for (const v of [null, undefined, 5, {}, [], true, 5n]) {
		assert.equal(isValidResumeSessionId(v), false, `refused: ${String(v)}`);
	}
});
