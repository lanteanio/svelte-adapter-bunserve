import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	mapSendResult,
	publishReached,
	SEND_BACKPRESSURE,
	SEND_SUCCESS,
	SEND_DROPPED
} from '../../src/runtime/utils/send-result.js';

// The three values the probe actually observed from Bun (see
// probe/bun-api-facts.report.md, `send-return-codes`): 4 and 64 for accepted
// text/binary sends, -1 once the socket applied backpressure, 0 past the limit
// and on a closed socket.

test('bytes accepted maps to success', () => {
	assert.equal(mapSendResult(4), SEND_SUCCESS);
	assert.equal(mapSendResult(64), SEND_SUCCESS);
	assert.equal(mapSendResult(1048576), SEND_SUCCESS);
});

test('-1 maps to enqueued-behind-backpressure, NOT dropped', () => {
	// Misreading this as a drop would falsely degrade binary subscribers to
	// JSON under merely transient pressure.
	assert.equal(mapSendResult(-1), SEND_BACKPRESSURE);
	assert.notEqual(mapSendResult(-1), SEND_DROPPED);
});

test('0 maps to dropped, NOT enqueued', () => {
	// Misreading this as enqueued silently loses frames.
	assert.equal(mapSendResult(0), SEND_DROPPED);
	assert.notEqual(mapSendResult(0), SEND_BACKPRESSURE);
});

test('the tri-state values match the uWS sentinels the platform keys on', () => {
	assert.equal(SEND_BACKPRESSURE, 0);
	assert.equal(SEND_SUCCESS, 1);
	assert.equal(SEND_DROPPED, 2);
});

test('undocumented negative codes take the conservative drop path', () => {
	// Only -1 is documented and observed. An unknown code must never claim
	// "will deliver": an over-eager drop self-heals (degrade + resume
	// invalidation), a false delivery loses data silently.
	assert.equal(mapSendResult(-2), SEND_DROPPED);
	assert.equal(mapSendResult(-1000), SEND_DROPPED);
});

test('non-numeric results are dropped rather than trusted', () => {
	assert.equal(mapSendResult(undefined), SEND_DROPPED);
	assert.equal(mapSendResult(null), SEND_DROPPED);
	assert.equal(mapSendResult(NaN), SEND_DROPPED);
	assert.equal(mapSendResult('4'), SEND_DROPPED);
	assert.equal(mapSendResult(true), SEND_DROPPED);
});

test('a zero-length payload on an open socket would read as dropped', () => {
	// Documents the unprobed edge rather than asserting Bun's behavior: if a
	// zero-byte send returns 0 (bytes accepted = 0), this mapping calls it a
	// drop. The platform never sends an empty frame - every envelope builder
	// guards non-empty at the send site - so nothing in this adapter reaches
	// the ambiguity. A future caller that does must not use this mapping.
	assert.equal(mapSendResult(0), SEND_DROPPED);
});

// THE FAN-OUT ANSWER, which widened rather than changed meaning. `publish()`
// used to come back as a byte count that might be zero; it now also answers -1
// for a subscriber under backpressure and 0 for a frame that was DISCARDED,
// which the older runtime could not distinguish from a delivery.

test('bytes published reaches someone', () => {
	assert.equal(publishReached(4), true);
	assert.equal(publishReached(1048576), true);
});

test('-1 is a queued frame, which reached a subscriber', () => {
	// It is what the older runtime answered for this case, so reading it as a
	// miss changes what publish() returns under an app that changed nothing -
	// and an app that retries on false sends it twice, to a socket already
	// behind.
	assert.equal(publishReached(-1), true);
});

test('0 reached nobody, whether discarded or unsubscribed', () => {
	assert.equal(publishReached(0), false);
});

test('an undocumented code never claims delivery', () => {
	// The same conservative direction mapSendResult takes: being wrong toward
	// "nobody got it" costs a resend, being wrong toward "delivered" loses the
	// frame silently, and only one of those self-heals.
	assert.equal(publishReached(-2), false);
	assert.equal(publishReached(-1000), false);
	assert.equal(publishReached(NaN), false);
	assert.equal(publishReached(undefined), false);
	assert.equal(publishReached('4'), false);
});

test('the two mappings agree about what the runtime meant', () => {
	// One rule stated twice is a rule that eventually disagrees with itself, so
	// this pins them against each other rather than against a restatement.
	for (const code of [4, 64, 1048576, -1, 0, -2, NaN]) {
		const sent = mapSendResult(code);
		assert.equal(
			publishReached(code),
			sent === SEND_SUCCESS || sent === SEND_BACKPRESSURE,
			`code ${code} is read the same way on both paths`
		);
	}
});
