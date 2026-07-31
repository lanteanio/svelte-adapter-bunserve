import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isValidResumeEpoch, isValidResumeSeq } from '../../src/runtime/utils/resume-input.js';

// The two client-supplied resume quantities. These rules are shared by both
// lanes that feed the app's resume hook (the `resume` frame and a `subscribe`
// carrying `recover`), which is the whole reason they live in one module: the
// lanes disagreed once, so the same client state produced two different
// gap-fill decisions depending on which frame carried it.

test('a watermark is a non-negative safe integer', () => {
	assert.equal(isValidResumeSeq(0), true, '0 is "seen nothing yet"');
	assert.equal(isValidResumeSeq(1), true);
	assert.equal(isValidResumeSeq(Number.MAX_SAFE_INTEGER), true);
	assert.equal(isValidResumeSeq(-0), true, '-0 === 0 and stringifies as "0"');

	assert.equal(isValidResumeSeq(-1), false, 'the server never issues a negative seq');
	assert.equal(isValidResumeSeq(-0.5), false);
	assert.equal(isValidResumeSeq(2.5), false, 'seqs are counter-stamped integers');
});

test('a watermark past the safe-integer range is refused', () => {
	// Not a style rule. flushResumeTopic drops every held frame whose seq is
	// <= floor, so a watermark of 1e308 echoed back by a hook as its covered
	// seq silently discards the entire cutover window - the exact silent gap
	// the barrier exists to prevent. Past 2^53 a hook's own `seq + 1` also
	// stops being exact.
	assert.equal(isValidResumeSeq(1e308), false);
	assert.equal(isValidResumeSeq(Number.MAX_SAFE_INTEGER + 1), false);
	assert.equal(isValidResumeSeq(Infinity), false);
	assert.equal(isValidResumeSeq(-Infinity), false);
	assert.equal(isValidResumeSeq(NaN), false);
});

test('an epoch is a non-negative integer, unbounded above', () => {
	// processEpoch() is a random uint32, but an app running its own
	// cluster-wide epoch scheme may number above 2^32 - and the value is only
	// ever compared for equality, never used in arithmetic a large magnitude
	// would corrupt. So: no ceiling.
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
