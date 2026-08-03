import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isValidPublishSeq } from '../../src/runtime/utils/publish-seq.js';
import { isValidResumeSeq } from '../../src/runtime/utils/resume-input.js';

// The PUBLISH side of the seq contract: what this server is willing to put on
// the wire. Deliberately stricter than the client side in resume-input.js,
// because the two answer different questions - see the pairing test at the end.

test('a publish seq is an integer of at least 1', () => {
	assert.equal(isValidPublishSeq(1), true, 'the first seq the counter lane issues');
	assert.equal(isValidPublishSeq(2), true);
});

test('0 is refused: the binary frame reserves it as the "no seq" sentinel', () => {
	// Not symmetry with the negative rule, and not tidiness. sendWire stamps 0
	// to MEAN "no seq", so a stamped 0 vanishes for binary subscribers while the
	// JSON envelope carries "seq":0 - the two halves of one topic then disagree
	// about whether the event had a seq at all. A 0-based external source must
	// offset by 1; the counter lane and every shipped authority are 1-based.
	assert.equal(isValidPublishSeq(0), false);
	assert.equal(isValidPublishSeq(-0), false, '-0 === 0, and it is the same sentinel');
});

test('no upper bound: the frame varint carries any magnitude exactly', () => {
	// The carrier itself is pinned in wire.test.mjs, which round-trips these
	// same magnitudes through the varint the frame's seq rides on. A ceiling
	// here would refuse cursors the wire handles perfectly well, and apps
	// relay event-store cursors through this lane as a matter of course.
	assert.equal(isValidPublishSeq(2 ** 31), true);
	assert.equal(isValidPublishSeq(2 ** 32), true);
	assert.equal(isValidPublishSeq(Number.MAX_SAFE_INTEGER), true);
	assert.equal(isValidPublishSeq(2 ** 53), true, 'a Kafka offset past 2^53');
	assert.equal(isValidPublishSeq(1e308), true, 'absurd, but it round-trips exactly');
});

test('a negative seq is refused: the varint parses -1 back as 127', () => {
	// Not a tidiness rule. A negative seq is unrepresentable on the binary wire,
	// so a capable client and a JSON-only client on the same topic would read
	// two different sequence numbers for the same event.
	assert.equal(isValidPublishSeq(-1), false);
	assert.equal(isValidPublishSeq(-0.5), false);
	assert.equal(isValidPublishSeq(Number.MIN_SAFE_INTEGER), false);
});

test('a fractional seq is refused: the two wires would disagree', () => {
	// The varint truncates it; JSON.stringify does not. 1.5 would reach the
	// binary client as 1 and the JSON client as 1.5.
	assert.equal(isValidPublishSeq(1.5), false);
	assert.equal(isValidPublishSeq(2.5), false);
});

test('nothing that is not a number, and no non-finite number', () => {
	assert.equal(isValidPublishSeq(Infinity), false);
	assert.equal(isValidPublishSeq(-Infinity), false);
	assert.equal(isValidPublishSeq(NaN), false);
	assert.equal(isValidPublishSeq('1'), false, 'no coercion: a string is not a seq');
	assert.equal(isValidPublishSeq(true), false, '{ seq: true } is the counter lane, not a value');
	assert.equal(isValidPublishSeq(null), false);
	assert.equal(isValidPublishSeq(undefined), false);
	assert.equal(isValidPublishSeq({}), false);
});

test('the publish rule is strictly narrower than the client rule, on purpose', () => {
	// The asymmetry is load-bearing, so it is pinned rather than left to drift.
	// Publish decides what goes ON the wire and may be exact; the client rule
	// decides what a peer may be HOLDING - from an older build or another node -
	// and an over-strict rule there drops the topic from the gap-fill map and
	// acks `resumed` anyway, manufacturing the silent gap the barrier prevents.
	assert.equal(isValidPublishSeq(2.5), false, 'refused on the way out');
	assert.equal(isValidResumeSeq(2.5), true, 'but accepted on the way back in');
	// 0 is the sharper case: never emitted, but a client presenting it means
	// "seen nothing yet", which is a legitimate thing to be holding.
	assert.equal(isValidPublishSeq(0), false, 'never stamped');
	assert.equal(isValidResumeSeq(0), true, 'but "seen nothing yet" is a real watermark');
	// Everything publishable is acceptable on the way back: a value this server
	// stamped must always round-trip, or it could refuse its own watermark.
	for (const v of [1, 2 ** 32, Number.MAX_SAFE_INTEGER, 2 ** 53, 1e308]) {
		assert.equal(isValidPublishSeq(v), true, `${v} publishable`);
		assert.equal(isValidResumeSeq(v), true, `${v} must round-trip`);
	}
});
