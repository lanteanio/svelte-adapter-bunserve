import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isValidResumeEpoch, isValidResumeSeq } from '../../src/runtime/utils/resume-input.js';

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

	assert.equal(isValidResumeSeq(-1), false, 'the wire has no negative seq');
	assert.equal(isValidResumeSeq(-0.5), false);
	assert.equal(isValidResumeSeq(Infinity), false);
	assert.equal(isValidResumeSeq(-Infinity), false);
	assert.equal(isValidResumeSeq(NaN), false);
});

test('a watermark the server itself issued round-trips, however large or fractional', () => {
	// stampSeq passes an explicit `{ seq: <number> }` through VERBATIM, and
	// that is the cluster-authoritative lane - the only one the resume floor
	// dedups against. Apps relay event-store cursors through it, so these are
	// values this server puts on the wire. Refusing one here would drop its
	// topic from the hook's map and then ack `resumed` anyway: a silent gap.
	assert.equal(isValidResumeSeq(Number.MAX_SAFE_INTEGER), true);
	assert.equal(isValidResumeSeq(Number.MAX_SAFE_INTEGER + 1), true, 'a snowflake id');
	assert.equal(isValidResumeSeq(9007199254740992), true, 'a Kafka offset past 2^53');
	assert.equal(isValidResumeSeq(1e308), true, 'absurd, but the app owns this space');
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
