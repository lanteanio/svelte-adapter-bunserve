import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explicitSeqValue, isValidPublishSeq } from '../../src/runtime/utils/publish-seq.js';
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

test('the ceiling is the safe-integer range, which is what the wire carries faithfully', () => {
	assert.equal(isValidPublishSeq(2 ** 31), true);
	assert.equal(isValidPublishSeq(2 ** 32), true);
	assert.equal(isValidPublishSeq(Number.MAX_SAFE_INTEGER), true);
	// The varint carries any magnitude, but the varint is not the whole wire.
	// The seq space is IEEE-754 double - the JSON envelope, the frame's slot,
	// the client's watermark reader - and above 2^53 a double stops having a
	// neighbour at distance one, so ids a caller means to be different land on
	// one value. Watermarks advance on a STRICT greater-than, so the second
	// frame never advances the client's and resume dedup goes ambiguous.
	assert.equal(isValidPublishSeq(2 ** 53), false, 'a Kafka offset past 2^53 collides');
	assert.equal(isValidPublishSeq(2 ** 53 + 2), false);
	assert.equal(isValidPublishSeq(1e308), false);
});

test('the rule is the range, not exact representability', () => {
	// Exact representability looks like the natural test and fails on both
	// ends. 2^60 is an exact double and still reaches a subscriber as
	// 1152921504606847000, because the JSON envelope serializes through
	// String(double) - the shortest round-tripping decimal, not the integer.
	assert.equal(String(2 ** 60), '1152921504606847000', 'the envelope emits a number nobody issued');
	// And just above 2^53 the gap is two, so an exactness test would take a
	// caller's EVEN ids and refuse the ODD ones - a contract failing half a
	// stream by parity is worse than one that refuses the range outright.
	assert.equal(isValidPublishSeq(2 ** 53), false, 'even, exactly representable, still refused');
	assert.equal(isValidPublishSeq(2 ** 53 + 1), false, 'odd, not representable, refused the same');
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
	for (const v of [1, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
		assert.equal(isValidPublishSeq(v), true, `${v} publishable`);
		assert.equal(isValidResumeSeq(v), true, `${v} must round-trip`);
	}
	// The inbound rule stays wide where the outbound one narrowed: a client may
	// legitimately be holding a watermark from a build that stamped past the
	// range, and refusing it would drop the topic from the gap-fill map.
	assert.equal(isValidPublishSeq(2 ** 53), false, 'no longer stamped');
	assert.equal(isValidResumeSeq(2 ** 53), true, 'but still accepted from a client holding one');
});

test('bigint is the second spelling of one authority, held to the same range', () => {
	// A caller reading an offset out of a store that hands back BigInt no longer
	// converts at the call site, which is where the silent rounding happened.
	assert.equal(explicitSeqValue(1n), 1);
	assert.equal(explicitSeqValue(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
	assert.equal(explicitSeqValue(42), 42, 'and the number spelling answers identically');
	// One rule about the VALUE, so the two spellings agree on refusal too.
	assert.throws(() => explicitSeqValue(2n ** 53n), /safe-integer range/);
	assert.throws(() => explicitSeqValue(2 ** 53), /safe-integer range/);
	assert.throws(() => explicitSeqValue(0n), /publish seq must be/);
	assert.throws(() => explicitSeqValue(-1n), /publish seq must be/);
	// `>= 1n` is a VALUE comparison, so a bare one would run StringToBigInt and
	// let '7' through this arm. The typeof guard is what stops that.
	assert.throws(() => explicitSeqValue('7'), /publish seq must be/);
});

test('a magnitude fault and a spelling fault get different messages', () => {
	// The value IS a positive integer, so the legal-forms message would send a
	// caller looking for a spelling mistake that is not there.
	assert.throws(() => explicitSeqValue(2 ** 53), (err) => {
		assert.match(err.message, /exceeds the wire's safe-integer range/);
		assert.match(err.message, /do not truncate/, 'and says what to do instead');
		assert.doesNotMatch(err.message, /must be a positive integer number or bigint/);
		return true;
	});
	assert.throws(() => explicitSeqValue('42'), (err) => {
		assert.match(err.message, /must be a positive integer number or bigint/);
		return true;
	});
});
