import { isUtf8 } from 'node:buffer';
import { types } from 'node:util';

// What `ws.end(code, reason)` may put in a close frame.
//
// Bun puts whatever it is given on the wire without a word: close(999) sends
// 999, which a conforming peer answers by failing the connection; a Uint8Array
// reason is stringified ("111,107"), so UTF-8 bytes arrive as their decimal
// digits; and the documented direction of later generations is to refuse such
// a pair outright (probe/bun-api-facts.report.md, close-codes). The rule is the
// one svelte-adapter-uws applies on every surface, so a hook moving between the
// adapters closes the same way on both.

/** RFC 6455 5.5.1: a close payload is a two-byte code and at most 123 bytes of reason. */
export const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Whether `code` may go on the wire in a close frame. 1004 is reserved; 1005,
 * 1006 and 1015 are only ever reported locally; 1016-2999 is registry and
 * extension space; 3000-4999 belongs to libraries and applications.
 * @param {unknown} code
 * @returns {boolean}
 */
export function isSendableCloseCode(code) {
	if (!Number.isInteger(code)) return false;
	const n = /** @type {number} */ (code);
	return (n >= 1000 && n <= 1003) || (n >= 1007 && n <= 1014) || (n >= 3000 && n <= 4999);
}

/** @param {Uint8Array} bytes valid UTF-8 */
function clampAtCharacter(bytes) {
	if (bytes.length <= MAX_CLOSE_REASON_BYTES) return bytes;
	let cut = MAX_CLOSE_REASON_BYTES;
	// bytes[cut] is the first byte left out. A continuation byte there means a
	// character straddles the cut, so the cut moves back to that character's
	// lead byte and the whole character goes.
	while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
	return bytes.subarray(0, cut);
}

// ignoreBOM: a reason that starts with U+FEFF keeps it, as the bytes would.
const utf8back = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Check a close request and return the reason to send, as the string Bun's
 * close() takes.
 *
 * Throws a TypeError for a code that cannot go on the wire, for a reason with
 * no code (a close payload starts with its code, so there is nowhere to put
 * one), and for a reason that is neither text nor UTF-8 bytes. A reason
 * longer than 123 UTF-8 bytes is shortened at a character boundary; a lone
 * surrogate in a string is sent as U+FFFD. Bytes are decoded here because Bun
 * would otherwise stringify them.
 *
 * @param {unknown} code
 * @param {unknown} reason
 * @returns {string | undefined} undefined when there is no reason to send
 */
export function closeFrameReason(code, reason) {
	if (code !== undefined && typeof code !== 'number') {
		throw new TypeError(`a close code must be a number; got ${typeof code}`);
	}
	if (code !== undefined && !isSendableCloseCode(code)) {
		throw new TypeError(
			`close code ${code} cannot be sent: use 1000-1003, 1007-1014 or 3000-4999 ` +
			'(1005, 1006 and 1015 are reported locally and never sent)'
		);
	}
	if (reason === undefined || reason === null) return undefined;
	let bytes;
	if (typeof reason === 'string') {
		if (reason.length === 0) return undefined;
		// Every UTF-16 unit is at most 3 UTF-8 bytes, so a well-formed string of
		// 41 units or fewer always fits and goes through untouched.
		if (code !== undefined && reason.length * 3 <= MAX_CLOSE_REASON_BYTES && reason.isWellFormed()) return reason;
		bytes = Buffer.from(reason, 'utf8');
	} else if (ArrayBuffer.isView(reason)) {
		bytes = new Uint8Array(reason.buffer, reason.byteOffset, reason.byteLength);
		if (bytes.length > 0 && !isUtf8(bytes)) throw new TypeError('a close reason must be UTF-8 text');
	} else if (types.isAnyArrayBuffer(reason)) {
		bytes = new Uint8Array(reason);
		if (bytes.length > 0 && !isUtf8(bytes)) throw new TypeError('a close reason must be UTF-8 text');
	} else {
		throw new TypeError(`a close reason must be a string or UTF-8 bytes; got ${typeof reason}`);
	}
	if (bytes.length === 0) return undefined;
	if (code === undefined) throw new TypeError('a close reason needs a close code: the frame carries the reason after the code');
	return utf8back.decode(clampAtCharacter(bytes));
}

/**
 * Bun's close code for "no status": `close(1005)` writes a close frame with an
 * EMPTY payload, so the peer reads 1005 - which is what a close without a code
 * means. A bare `close()` would send 1000 instead (probe: close-codes).
 */
export const NO_STATUS_CLOSE_CODE = 1005;
