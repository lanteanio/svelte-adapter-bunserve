/**
 * The upgrade-time origin decision: cross-site WebSocket hijacking (CSWSH)
 * defense, expressed as a pure predicate so it is testable without a socket.
 *
 * WebSocket upgrades are NOT subject to the same-origin policy and carry
 * cookies like any other request, so a page on evil.example can open a socket
 * to your server and inherit the visitor's session unless the server checks
 * `Origin` itself. That check is on by default here (`allowedOrigins:
 * 'same-origin'`) rather than opt-in - a realtime app that forgets to configure
 * it should still be safe.
 *
 * Pure and dependency-free.
 */

/**
 * Normalize an origin for comparison: lowercase (scheme and host are
 * case-insensitive) and trailing slash removed, which browsers do not send but
 * hand-written config often carries.
 *
 * @param {string} origin
 * @returns {string}
 */
function normalizeOrigin(origin) {
	let s = origin.trim().toLowerCase();
	while (s.endsWith('/')) s = s.slice(0, -1);
	return s;
}

/**
 * Decide whether an upgrade may proceed.
 *
 * A MISSING `Origin` header is allowed. The header is only meaningful because
 * browsers set it and refuse to let script forge it; anything that can omit it
 * (curl, a native mobile client, server-to-server) can equally well send any
 * value it likes, so rejecting on absence buys no security while breaking every
 * legitimate non-browser client. The literal string "null" is NOT absence - a
 * sandboxed iframe or a `file://` page sends it, and it is denied unless the
 * app opted into 'any'.
 *
 * An EMPTY `Origin` is not absence. Absence means the header was never sent;
 * an empty value means something sent the header and put nothing in it, which
 * no browser does (an opaque origin serialises to the four characters "null",
 * already denied above). It is reachable from a misbehaving proxy, and treating
 * "present but empty" as "trusted non-browser client" is the wrong reading of
 * an ambiguous value.
 *
 * @param {string | null | undefined} originHeader - the request's `Origin`
 * @param {string} selfOrigin - this server's own origin, e.g. 'https://app.example'
 * @param {'same-origin' | 'any' | '*' | string[]} allowedOrigins - validated config
 * @returns {boolean}
 */
export function isUpgradeOriginAllowed(originHeader, selfOrigin, allowedOrigins) {
	// '*' is the family's spelling of this and 'any' is this adapter's; both are
	// accepted so one svelte.config.js works across the adapter family.
	if (allowedOrigins === 'any' || allowedOrigins === '*') return true;
	if (originHeader === null || originHeader === undefined) return true;

	const origin = normalizeOrigin(originHeader);

	if (Array.isArray(allowedOrigins)) {
		for (const candidate of allowedOrigins) {
			if (normalizeOrigin(candidate) === origin) return true;
		}
		return false;
	}

	// 'same-origin'
	return origin === normalizeOrigin(selfOrigin);
}
