import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_CLOSE_REASON_BYTES,
	NO_STATUS_CLOSE_CODE,
	closeFrameReason,
	isSendableCloseCode
} from '../../src/runtime/utils/close-frame.js';

// The close rule shared with svelte-adapter-uws: which codes go on the wire,
// and what a reason turns into on the way there.

test('exactly 1000-1003, 1007-1014 and 3000-4999 are sendable', () => {
	for (const code of [1000, 1001, 1003, 1007, 1011, 1014, 3000, 4000, 4999]) {
		assert.equal(isSendableCloseCode(code), true, String(code));
	}
	for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65536, 1000.5, NaN, '1000', null, undefined]) {
		assert.equal(isSendableCloseCode(code), false, String(code));
	}
});

test('a code that cannot be sent throws a TypeError naming it; a non-number does not echo itself', () => {
	assert.throws(() => closeFrameReason(1006, 'x'), { name: 'TypeError', message: /close code 1006 cannot be sent/ });
	assert.throws(() => closeFrameReason('<script>', 'x'), { name: 'TypeError', message: /must be a number; got string/ });
});

test('no code and no reason is a close with no status; a reason without a code throws', () => {
	assert.equal(closeFrameReason(undefined, undefined), undefined);
	assert.equal(closeFrameReason(undefined, ''), undefined);
	assert.throws(() => closeFrameReason(undefined, 'why'), { name: 'TypeError', message: /needs a close code/ });
	assert.throws(() => closeFrameReason(undefined, new Uint8Array([0x61])), TypeError);
	assert.equal(NO_STATUS_CLOSE_CODE, 1005);
});

test('a short well-formed string is passed through as the same string', () => {
	const reason = 'bye';
	assert.equal(closeFrameReason(1000, reason), reason);
	assert.equal(closeFrameReason(1000, null), undefined);
	assert.equal(closeFrameReason(1000, new Uint8Array(0)), undefined);
});

test('a long reason is cut at a character boundary, never inside one', () => {
	// 1 + 41 * 3 = 124 bytes: the last euro sign straddles byte 123.
	const cut = closeFrameReason(4000, 'x' + '€'.repeat(41));
	assert.equal(Buffer.byteLength(cut), 121);
	assert.equal(cut, 'x' + '€'.repeat(40));
	// Four-byte characters, and an exact fit.
	const emoji = closeFrameReason(4000, '😀'.repeat(31)); // 124 bytes
	assert.equal(Buffer.byteLength(emoji), 120);
	assert.equal(closeFrameReason(4000, 'r'.repeat(MAX_CLOSE_REASON_BYTES)), 'r'.repeat(123));
	assert.equal(closeFrameReason(4000, 'r'.repeat(200)), 'r'.repeat(123));
});

test('a lone surrogate is sent as U+FFFD', () => {
	assert.equal(closeFrameReason(1000, 'a' + String.fromCharCode(0xd800) + 'b'), 'a' + String.fromCharCode(0xfffd) + 'b');
});

test('UTF-8 bytes in any buffer shape decode to the text they encode; other bytes throw', () => {
	const bytes = new TextEncoder().encode('räume');
	assert.equal(closeFrameReason(4000, bytes), 'räume');
	assert.equal(closeFrameReason(4000, Buffer.from('räume')), 'räume');
	assert.equal(closeFrameReason(4000, bytes.buffer), 'räume');
	assert.equal(closeFrameReason(4000, new DataView(bytes.buffer)), 'räume');
	assert.throws(() => closeFrameReason(4000, new Uint8Array([0xff, 0xfe])), { name: 'TypeError', message: /UTF-8/ });
});

test('a leading byte order mark survives the decode', () => {
	const bom = String.fromCharCode(0xfeff);
	assert.equal(closeFrameReason(4000, new TextEncoder().encode(bom + 'ok')), bom + 'ok');
	const long = bom + 'y'.repeat(60);
	assert.equal(closeFrameReason(4000, long), long);
});

test('a reason that is neither text nor bytes throws', () => {
	for (const reason of [42, {}, ['a'], true]) {
		assert.throws(() => closeFrameReason(4000, reason), TypeError, String(reason));
	}
});
