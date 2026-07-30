// Build-time configuration helpers for the adapter. Pure and dependency-free
// (no SvelteKit builder, no filesystem, no placeholder imports) so they are
// unit-testable in isolation - the build flow in index.js wires their output
// into the placeholder replace map.

import { RESERVED_STATIC_HEADER_KEYS } from './runtime/utils/static-headers.js';

// RFC 7230 token charset - the legal alphabet for a header NAME.
const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * True when the value contains a C0 control character or DEL (CR/LF
 * injection included). A control character in a header value would make
 * Headers construction throw on EVERY static request at runtime; the build
 * must fail instead. charCode loop rather than a regex so the source stays
 * plain ASCII.
 * @param {string} value
 * @returns {boolean}
 */
function hasControlChar(value) {
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}

/**
 * @typedef {Object} NormalizedStaticHeaders
 * @property {Record<string, string> | null} headers - lowercased, reserved keys
 *   removed; `null` when nothing usable remains (so the placeholder serializes
 *   to `null` and the runtime merge is a no-op).
 * @property {string[]} dropped - reserved keys that were removed, for a
 *   build-time warning.
 */

/**
 * Validate and normalize the top-level `staticHeaders` adapter option. Throws
 * on a misshaped value (so the misconfig fails the build loudly) and strips
 * reserved transfer/caching headers the static handler manages itself.
 *
 * @param {unknown} input - the raw `staticHeaders` option value
 * @returns {NormalizedStaticHeaders}
 */
export function normalizeStaticHeaders(input) {
	if (input == null) return { headers: null, dropped: [] };
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw new Error(
			"adapter option `staticHeaders` must be an object of string header values, " +
			"e.g. { 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' }."
		);
	}
	/** @type {Record<string, string>} */
	const headers = {};
	/** @type {string[]} */
	const dropped = [];
	for (const rawKey of Object.keys(/** @type {Record<string, unknown>} */ (input))) {
		const value = /** @type {Record<string, unknown>} */ (input)[rawKey];
		if (typeof value !== 'string') {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` must be a string, got ${typeof value}.`
			);
		}
		if (!HEADER_NAME_TOKEN.test(rawKey)) {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` has an illegal header name - ` +
				"names must be RFC 7230 tokens (letters, digits, and !#$%&'*+.^_`|~-)."
			);
		}
		if (hasControlChar(value)) {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` contains a control character - ` +
				'header values must be single-line printable text.'
			);
		}
		const key = rawKey.toLowerCase();
		if (RESERVED_STATIC_HEADER_KEYS.has(key)) {
			dropped.push(key);
			continue;
		}
		headers[key] = value;
	}
	return { headers: Object.keys(headers).length ? headers : null, dropped };
}
