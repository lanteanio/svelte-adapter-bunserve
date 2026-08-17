/**
 * The auth preflight endpoint: a plain HTTP POST the client makes before it
 * opens a socket, so a session cookie can be refreshed on an ordinary response.
 *
 * It exists because a `Set-Cookie` on a 101 is silently dropped by Cloudflare
 * Tunnel and other strict edge proxies. A refresh that rides on the handshake
 * therefore works in development and disappears in production, with no error
 * anywhere - so the family moves it to a request that every proxy understands.
 *
 * Mounted only when the app exports an `authenticate` hook, exactly as
 * svelte-adapter-uws mounts it: an app with no such hook has no endpoint, and
 * the path falls through to ordinary routing rather than answering 405 for a
 * feature it never asked for.
 *
 * On Bun most of the sibling's machinery is unnecessary. It reads the body
 * itself against a stack-allocated request that dies when the callback returns,
 * tracks aborts, and writes the response field by field; here the hook is handed
 * the real `Request` and whatever it answers with becomes the response.
 */

import { platform } from './platform.js';
import { wsModule } from '../ws-handler-bridge.js';
import { createCookies } from '../utils/cookies.js';
import { isAuthOriginAccepted } from '../utils/ws-origin.js';
import { resolveRequestId } from '../utils/request-id.js';
import { createLogThrottle } from '../utils/log-throttle.js';
import { processMonotonicNow, randomUuid } from '../runtime.js';
import { response413, response500 } from './http-helpers.js';
import { auth_path, get_origin, origin, ws_options } from './config.js';
import {
	authRateLimiter,
	authRateLimitExceeded,
	authRateLimitWindowSeconds,
	rateLimitAddress,
	warnRateLimitProxyCollapse,
	AUTH_DOOR
} from './rate-limit.js';
import { isDraining, recordUpgradeRejection } from './ws-state.js';
import { counters } from './state.js';
import { requestDone } from './lifecycle.js';

/**
 * Whether this server serves the endpoint at all.
 *
 * Read through the handler module rather than frozen at load, exactly as the
 * upgrade path reads whether an `upgrade` hook exists. In a build the answer
 * cannot change - the module is generated once - so the two spellings are the
 * same server; reading it keeps this door and that one described the same way,
 * and it is only ever reached by a request that already matched the path.
 *
 * @returns {boolean}
 */
export function authEndpointMounted() {
	return ws_options !== null && typeof wsModule.authenticate === 'function';
}

/**
 * Largest body this door accepts, by the `content-length` it declares.
 *
 * Most preflights carry no body at all - the hook reads the `Cookie` header -
 * so a small cap makes a hostile payload cheap to refuse before the app's
 * credential check is reached. It is the sibling's number.
 *
 * A request that declares no length is bounded by `BODY_SIZE_LIMIT` instead,
 * which the runtime enforces before this handler is entered. So this cap
 * tightens the declared case only, and it is deliberately not enforced by
 * reading the body here: the hook owns the body, and consuming it to measure it
 * would take `await request.json()` away from the app.
 */
const AUTH_BODY_LIMIT = 64 * 1024;

/** Hook throws, throttled with decay. */
const authThrewThrottle = createLogThrottle(() => processMonotonicNow());

/**
 * What a wrong verb gets. Answered rather than left to fall through, because
 * the SSR catch-all would otherwise render the app shell at a URL that is not a
 * page - a 200 with a full HTML document where a client expects a preflight.
 *
 * @returns {Response}
 */
function methodNotAllowed() {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: { allow: 'POST', 'content-type': 'text/plain' }
	});
}

/**
 * What a request that failed the CSRF check gets. No `retry-after` and no
 * detail: nothing about this refusal changes with time, and the client that
 * triggered it is by definition not the one that should be told how.
 *
 * @returns {Response}
 */
function forbiddenOrigin() {
	return new Response('Origin not allowed', {
		status: 403,
		headers: { 'content-type': 'text/plain' }
	});
}

/**
 * What a client over its per-address preflight limit gets. `429`, and a
 * `retry-after` naming the window it has to wait out - the honest number here,
 * because the limiter knows exactly when the allowance comes back.
 *
 * @returns {Response}
 */
function rateLimitedResponse() {
	return new Response('Too many authentication requests', {
		status: 429,
		headers: {
			'retry-after': String(Math.max(1, Math.ceil(authRateLimitWindowSeconds))),
			'content-type': 'text/plain'
		}
	});
}

/**
 * Say why a preflight was refused on origin. Silence here is the same
 * operational trap the upgrade door names: the page loads, the preflight 403s,
 * the socket never opens, and the server logs nothing - so the fastest thing
 * that appears to fix it is turning the guard off.
 *
 * Throttled with decay, because a hostile page can drive it.
 */
const originRefusedThrottle = createLogThrottle(() => processMonotonicNow());

/** @param {string | null} received */
function warnAuthOriginRefused(received) {
	const { log: logIt, count: n } = originRefusedThrottle();
	if (!logIt) return;
	const suffix = n > 1 ? ` (occurrence ${n})` : '';
	// Truncated for volume, not for injection: JSON.stringify already escapes
	// CR/LF and C0, and the value is attacker-controlled.
	const shown = received === null
		? '(none)'
		: JSON.stringify(received.length > 128 ? received.slice(0, 128) + '...' : received);
	console.warn(
		`[ws] refused an auth preflight POST on ${auth_path}${suffix}: Origin ${shown}, and neither ` +
		'`x-requested-with: XMLHttpRequest` nor `sec-fetch-site: same-origin` was present.\n' +
		'  A browser client that goes through the family client store sends the first of those. A native\n' +
		'  client sends none of the three: set `websocket.authPathRequireOrigin: false` to accept it, or\n' +
		'  add its origin to `websocket.allowedOrigins`.'
	);
}

/**
 * Handle a request that targets the auth preflight endpoint.
 *
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @param {string} pathname
 * @returns {Promise<Response> | Response | null} `null` when the request is not
 *   for this endpoint, so the caller continues its normal routing.
 */
export function tryAuthEndpoint(req, srv, pathname) {
	if (pathname !== auth_path || !authEndpointMounted()) return null;
	if (req.method !== 'POST') return methodNotAllowed();

	// Shutdown has started: refuse rather than begin a credential check on a
	// process that is about to exit. The upgrade door refuses for the same
	// reason, and this door has a sharper version of it - a hook that rotates a
	// session in the database and then loses its `Set-Cookie` to a severed
	// connection signs the user out with a token the server has already
	// replaced, which is exactly the vanishing-cookie failure this endpoint
	// exists to remove.
	if (isDraining()) {
		return new Response('Server draining', {
			status: 503,
			headers: { 'retry-after': '1', 'content-type': 'text/plain' }
		});
	}

	// METERED FIRST, ahead of the origin guard, which is the order the upgrade
	// door uses and the OPPOSITE of the sibling's at this door.
	//
	// The sibling meters second so that refused origins are not charged, on the
	// argument that hostile traffic behind a shared NAT would otherwise spend the
	// legitimate clients' whole budget. That argument does not survive contact
	// with this door: `x-requested-with: XMLHttpRequest` is an unverified header
	// any client can set, and setting it passes the guard - so an attacker simply
	// spends the budget anyway, and the only thing the ordering bought was an
	// UNMETERED path. It is not even a cheap one. With no ORIGIN configured -
	// the zero-config default - the guard reconstructs the origin from headers,
	// which allocates and can throw and be caught, per request, unbilled.
	//
	// So every request that reaches this endpoint is charged, refused or not,
	// and the budget is spent on whoever is actually driving the door.
	if (authRateLimiter !== null) {
		const peer = srv.requestIP(req);
		const address = rateLimitAddress(req, peer ? peer.address : '');
		if (authRateLimitExceeded(address)) {
			// Not counted for a client that has already gone, exactly as the
			// upgrade door declines to count one: a connect-then-drop fleet would
			// otherwise write its own noise into the numbers an operator reads to
			// decide whether the app is turning people away.
			if (!req.signal.aborted) recordUpgradeRejection('auth_rate_limit');
			warnRateLimitProxyCollapse(address, AUTH_DOOR);
			return rateLimitedResponse();
		}
	}

	// The self-origin this request is judged against, resolved exactly as the
	// upgrade door resolves it: a configured ORIGIN wins, and without one the
	// origin is reconstructed from the request, whose host the client chose.
	//
	// Resolved BEFORE the guard because the cookie jar needs it too. `req.url`
	// carries the client's `Host` verbatim, so a proxy that rewrites Host to
	// `localhost` (nginx's `proxy_set_header Host $proxy_host` default) would
	// otherwise make the jar's `Secure` default read a plain-http localhost URL
	// and drop `Secure` from every session cookie on an HTTPS site. The SSR path
	// rebuilds its Request on the resolved origin for this same reason.
	let selfOrigin = origin || '';
	if (!selfOrigin) {
		try {
			selfOrigin = get_origin(req.headers);
		} catch {
			selfOrigin = '';
		}
	}

	// BEFORE the app's hook, and before anything is read: the hook is a
	// credential check, and a foreign origin should not be able to make this
	// server run one.
	//
	// Compared against `false` rather than read as truthy, so the guard stays on
	// for a server built before the option existed - which carries no key here at
	// all. Read per request, like `allowedOrigins` on the upgrade path, rather
	// than frozen into a module constant: it is one property read on a door that
	// does a database round trip.
	if (ws_options.authPathRequireOrigin !== false) {
		// An unresolvable self origin cannot be same-origin-checked, and must not
		// be COMPARED: `normalizeOrigin` collapses `/` and a whitespace-only value
		// to the empty string, so an empty selfOrigin would MATCH those rather
		// than matching nothing. The upgrade door refuses on the same condition.
		if (ws_options.allowedOrigins === 'same-origin' && !selfOrigin) {
			warnAuthOriginRefused(req.headers.get('origin'));
			return forbiddenOrigin();
		}
		if (!isAuthOriginAccepted(req.headers, selfOrigin, ws_options.allowedOrigins)) {
			warnAuthOriginRefused(req.headers.get('origin'));
			return forbiddenOrigin();
		}
	}

	// Oversize is refused before the hook, for the reason the cap exists: a
	// preflight normally carries nothing, so a large body is not a client this
	// door needs to spend a credential check on.
	const declaredHeader = req.headers.get('content-length');
	if (declaredHeader === null) {
		// A body with no declared length cannot be capped without reading it, and
		// reading it here would take `await request.json()` away from the hook. So
		// it is REFUSED rather than waved through: an undeclared body is the one
		// shape that would make the cap decoration, since a client need only omit
		// the header to send an endless one. The family client always declares a
		// length, and a preflight with no body at all is unaffected.
		if (req.headers.get('transfer-encoding') !== null) {
			return new Response('Length Required', {
				status: 411,
				headers: { 'content-type': 'text/plain' }
			});
		}
	} else {
		const declared = Number(declaredHeader);
		// A length that is not a number at all is refused too: it is not a request
		// any client this endpoint serves produces, and waving it through would
		// leave the cap deciding nothing.
		if (!Number.isFinite(declared) || declared > AUTH_BODY_LIMIT) return response413();
	}

	return runAuthenticate(req, srv, selfOrigin);
}

/**
 * Run the app's hook and turn what it answers with into the response.
 *
 * COUNTED AS IN-FLIGHT, like the SSR path: `drain()` waits on that counter, and
 * a credential check invisible to it is one a graceful shutdown severs
 * mid-rotation.
 *
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @param {string} selfOrigin this server's resolved origin, or '' when it could
 *   not be resolved
 * @returns {Promise<Response>}
 */
function runAuthenticate(req, srv, selfOrigin) {
	counters.inFlightCount++;
	return authenticateRequest(req, srv, selfOrigin).finally(requestDone);
}

/**
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @param {string} selfOrigin
 * @returns {Promise<Response>}
 */
async function authenticateRequest(req, srv, selfOrigin) {
	const requestId = resolveRequestId(req.headers.get('x-request-id')) ?? randomUuid();
	// Prototype-linked, exactly as the SSR path builds its own: one object per
	// request carrying this request's identity, with every method still
	// resolving to the shared singleton.
	const authPlatform = Object.assign(Object.create(platform), { requestId });

	// The jar reads the request's Cookie header and accumulates what the hook
	// sets. Built on the RESOLVED origin rather than on `req.url`: the Secure
	// default and relative Path resolution both come from this URL, and `req.url`
	// carries whatever Host the client sent - so behind a proxy that rewrites it
	// to localhost, every session cookie would go out without `Secure`. The path
	// still comes from the request, because that is what a relative cookie path
	// resolves against.
	const jarUrl = selfOrigin
		? selfOrigin + new URL(req.url).pathname
		: req.url;
	const cookies = createCookies(req.headers.get('cookie'), jarUrl);

	const peer = srv.requestIP(req);
	// Resolved exactly as the limiter's key is, and never throwing for the same
	// reason: a proxy that drops the configured header on some hop would
	// otherwise turn every sign-in into a 500. An app that needs the address to
	// be answerable should read it from the header itself.
	const address = rateLimitAddress(req, peer ? peer.address : '');

	let result;
	try {
		result = await wsModule.authenticate(req, {
			platform: authPlatform,
			cookies,
			getClientAddress: () => address
		});
	} catch (err) {
		// Throttled like every other hook-error site, and for the sharpest
		// version of the reason: this door is plain HTTP with no socket and no
		// Origin needed, so a hook that throws on malformed input is the cheapest
		// stderr amplifier in the adapter.
		const { log: logIt, count: n } = authThrewThrottle();
		if (logIt) {
			const suffix = n > 1 ? ` (occurrence ${n})` : '';
			console.error(`WebSocket auth preflight error${suffix} (requestId ${requestId}):`, err);
		}
		return response500();
	}

	// GUARDED, and not merely for tidiness: everything below can throw on input
	// the hook chose. `new Response(body, init)` throws on a body that has
	// already been read - which is what a hook returning a MODULE-LEVEL constant
	// Response does on its second request - and on a status the constructor
	// refuses, and `headers.append` throws on a cookie line carrying a value the
	// Headers API rejects. Outside a guard each of those escapes as a rejected
	// promise into the server's top-level error handler, which prints a stack
	// per request with no throttle at all: the exact amplifier the throttle above
	// exists to close, reachable by an app pattern rather than by an attack.
	try {
		// `false` REJECTS with a plain 401, matching the family. Any cookie the
		// hook set on its way to that decision still goes out: clearing a stale
		// session is exactly what a refusing hook does.
		if (result === false) {
			return withCookies(
				new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
				cookies
			);
		}

		// A Response from the hook IS the answer, verbatim - status, headers, body
		// - with the jar's cookies merged in, so `cookies.set()` and a returned
		// Response work together rather than one silently winning.
		if (result instanceof Response) return withCookies(new Response(result.body, result), cookies);

		// Anything else is success, including the `undefined` a hook that only
		// refreshes a cookie returns.
		return withCookies(new Response(null, { status: 204 }), cookies);
	} catch (err) {
		const { log: logIt, count: n } = authThrewThrottle();
		if (logIt) {
			const suffix = n > 1 ? ` (occurrence ${n})` : '';
			console.error(
				`WebSocket auth preflight could not answer${suffix} (requestId ${requestId}). A hook that ` +
				'returns a module-level Response hits this on its second request, because a body can only ' +
				'be read once - return a fresh Response per call:',
				err
			);
		}
		return response500();
	}
}

/**
 * Append the jar's `Set-Cookie` lines to a response.
 *
 * APPENDED, never set: a hook that returned its own Response may already carry
 * cookies of its own, and a `set` would drop them.
 *
 * @param {Response} res
 * @param {ReturnType<typeof createCookies>} cookies
 * @returns {Response}
 */
function withCookies(res, cookies) {
	for (const line of cookies._serialize()) res.headers.append('set-cookie', line);
	return res;
}
