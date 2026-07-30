import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	mapSendResult,
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
