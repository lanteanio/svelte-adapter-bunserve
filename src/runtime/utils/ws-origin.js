/**
 * The origin decisions for the two doors an app's credential code sits behind:
 * cross-site WebSocket hijacking (CSWSH) defense at the upgrade, and CSRF
 * defense at the auth preflight. Both are pure predicates, so they are testable
 * without a socket and without a server.
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

/**
 * Decide whether the auth preflight POST may proceed: CSRF defense for the one
 * adapter-owned endpoint that runs app credential code.
 *
 * That endpoint accepts session cookies and calls the app's `authenticate`
 * hook, which may refresh a cookie, write an audit entry, or spend a per-user
 * budget. Without a guard, a page on any origin can drive all of that with the
 * visitor's cookie riding along on a credentialed `fetch`.
 *
 * Accepted when ANY of these holds:
 *
 * - `x-requested-with: XMLHttpRequest`. A cross-origin browser cannot set a
 *   custom header without a CORS preflight first, and this endpoint approves
 *   none - so the header's presence is itself the proof. The family client
 *   stamps it on every preflight, which is why the browser path is unaffected.
 * - `sec-fetch-site: same-origin`. Browsers stamp it themselves and script
 *   cannot forge it.
 * - An `Origin` the configured policy allows, by the same predicate the upgrade
 *   door uses - so one `allowedOrigins` governs both.
 *
 * A MISSING `Origin` is refused here, where the upgrade door allows it. That is
 * the deliberate difference between the two: at the upgrade door a missing
 * header buys no security (anything that can omit it can forge it) and refusing
 * it breaks every non-browser client, while an app's `upgrade` hook is still
 * there to authenticate one. This endpoint IS the authentication, so it cannot
 * lean on a hook behind it. A native client with no browser headers at all is
 * the case `authPathRequireOrigin: false` exists for.
 *
 * @param {Headers} headers the request's headers
 * @param {string} selfOrigin this server's own origin, as the upgrade door resolves it
 * @param {'same-origin' | 'any' | '*' | string[]} allowedOrigins validated config
 * @returns {boolean}
 */
export function isAuthOriginAccepted(headers, selfOrigin, allowedOrigins) {
	// First, exactly as at the upgrade door: an app that has opted out of origin
	// checking has opted out here too, and this endpoint must not be the one
	// place a documented 'any' quietly still refuses.
	if (allowedOrigins === 'any' || allowedOrigins === '*') return true;

	const requestedWith = headers.get('x-requested-with');
	if (requestedWith !== null && requestedWith.trim().toLowerCase() === 'xmlhttprequest') return true;

	const fetchSite = headers.get('sec-fetch-site');
	if (fetchSite !== null && fetchSite.trim().toLowerCase() === 'same-origin') return true;

	const originHeader = headers.get('origin');
	if (originHeader === null) return false;
	return isUpgradeOriginAllowed(originHeader, selfOrigin, allowedOrigins);
}
