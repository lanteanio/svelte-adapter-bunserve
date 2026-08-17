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
import { rateLimitAddress } from './rate-limit.js';

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
		// The same self-origin resolution the upgrade door uses, so one
		// `allowedOrigins` means one thing across both. A configured ORIGIN wins;
		// without it the origin is reconstructed from the request, whose host the
		// client chose - which the upgrade path already warns about once.
		let selfOrigin = origin || '';
		if (!selfOrigin) {
			try {
				selfOrigin = get_origin(req.headers);
			} catch {
				selfOrigin = '';
			}
		}
		if (!isAuthOriginAccepted(req.headers, selfOrigin, ws_options.allowedOrigins)) {
			warnAuthOriginRefused(req.headers.get('origin'));
			return forbiddenOrigin();
		}
	}

	// Declared oversize is refused before the hook, for the reason the cap
	// exists: a preflight normally carries nothing, so a large declared body is
	// not a client this door needs to spend a credential check on.
	const declared = Number(req.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > AUTH_BODY_LIMIT) return response413();

	return runAuthenticate(req, srv);
}

/**
 * Run the app's hook and turn what it answers with into the response.
 *
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @returns {Promise<Response>}
 */
async function runAuthenticate(req, srv) {
	const requestId = resolveRequestId(req.headers.get('x-request-id')) ?? randomUuid();
	// Prototype-linked, exactly as the SSR path builds its own: one object per
	// request carrying this request's identity, with every method still
	// resolving to the shared singleton.
	const authPlatform = Object.assign(Object.create(platform), { requestId });

	// The jar reads the request's Cookie header and accumulates what the hook
	// sets. `request.url` is absolute, which is what the Secure default and
	// relative Path resolution are derived from.
	const cookies = createCookies(req.headers.get('cookie'), req.url);

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

	// `false` REJECTS with a plain 401, matching the family. Any cookie the hook
	// set on its way to that decision still goes out: clearing a stale session is
	// exactly what a refusing hook does.
	if (result === false) {
		return withCookies(
			new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
			cookies
		);
	}

	// A Response from the hook IS the answer, verbatim - status, headers, body -
	// with the jar's cookies merged in, so `cookies.set()` and a returned
	// Response work together rather than one silently winning.
	if (result instanceof Response) return withCookies(new Response(result.body, result), cookies);

	// Anything else is success, including the `undefined` a hook that only
	// refreshes a cookie returns.
	return withCookies(new Response(null, { status: 204 }), cookies);
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
