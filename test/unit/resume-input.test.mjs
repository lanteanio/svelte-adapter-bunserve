import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	isValidResumeEpoch,
	isValidResumeSeq
} from '../../src/runtime/utils/resume-input.js';

// Subscribe recover values retain client cursor ranges.

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
