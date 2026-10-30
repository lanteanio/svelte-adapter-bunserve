/**
 * uWS takes a frame payload or a topic as any "recognized string" - a string,
 * an ArrayBuffer, a SharedArrayBuffer or a view over one - and works on its
 * bytes: a string is its UTF-8 encoding (an unpaired surrogate encodes as the
 * three bytes of its code unit), a view is exactly its byteOffset..byteLength
 * window, and the frame opcode comes from the caller's isBinary flag. Bun
 * keys topics on strings and picks the opcode from the payload's type. These
 * helpers translate the first into the second without changing a byte.
 *
 * Pure and dependency-free apart from node:util's buffer test.
 */

import { types } from 'node:util';

/** The message uWS throws for a payload or topic it cannot read as bytes. */
const NOT_RECOGNIZED = 'Text and data can only be passed by String, ArrayBuffer or ArrayBufferView.';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/**
 * The bytes of a non-string recognized string, as a view over the caller's
 * memory (no copy). `undefined` and a detached buffer read as no bytes, as
 * uWS reads them.
 *
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export function recognizedBytes(value) {
	if (value instanceof Uint8Array) return value;
	if (ArrayBuffer.isView(value)) {
		return value.buffer.detached ? EMPTY : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (types.isAnyArrayBuffer(value)) {
		return /** @type {ArrayBuffer} */ (value).detached ? EMPTY : new Uint8Array(/** @type {ArrayBuffer} */ (value));
	}
	if (value === undefined) return EMPTY;
	throw new Error(NOT_RECOGNIZED);
}

const EMPTY = new Uint8Array(0);

/**
 * Read bytes as uWS reads a string's encoding back: UTF-8 in which a
 * surrogate code unit may stand alone in its three-byte form. Returns null
 * for anything else, including a surrogate pair written as two such units,
 * which no string encodes to.
 *
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
function decodeLoneSurrogates(bytes) {
	const units = [];
	let previousHigh = false;
	for (let i = 0; i < bytes.length;) {
		const lead = bytes[i];
		let code;
		let size;
		if (lead < 0x80) { code = lead; size = 1; }
		else if (lead >= 0xc2 && lead <= 0xdf) { code = lead & 0x1f; size = 2; }
		else if (lead >= 0xe0 && lead <= 0xef) { code = lead & 0x0f; size = 3; }
		else if (lead >= 0xf0 && lead <= 0xf4) { code = lead & 0x07; size = 4; }
		else return null;
		if (i + size > bytes.length) return null;
		for (let k = 1; k < size; k++) {
			const next = bytes[i + k];
			if ((next & 0xc0) !== 0x80) return null;
			code = (code << 6) | (next & 0x3f);
		}
		if ((size === 3 && code < 0x800) || (size === 4 && (code < 0x10000 || code > 0x10ffff))) return null;
		const low = code >= 0xdc00 && code <= 0xdfff;
		if (low && previousHigh) return null;
		previousHigh = code >= 0xd800 && code <= 0xdbff;
		if (code >= 0x10000) {
			code -= 0x10000;
			units.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
		} else units.push(code);
		i += size;
	}
	let text = '';
	for (let i = 0; i < units.length; i += 4096) text += String.fromCharCode(...units.slice(i, i + 4096));
	return text;
}

/**
 * UTF-8 bytes of a string, with an unpaired surrogate written as the three
 * bytes of its code unit rather than replaced, which is how uWS reads one.
 *
 * @param {string} value
 * @returns {Uint8Array}
 */
export function stringBytes(value) {
	if (value.isWellFormed()) return encoder.encode(value);
	const bytes = new Uint8Array(value.length * 3);
	let length = 0;
	for (let i = 0; i < value.length; i++) {
		let code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
			const next = value.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				i++;
			}
		}
		if (code < 0x80) bytes[length++] = code;
		else if (code < 0x800) {
			bytes[length++] = 0xc0 | (code >> 6);
			bytes[length++] = 0x80 | (code & 0x3f);
		} else if (code < 0x10000) {
			bytes[length++] = 0xe0 | (code >> 12);
			bytes[length++] = 0x80 | ((code >> 6) & 0x3f);
			bytes[length++] = 0x80 | (code & 0x3f);
		} else {
			bytes[length++] = 0xf0 | (code >> 18);
			bytes[length++] = 0x80 | ((code >> 12) & 0x3f);
			bytes[length++] = 0x80 | ((code >> 6) & 0x3f);
			bytes[length++] = 0x80 | (code & 0x3f);
		}
	}
	return bytes.subarray(0, length);
}

/**
 * The value to hand Bun so the frame goes out with the opcode the caller
 * asked for and the bytes uWS would send.
 *
 * A binary frame is always bytes: a string is encoded as uWS encodes it. A
 * text frame is always a string, because Bun sends a string as text and
 * anything else as binary: bytes are decoded, which round-trips exactly for
 * valid UTF-8. Bytes that are not valid UTF-8 have no string Bun would send
 * back unchanged, so they are refused with a TypeError rather than sent with
 * the wrong opcode or with replacement characters. Such a frame is one a
 * conforming peer must fail the connection on (RFC 6455, section 8.1).
 *
 * A string is passed through as it is for a text frame. Bun writes an
 * unpaired surrogate as U+FFFD there, which is its only spelling for one.
 *
 * @param {unknown} value
 * @param {boolean | undefined} isBinary
 * @returns {string | Uint8Array}
 */
export function framePayload(value, isBinary) {
	if (typeof value === 'string') return isBinary ? stringBytes(value) : value;
	const bytes = recognizedBytes(value);
	if (isBinary) return bytes;
	try {
		return utf8.decode(bytes);
	} catch {
		throw new TypeError('A text frame must carry valid UTF-8; send these bytes with isBinary set.');
	}
}

/** Hex digits only after a leading NUL: the shape of an escaped topic. */
const ESCAPED_SHAPE = /^\0[0-9a-f]*$/;

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function escapeTopic(bytes) {
	return '\0' + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/**
 * The Bun topic for a recognized-string topic, so two topics are the same
 * native topic exactly when uWS would treat them as the same bytes.
 *
 * A string is its own name, and bytes name the topic of the string they
 * encode (UTF-8, with an unpaired surrogate in its three-byte form). What Bun
 * cannot take as a name - the empty topic, which Bun refuses, and bytes no
 * string encodes to - is written as a NUL followed by the bytes in lowercase
 * hex. A string that already has that shape is escaped the same way, so an
 * escaped name never coincides with a topic spelled that way by the caller.
 * Every native publish, subscriber count and membership call, from the socket
 * and from the platform, names its topic through here.
 *
 * Bun stores an unpaired surrogate in a topic name as U+FFFD, so such a name
 * and the same name with U+FFFD in its place are one native topic.
 *
 * @param {unknown} topic
 * @returns {string}
 */
export function nativeTopic(topic) {
	if (typeof topic === 'string') {
		if (topic.length !== 0 && (topic.charCodeAt(0) !== 0 || !ESCAPED_SHAPE.test(topic))) return topic;
		return escapeTopic(encoder.encode(topic));
	}
	const bytes = recognizedBytes(topic);
	let decoded;
	try {
		decoded = utf8.decode(bytes);
	} catch {
		decoded = decodeLoneSurrogates(bytes);
		if (decoded === null) return escapeTopic(bytes);
	}
	return nativeTopic(decoded);
}
