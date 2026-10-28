// Two things RFC 9112 3.2 does not allow in a request target: a byte outside
// visible ASCII, and a fragment. svelte-adapter-uws refuses both with 400 on
// every route and on the WebSocket handshake, because uWS routes on them
// differently from the URL parser behind it, and RFC 9112 3 asks for a 400
// rather than a guess: such a line can be built to read one way to a filter in
// front and another way here.
//
// Of the two, only the fragment reaches a Bun fetch handler
// (probe/bun-api-facts.report.md, request-target). Bun answers a space or a
// byte below 0x20 in the target with its own 505 before the handler runs, and
// a bare CR with nothing at all. It hands DEL on as `%7F`, and every byte from
// 0x80 up decoded as UTF-8 and percent-encoded again - a UTF-8 e-acute as
// `%C3%A9`, a byte that is not part of UTF-8 as the replacement character,
// `%EF%BF%BD` - where nothing tells it from a client that sent the escape. A
// `#` it keeps in `req.url`, in the path or the query, and the URL parser then
// reads the rest as a fragment: `/healthz#frag` is the probe's pathname, and
// `/ws?x=1#y` the WebSocket path's.

/**
 * Whether the recovered target carries a fragment. The Host-derived prefix
 * is removed before routing; its validity is checked where an application
 * URL is constructed.
 *
 * @param {string} url the target
 */
export function invalidRequestTarget(url) {
	return url.indexOf('#') !== -1;
}

/**
 * Where the target begins in `req.url`. Bun builds that string from the
 * scheme, the Host value as sent and the target, so the Host is skipped by its
 * own length: a Host carrying a `/`, `?` or `#` would otherwise be read as the
 * start of the path. A Host Bun rewrote on the way in (a default port dropped,
 * letters lowered) no longer matches, and the path then begins at the first
 * `/` after the authority. With the Host empty, or missing on HTTP/1.0, Bun
 * hands on the target alone.
 *
 * @param {string} url `req.url`
 * @param {string | null} host the request's Host value
 */
export function targetStart(url, host) {
	if (url.charCodeAt(0) === 47) return 0;
	const authority = url.indexOf('//') + 2;
	if (host && url.startsWith(host, authority) && url.charCodeAt(authority + host.length) === 47) {
		return authority + host.length;
	}
	// Bun normalizes a malformed Host as part of the URL too. Recover the
	// boundary from that same prefix, before interpreting the target.
	if (host && /[\\/?#]/.test(host)) {
		try {
			const prefix = new URL(url.slice(0, authority) + host + '/').href.slice(0, -1);
			if (url.startsWith(prefix) && url.charCodeAt(prefix.length) === 47) return prefix.length;
		} catch { /* The fallback does not parse the authority. */ }
	}
	const slash = url.indexOf('/', authority);
	return slash === -1 ? url.length : slash;
}

const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|(?:[A-Za-z0-9\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})+)(?::[0-9]*)?$/;

/** Whether a header is not an HTTP authority, using the family grammar. */
export function invalidHost(value) {
	return typeof value !== 'string' || !HOST.test(value);
}

/** The path and query Bun retained, excluding the Host-derived prefix. */
export function requestTarget(request) {
	return request.url.slice(targetStart(request.url, request.headers.get('host')));
}
