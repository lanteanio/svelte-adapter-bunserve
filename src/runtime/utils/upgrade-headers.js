// Shared validation for headers attached to the 101 handshake response.
// Reject invalid names and values before constructing Bun's native headers.

/** RFC 7230 token: the only shape a header NAME may take. */
export const UPGRADE_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;

/**
 * Bytes a header value may not carry.
 *
 * This is Node's own `checkInvalidHeaderChar` class: everything except TAB,
 * printable ASCII and the high range. CR, LF and NUL are the ones that actually
 * split or truncate the response, but the class is deliberately wider.
 * TAB stays legal because it is valid header whitespace, and the high range
 * stays legal because it cannot split a header line.
 */
export const UPGRADE_HEADER_VALUE_RE = /[^\t\x20-\x7e\x80-\xff]/;

/**
 * Header names the handshake itself owns, so an app may not set them.
 *
 * Bun writes `Connection`, `Upgrade` and `Sec-WebSocket-Accept`, and
 * negotiates `Sec-WebSocket-Extensions` and `Sec-WebSocket-Protocol` from the
 * client's offer. Application headers must not conflict with those values.
 * Compare names without regard to case, as required for HTTP headers.
 */
export const HANDSHAKE_OWNED_HEADER_NAMES = Object.freeze([
	'connection',
	'date',
	'upgrade',
	'sec-websocket-accept',
	'sec-websocket-extensions',
	'sec-websocket-protocol'
]);
const HANDSHAKE_OWNED = new Set(HANDSHAKE_OWNED_HEADER_NAMES);

/**
 * First reason these headers cannot be written safely, or null when clean.
 *
 * Requires a non-null object: callers guard, because "no headers at all" is a
 * legitimate state that has nothing to validate rather than a violation to
 * report.
 *
 * @param {Record<string, string | string[]>} responseHeaders
 * @returns {string | null}
 */
export function findUnsafeUpgradeHeader(responseHeaders) {
	for (const [name, value] of Object.entries(responseHeaders)) {
		if (!UPGRADE_HEADER_NAME_RE.test(name)) {
			return `header name ${JSON.stringify(name)} is not a valid RFC 7230 token`;
		}
		if (HANDSHAKE_OWNED.has(name.toLowerCase())) {
			return `header ${JSON.stringify(name)} belongs to the WebSocket handshake and is written by the server; an application value would go out beside it and break the handshake`;
		}
		const arrayValue = Array.isArray(value);
		const length = arrayValue ? value.length : 1;
		for (let i = 0; i < length; i++) {
			// Index the array directly. `for...of` runs an app-controlled
			// Symbol.iterator, which can yield clean bytes during validation and
			// splitting bytes when the runtime iterates again to write.
			const v = arrayValue ? value[i] : value;
			// Require strings explicitly: RegExp.test would otherwise coerce values
			// that do not satisfy the public header contract.
			if (typeof v !== 'string') {
				return `header ${JSON.stringify(name)} value must be a string, got ${v === null ? 'null' : typeof v}`;
			}
			if (UPGRADE_HEADER_VALUE_RE.test(v)) {
				return `header ${JSON.stringify(name)} value contains a CR, LF, or NUL byte, or another control character`;
			}
		}
	}
	return null;
}

/**
 * Assert that a value is a header bag whose names and values are safe to write.
 *
 * `null` / `undefined` mean no response headers and are accepted. Every other
 * value must be a non-array object. In particular, `Object.entries('abc')` and
 * `Object.entries(['abc'])` produce numeric keys, so merely feeding an unknown
 * value to {@link findUnsafeUpgradeHeader} invents valid-looking headers rather
 * than rejecting the misshaped upgrade result.
 *
 * @param {Record<string, string | string[]> | null | undefined} responseHeaders
 * @returns {void}
 */
function assertUpgradeHeaderContainer(responseHeaders) {
	if (responseHeaders == null) return;
	if (typeof responseHeaders !== 'object' || Array.isArray(responseHeaders)) {
		throw new TypeError(
			`upgradeResponse() headers must be an object of header names to values - ` +
			`got ${Array.isArray(responseHeaders) ? 'an array' : typeof responseHeaders}.`
		);
	}
}

export function assertSafeUpgradeHeaders(responseHeaders) {
	assertUpgradeHeaderContainer(responseHeaders);
	if (responseHeaders == null) return;
	const unsafe = findUnsafeUpgradeHeader(responseHeaders);
	if (unsafe) throw new TypeError(`upgradeResponse() rejected: ${unsafe}`);
}

/**
 * Snapshot and validate the headers a runtime surface is about to consume.
 *
 * This is deliberately one operation. The object belongs to the app and may be
 * shared across upgrades; validating it and reading it again later leaves a
 * validate/use window. Array values are copied as well as the bag, and the bag
 * has no prototype so an own enumerable `__proto__` key cannot disappear
 * through Object.prototype's setter. Every surface consumes this returned
 * snapshot rather than the caller's object.
 *
 * @param {Record<string, string | string[]> | null | undefined} responseHeaders
 * @returns {Record<string, string | string[]> | null}
 */
export function snapshotUpgradeHeaders(responseHeaders) {
	if (responseHeaders == null) return null;
	// Check the CONTAINER before Object.entries can reinterpret a string/array as
	// a bag of numeric header names. Do not validate the LIVE values before the
	// snapshot: a later getter may mutate an earlier key during Object.entries,
	// and the safe contract is to write the earlier value already captured by
	// that one enumeration, not to re-read the app's now-poisoned object.
	assertUpgradeHeaderContainer(responseHeaders);
	/** @type {Record<string, string | string[]>} */
	const snapshot = Object.create(null);
	// Read and copy one value at a time. Object.entries first materializes ALL
	// values, so a getter on a later key can mutate an earlier array before the
	// copy loop begins. Object.keys fixes the key set, then this loop captures an
	// array at the same point its property is read.
	for (const name of Object.keys(responseHeaders)) {
		const value = responseHeaders[name];
		if (Array.isArray(value)) {
			// Do not call the app array's `.slice()` (or any iterator). Both are
			// executable hooks, and slice also honours Symbol.species. A hostile
			// result can yield safe bytes while the snapshot is validated, then
			// CRLF when the write loop iterates it a second time. Copy each index
			// once into a native array; validation and the sinks also use indices,
			// so no app-controlled iteration remains between check and use.
			const length = value.length;
			const copied = new Array(length);
			for (let i = 0; i < length; i++) copied[i] = value[i];
			snapshot[name] = copied;
		} else {
			snapshot[name] = value;
		}
	}
	assertSafeUpgradeHeaders(snapshot);
	return snapshot;
}


/**
 * One warning per worker, not per connection - a warning that repeats on every
 * connection is a warning people filter out. Clustering runs worker threads in
 * one process, each with its own module registry, so a clustered deployment
 * emits one per worker.
 */
let warnedSetCookieOnUpgrade = false;

/**
 * Warn once when a handshake carries Set-Cookie, which Cloudflare Tunnel and
 * some other strict edge proxies silently reject: the WebSocket opens and then
 * closes with 1006 before any frame is exchanged, which is near-impossible to
 * diagnose from the app side.
 *
 * @param {Record<string, string | string[]> | null | undefined} responseHeaders
 */
export function warnSetCookieOnUpgradeOnce(responseHeaders) {
	if (warnedSetCookieOnUpgrade || !responseHeaders) return;
	for (const k of Object.keys(responseHeaders)) {
		if (k.toLowerCase() === 'set-cookie') {
			warnedSetCookieOnUpgrade = true;
			console.warn(
				'[adapter-bunserve] Set-Cookie on the 101 upgrade response is rejected by ' +
				'Cloudflare Tunnel and some other edge proxies (WebSocket opens, then ' +
				'closes with 1006 TCP FIN). Migrate to the `authenticate` hook to ' +
				'refresh session cookies over a normal HTTP response: ' +
				'export function authenticate({ cookies }) { cookies.set(...); }\n' +
				'  See: https://svti.me/cf-cookies'
			);
			return;
		}
	}
}
