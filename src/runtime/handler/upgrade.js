/**
 * The WebSocket upgrade path.
 *
 * On Bun this is where the donor's most intricate machinery disappears. uWS
 * hands the upgrade callback a stack-allocated request that dies the moment the
 * callback returns, so an async authorization hook needs a dance: copy every
 * header first, track whether the client aborted, and defer the actual
 * `res.upgrade` behind that bookkeeping. Bun hands `fetch` a real `Request`
 * that outlives any await, so the hook is simply awaited and `server.upgrade`
 * is called afterwards - a 25ms await before the call still upgrades cleanly
 * (probed). The aborted-tracking and the async-upgrade trap are both gone.
 *
 * Rejection is likewise native: returning a `Response` from `fetch` instead of
 * calling `server.upgrade` rejects the handshake with that exact response,
 * which is the shape the family's `upgradeResponse` API already models. Here
 * the hook just returns a Response and it goes on the wire.
 */

import { platform } from './platform.js';
import { wsModule } from '../ws-handler-bridge.js';
import { isUpgradeOriginAllowed } from '../utils/ws-origin.js';
import { resolveRequestId } from '../utils/request-id.js';
import { createLogThrottle } from '../utils/log-throttle.js';
import { WS_REQUEST_ID_KEY, isDraining } from './ws-state.js';
import { get_origin, origin, ws_options, ws_path } from './config.js';

/** Upgrade-hook throws, throttled with decay. */
const upgradeThrewThrottle = createLogThrottle(() => performance.now());

/** Refused handshake headers, throttled with decay. */
const badHeaderThrottle = createLogThrottle(() => performance.now());

/**
 * RFC 7230 token characters, which is what a header NAME may contain.
 * @type {RegExp}
 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * First unusable handshake header, or null when they are all fine.
 *
 * @param {Record<string, string>} headers
 * @returns {string | null} a description of the offending entry
 */
function invalidHeaderEntry(headers) {
	for (const name of Object.keys(headers)) {
		if (!HEADER_NAME.test(name)) return `invalid header name ${JSON.stringify(name)}`;
		// Headers that define the RESPONSE FRAMING or the handshake result are
		// never the app's to set. `Content-Length` or `Transfer-Encoding` on a
		// 101 is a request-smuggling primitive through any intermediary that
		// parses framing, and a duplicate `Sec-WebSocket-Accept` lands BEFORE
		// Bun's own - a handshake-validation bypass for a first-occurrence-wins
		// parser. Verified over raw TCP that Bun writes all of these verbatim.
		if (RESERVED_HEADERS.has(name.toLowerCase())) {
			return `reserved header ${JSON.stringify(name)}`;
		}
		const value = headers[name];
		if (typeof value !== 'string') return `non-string value for ${JSON.stringify(name)}`;
		// Anything outside printable ASCII. CR/LF/NUL are the response-splitting
		// set, but the range matters beyond them: Bun rejects every byte >= 0x80
		// and THROWS out of srv.upgrade when it sees one, so a value as ordinary
		// as a user's name with an accent used to escape this function, escape
		// the handler, and land in the unthrottled top-level error logger -
		// measured at 667 bytes of synchronous stderr per request.
		for (let i = 0; i < value.length; i++) {
			const c = value.charCodeAt(i);
			if (c < 0x20 || c > 0x7e) {
				return `non-printable-ASCII character in the value of ${JSON.stringify(name)}`;
			}
		}
	}
	return null;
}

/**
 * Headers the app may not set on the 101. Lowercase; names are compared
 * case-insensitively because HTTP header names are.
 */
const RESERVED_HEADERS = new Set([
	'content-length',
	'transfer-encoding',
	'connection',
	'upgrade',
	'sec-websocket-accept',
	'sec-websocket-version',
	'sec-websocket-extensions'
]);

/** Origin refusals, throttled with decay. */
const originRefusedThrottle = createLogThrottle(() => performance.now());

let warnedDerivedSelfOrigin = false;
/**
 * Say that the same-origin check is comparing the client against itself.
 *
 * With no ORIGIN configured the server's own origin has to be reconstructed
 * from the request, and the host in it is the one the CLIENT sent. The check
 * then reduces to "the Origin header matches the Host header", which any client
 * can satisfy by setting both - so the CSWSH defense the default advertises is
 * not actually in force. It still refuses a browser page on another origin that
 * connects by the server's real name, which is the common case, but it does not
 * survive a wildcard/multi-tenant deployment or DNS rebinding, where the
 * attacker controls the host the request arrives under.
 *
 * One-shot: it describes the deployment's configuration, not a per-request
 * condition, and it fires on the first upgrade that actually relies on it
 * rather than at boot, so an app with no WebSocket traffic stays quiet.
 */
function warnDerivedSelfOrigin() {
	if (warnedDerivedSelfOrigin) return;
	warnedDerivedSelfOrigin = true;
	console.warn(
		'[ws] allowedOrigins is \'same-origin\' but ORIGIN is not set, so the origin an upgrade is\n' +
		'  compared against is derived from the request\'s own Host header. That check cannot refuse a\n' +
		'  client that sets both headers, and it does not hold where the host is attacker-controlled\n' +
		'  (a wildcard or multi-tenant domain, or DNS rebinding). Set ORIGIN to the public origin,\n' +
		'  e.g. ORIGIN=https://app.example, or pass an explicit allowedOrigins list.'
	);
}
/**
 * Say why an upgrade was refused. Silence here is an operational trap: the page
 * loads, the socket 403s, the server logs nothing, and the fastest thing that
 * makes it work is `allowedOrigins: 'any'` - which disables the CSWSH defense
 * entirely. Naming both sides of the comparison usually makes the cause obvious
 * (an unset ORIGIN behind a TLS-terminating proxy, most often).
 *
 * Throttled rather than one-shot: a genuine attacker can drive this, and an
 * operator still needs to see that it is ongoing. The Origin is echoed because
 * it is the whole diagnostic; it is not otherwise logged.
 *
 * @param {string | null} received
 * @param {string} self
 */
function warnOriginRefused(received, self) {
	const { log: logIt, count: n } = originRefusedThrottle();
	if (!logIt) return;
	const suffix = n > 1 ? ` (occurrence ${n})` : '';
	// Truncated: the Origin is attacker-controlled and can be a full header's
	// worth of text. JSON.stringify already escapes CR/LF and C0, so this is
	// about volume, not injection.
	const shown = received === null
		? '(none)'
		: JSON.stringify(received.length > 128 ? received.slice(0, 128) + '...' : received);
	console.warn(
		`[ws] refused a WebSocket upgrade on Origin${suffix}: received ` +
		`${shown}, this server's origin is ` +
		`${self ? JSON.stringify(self) : '(unresolvable)'}, allowedOrigins=` +
		`${JSON.stringify(ws_options && ws_options.allowedOrigins)}.\n` +
		'  Behind a proxy that terminates TLS, set ORIGIN to the public origin (or PROTOCOL_HEADER/\n' +
		'  HOST_HEADER) so the comparison uses it rather than a scheme derived from this process.'
	);
}

let warnedReturnedHeaders = false;
/** One-shot: it fires per upgrade and describes a static code shape. */
function warnReturnedHeaders() {
	if (warnedReturnedHeaders) return;
	warnedReturnedHeaders = true;
	console.warn(
		'[ws] the upgrade hook returned a `headers` key. Handshake headers are now set on the\n' +
		'  context instead, and the returned key is being treated as ordinary userData:\n' +
		'    export function upgrade(request, { headers }) {\n' +
		'      headers[\'sec-websocket-protocol\'] = \'v1\';\n' +
		'      return { user };\n' +
		'    }\n' +
		'  The returned object is frequently built by spreading parsed client input, which made\n' +
		'  an in-band `headers` key attacker-settable; the context channel cannot be.'
	);
}

/**
 * 503 with Retry-After, the honest answer for a server that is going away: the
 * client should come back, not treat this as a permanent rejection.
 *
 * @returns {Response}
 */
function drainingResponse() {
	return new Response('Server draining', {
		status: 503,
		headers: { 'retry-after': '1', connection: 'close' }
	});
}

/**
 * Handle a request that targets the WebSocket endpoint.
 *
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @param {string} pathname
 * @returns {Promise<Response | undefined> | null} `null` when the request is
 *   not for this endpoint (the caller continues its normal routing);
 *   `undefined` when the upgrade succeeded and Bun owns the socket; a Response
 *   when the handshake was refused.
 */
export function tryUpgrade(req, srv, pathname) {
	if (ws_options === null || pathname !== ws_path) return null;
	// Only a real upgrade request belongs here. A plain GET to the WS path is
	// answered with 426 rather than falling through to SSR, which would render
	// the app shell at a URL that is not a page.
	const upgradeHeader = req.headers.get('upgrade');
	if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
		return Promise.resolve(
			new Response('Expected a WebSocket upgrade', {
				status: 426,
				headers: { upgrade: 'websocket', connection: 'Upgrade' }
			})
		);
	}
	return runUpgrade(req, srv);
}

/**
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @returns {Promise<Response | undefined>}
 */
async function runUpgrade(req, srv) {
	// Cross-site WebSocket hijacking defense, BEFORE the app's hook: the hook
	// may read cookies and do database work, and a foreign origin should not be
	// able to make it do either.
	// The CONFIGURED origin wins, exactly as the SSR path does it. Deriving the
	// origin from request headers instead would take the scheme from `is_tls`,
	// which is false whenever TLS terminates at a proxy - so a standard
	// deployment (ORIGIN=https://app.example behind nginx) would compare the
	// browser's `https://app.example` against a derived `http://app.example`
	// and 403 every legitimate upgrade. That failure pushes operators straight
	// to `allowedOrigins: 'any'`, which disables the defense outright, so a
	// fail-closed bug here becomes a fail-open configuration.
	//
	// With nothing configured the fallback below reconstructs the origin from
	// the request, whose host the CLIENT chose - so the comparison is between
	// two values the same peer supplied. It is kept because refusing every
	// upgrade on an unconfigured server would break local development, but it
	// is not the defense the default advertises, and it says so out loud once.
	let selfOrigin = origin || '';
	if (!selfOrigin) {
		if (ws_options.allowedOrigins === 'same-origin') warnDerivedSelfOrigin();
		try {
			selfOrigin = get_origin(req.headers);
		} catch {
			selfOrigin = '';
		}
	}
	// An unresolvable self origin cannot be same-origin-checked. Deny rather
	// than compare: normalizeOrigin() collapses `/` and whitespace-only values
	// to the empty string too, so an empty selfOrigin would MATCH those rather
	// than matching nothing.
	if (ws_options.allowedOrigins === 'same-origin' && !selfOrigin) {
		warnOriginRefused(req.headers.get('origin'), selfOrigin);
		return new Response('Forbidden origin', { status: 403 });
	}
	if (!isUpgradeOriginAllowed(req.headers.get('origin'), selfOrigin, ws_options.allowedOrigins)) {
		warnOriginRefused(req.headers.get('origin'), selfOrigin);
		return new Response('Forbidden origin', { status: 403 });
	}

	// Shutdown has started: refuse rather than hand a client a socket on a
	// process that is about to exit. Checked before the app hook runs so a
	// draining server does no needless session work.
	if (isDraining()) return drainingResponse();

	/** @type {Record<string, any>} */
	const data = {};
	const requestId = resolveRequestId(req.headers.get('x-request-id')) ?? crypto.randomUUID();

	/** @type {Record<string, string> | undefined} */
	let responseHeaders;

	if (typeof wsModule.upgrade === 'function') {
		// Handshake headers (a chosen subprotocol, a session cookie) are set
		// through the CONTEXT, and must never be an in-band key on the returned
		// object. That object carries userData and is routinely built by
		// spreading parsed client input - the `__proto__` filter below exists
		// because this code already anticipates exactly that. An in-band
		// `headers` key in the same position is attacker-settable: an app doing
		// `return { ...JSON.parse(atob(jwt)), user }` with an attacker-chosen
		// `headers` claim would put arbitrary headers, `set-cookie` included, on
		// the 101 response. A context channel cannot be named by attacker JSON.
		// Custom headers on the 101 were verified over raw TCP by the probe.
		/** @type {Record<string, string>} */
		const ctxHeaders = {};
		let result;
		try {
			result = await wsModule.upgrade(req, { platform, headers: ctxHeaders });
		} catch (err) {
			// Throttled like every other hook-error site. This one is the
			// CHEAPEST to drive - plain HTTP, no socket, no Origin needed - so a
			// hook that throws on malformed input (`JSON.parse(cookie)`) turned
			// one request into ~1KB of synchronous stderr. Measured 50 requests
			// -> 601 stderr lines before the throttle.
			const { log: logIt, count: n } = upgradeThrewThrottle();
			if (logIt) {
				const suffix = n > 1 ? ` (occurrence ${n})` : '';
				console.error(`WebSocket upgrade error${suffix}:`, err);
			}
			return new Response('Internal Server Error', { status: 500 });
		}
		// A Response from the hook IS the rejection, verbatim - status, body,
		// headers. This is why there is no separate upgradeResponse type here.
		if (result instanceof Response) return result;
		// `false` REJECTS, matching the family ("Return `false` to reject with
		// 401"). Tested explicitly because it is not an object: falling through
		// to the generic userData path would complete the handshake with empty
		// userData, so a hook whose auth check reads `if (!session) return false`
		// would admit exactly the connections it means to refuse.
		if (result === false) return new Response('Unauthorized', { status: 401 });
		if (Object.keys(ctxHeaders).length > 0) {
			// VALIDATED before it reaches the 101. Moving the channel out of
			// band stopped an attacker NAMING a header; it did nothing about an
			// attacker supplying a value, and a hook that writes
			// `headers['x-user'] = name` from client data can still smuggle
			// CR/LF. The family's equivalent (upgradeResponse) throws on exactly
			// this, so refusing loudly is the family-consistent answer.
			const bad = invalidHeaderEntry(ctxHeaders);
			if (bad !== null) {
				// Throttled: reachable per request whenever the app echoes a
				// client-controlled value into a header, which is the exact
				// shape this check exists for.
				const { log: logIt, count: n } = badHeaderThrottle();
				if (logIt) {
					const suffix = n > 1 ? ` (occurrence ${n})` : '';
					console.error(
						`[ws] the upgrade hook set an unusable handshake header (${bad})${suffix}; ` +
						'refusing the upgrade rather than writing it to the 101 response.'
					);
				}
				return new Response('Internal Server Error', { status: 500 });
			}
			responseHeaders = ctxHeaders;
		}
		if (result && typeof result === 'object') {
			// Copied key by key rather than Object.assign so a `__proto__` own
			// key (possible whenever a hook spreads parsed client JSON into its
			// userData) lands nowhere instead of re-pointing this object's
			// prototype through the inherited setter. userData stays an
			// ordinary object, so hook code can still call hasOwnProperty on it.
			const source = /** @type {any} */ (result);
			for (const key of Object.keys(source)) {
				if (key === '__proto__') continue;
				data[key] = source[key];
			}
			// A returned `headers` key is now ordinary userData. That is a silent
			// behaviour change for a hook written against the old shape, so say
			// so once rather than dropping its cookie on the floor unexplained.
			if (Object.prototype.hasOwnProperty.call(source, 'headers')) {
				warnReturnedHeaders();
			}
		}
	}

	// Stamped AFTER the hook's data is merged, never before: the slot is a
	// STRING key (Symbols do not survive the upgrade boundary), so a hook that
	// spreads a parsed query or body into its userData could otherwise
	// overwrite the sanitized value with attacker text - and requestId flows
	// into structured logs, which is exactly what resolveRequestId's printable-
	// ASCII whitelist exists to protect.
	data[WS_REQUEST_ID_KEY] = requestId;

	// RE-CHECKED after the app hook. The hook is awaited freely, so a drain can
	// begin and FINISH inside it - the drain advises and closes what it can see,
	// and this connection is not visible yet. Without this the handshake
	// completes onto a process that is already past its drain, so the client
	// gets no advisory, no 1012, and a 1006 when stop(true) lands.
	if (isDraining()) return drainingResponse();

	// GUARDED. Bun validates headers itself and throws on anything it dislikes;
	// an escaping throw here reaches the top-level error handler, which prints a
	// stack plus source context per request with no throttle at all. The
	// validation above should mean this never fires, which is exactly why it
	// must not be the thing standing between a client and 667 bytes of stderr.
	let ok;
	try {
		ok = srv.upgrade(req, responseHeaders ? { data, headers: responseHeaders } : { data });
	} catch (err) {
		const { log: logIt, count: n } = upgradeThrewThrottle();
		if (logIt) {
			const suffix = n > 1 ? ` (occurrence ${n})` : '';
			console.error(`WebSocket handshake was refused by the runtime${suffix}:`, err);
		}
		return new Response('WebSocket upgrade failed', { status: 400 });
	}
	if (ok) return undefined;

	// Bun refused the handshake (a malformed request that carried the upgrade
	// header). Nothing has been written yet, so a plain 400 is safe.
	return new Response('WebSocket upgrade failed', { status: 400 });
}
