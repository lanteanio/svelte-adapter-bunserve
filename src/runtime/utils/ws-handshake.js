// What a WebSocket opening handshake must carry before any capacity, origin or
// application decision is made about it (RFC 6455 4.2.1).
//
// svelte-adapter-uws's rule, line for line: 400 for a request that is not a
// handshake anyone could complete, and 426 with `Sec-WebSocket-Version: 13` for
// one asking for a version this server does not speak, which is the answer RFC
// 6455 4.4 gives the client to retry with. Letter case is folded and whitespace
// trimmed in ASCII only, as uWS does.
//
// The rule counts header LINES, because a repeated line is a request no one
// can give one reading. Bun hands the fetch handler each of these headers
// joined into one value with ", ", so a comma in a value is read as a second
// line. That is the same answer uws gives wherever the two can be told apart:
// a valid Upgrade, key or version value never contains a comma. Two readings
// differ, both of a single line that lists several values: a version line such
// as `13, 8` is refused 400 here where uws answers 426, and an Upgrade line
// such as `websocket, h2c` with no key is refused 400 as an attempted
// handshake where uws treats it as a request that is not a handshake.

/**
 * A Sec-WebSocket-Key is the base64 of exactly 16 octets: 22 significant
 * characters and `==`. The 22nd carries only two bits of the last octet, so
 * the four unused bits must be zero - `A`, `Q`, `g` or `w` - or the value is
 * not the canonical encoding of any 16 octets.
 */
const WEBSOCKET_KEY_RE = /^[A-Za-z0-9+/]{21}[AQgw]==$/;

/** The one version RFC 6455 defines, and the only one this server accepts. */
export const WEBSOCKET_VERSION = '13';

/**
 * The handshake headers of one request, as the rule reads them.
 *
 * @typedef {object} HandshakeLines
 * @property {number} upgrades how many Upgrade lines arrived
 * @property {number} keys how many Sec-WebSocket-Key lines arrived
 * @property {number} versions how many Sec-WebSocket-Version lines arrived
 * @property {boolean} connectionUpgrade whether any Connection line lists `upgrade`
 * @property {string} upgrade the first Upgrade value, or ''
 * @property {string} key the first key, or ''
 * @property {string} version the first version, or ''
 */

/**
 * Whether `value` is `lower` in any ASCII letter case. A non-ASCII character
 * that some case mapping folds onto an ASCII letter does not match.
 *
 * @param {string} value @param {string} lower
 */
function asciiEquals(value, lower) {
	if (value.length !== lower.length) return false;
	for (let i = 0; i < value.length; i++) {
		let c = value.charCodeAt(i);
		if (c >= 65 && c <= 90) c += 32;
		if (c !== lower.charCodeAt(i)) return false;
	}
	return true;
}

/**
 * `value` with leading and trailing spaces and tabs removed, and nothing else.
 *
 * @param {string} value
 */
function trimSpacesAndTabs(value) {
	let start = 0;
	let end = value.length;
	while (start < end && (value.charCodeAt(start) === 32 || value.charCodeAt(start) === 9)) start++;
	while (end > start && (value.charCodeAt(end - 1) === 32 || value.charCodeAt(end - 1) === 9)) end--;
	return value.slice(start, end);
}

/**
 * Whether a Connection value lists the `upgrade` option. The value is a
 * comma-separated list, so `keep-alive, Upgrade` does; each item is trimmed of
 * spaces and tabs only.
 *
 * @param {string} value
 */
function listsUpgrade(value) {
	// The value a browser sends, answered without splitting it.
	if (value.length === 7) return asciiEquals(value, 'upgrade');
	for (const token of value.split(',')) {
		if (asciiEquals(trimSpacesAndTabs(token), 'upgrade')) return true;
	}
	return false;
}

/**
 * How many lines a joined value stands for, as far as the rule needs to know:
 * none, one, or more than one.
 *
 * @param {string | null} value
 */
function lineCount(value) {
	if (value === null) return 0;
	return value.includes(',') ? 2 : 1;
}

/**
 * Read the handshake headers off a fetch Request's Headers, where Bun has
 * joined each repeated line into one value.
 *
 * @param {Headers} headers
 * @returns {HandshakeLines}
 */
export function readHandshake(headers) {
	const upgrade = headers.get('upgrade');
	const key = headers.get('sec-websocket-key');
	const version = headers.get('sec-websocket-version');
	const connection = headers.get('connection');
	const upgrades = lineCount(upgrade);
	return {
		upgrades,
		keys: lineCount(key),
		versions: lineCount(version),
		connectionUpgrade: connection !== null && listsUpgrade(connection),
		// The first line's value, as uWS reads one header: what is in front of
		// the first comma Bun put there.
		upgrade: upgrades > 1
			? trimSpacesAndTabs(/** @type {string} */ (upgrade).slice(0, /** @type {string} */ (upgrade).indexOf(',')))
			: upgrade ?? '',
		key: key ?? '',
		version: version ?? ''
	};
}

/**
 * Whether a request to the WebSocket path is trying to open a WebSocket: it
 * carries a key at all, or its Upgrade value is `websocket`. A plain GET, or an
 * upgrade to another protocol such as `h2c`, is not, and is served as the HTTP
 * request it is.
 *
 * @param {HandshakeLines} h
 */
export function isWebSocketUpgradeAttempt(h) {
	return h.keys > 0 || asciiEquals(h.upgrade, 'websocket');
}

/**
 * The status a handshake is refused with, or null when it may proceed.
 *
 * 400 unless there is exactly one Upgrade line and it is `websocket`, a
 * Connection line lists `upgrade`, there is exactly one key and it is the
 * canonical base64 of 16 octets, and there is at most one version line. 426
 * when that version is anything but 13, absent included.
 *
 * @param {HandshakeLines} h
 * @returns {400 | 426 | null}
 */
export function webSocketHandshakeRefusal(h) {
	if (h.upgrades !== 1 || h.keys !== 1 || h.versions > 1 || !h.connectionUpgrade ||
		!asciiEquals(h.upgrade, 'websocket') || !WEBSOCKET_KEY_RE.test(h.key)) return 400;
	return h.version === WEBSOCKET_VERSION ? null : 426;
}
