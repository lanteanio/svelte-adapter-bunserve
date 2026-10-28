import path from 'node:path';
import './_init.js';
import { base } from './manifest-bridge.js';
import { staticCache } from './handler/state.js';
import { cacheDir, clientDir, encodedStaticEntry, prerenderedDir, serveStatic, tryPrerendered } from './handler/static-assets.js';
import { httpMetrics } from './handler/http-metrics.js';
import { handleSSR } from './handler/ssr.js';
import { adminRouteMounted, tryAdminEndpoint } from './handler/admin.js';
import { isDraining, isStarting } from './handler/lifecycle.js';
import { response400, response500 } from './handler/http-helpers.js';
import { auth_path, admin_path, is_tls, ssl_cert, ssl_key, body_size_limit, idle_timeout, ws_options, ws_path } from './handler/config.js';
import { countRefusedHandshakeTarget, tryUpgrade } from './handler/upgrade.js';
import { invalidHost, invalidRequestTarget, requestTarget } from './utils/request-target.js';
import { ownExactMounts, shadowsExactMount } from './utils/exact-mount.js';
import { windowsReservedPath } from './utils/windows-path.js';
import { upgradeAdmission } from './handler/admission.js';
import { authEndpointMounted, tryAuthEndpoint } from './handler/auth.js';
import { canonicalRedirectEnabled, tryCanonicalHostRedirect } from './handler/canonical-host.js';
import { websocketHandlers } from './handler/ws.js';
import { setServer } from './handler/ws-state.js';
import { startPressureSampling } from './handler/pressure-metrics.js';
import { toBunWebsocketOptions } from './utils/ws-options.js';
import { now, processMonotonicNow } from './runtime.js';

/* global HEALTH_CHECK_PATH */
/* global READINESS_CHECK_PATH */
/* global STATIC_HEADERS */
/* global STATIC_CACHE_CONTROL */

const _t_boot = processMonotonicNow();

cacheDir(path.join(clientDir, base), base, true, STATIC_HEADERS, STATIC_CACHE_CONTROL);
cacheDir(path.join(prerenderedDir, base), base, false, STATIC_HEADERS, STATIC_CACHE_CONTROL);
console.log(`Static files indexed in ${(processMonotonicNow() - _t_boot).toFixed(1)}ms (${staticCache.size} entries)`);

const healthPath = HEALTH_CHECK_PATH;
const readinessPath = READINESS_CHECK_PATH;
if (adminRouteMounted()) {
 console.log(`[svelte-adapter-bunserve] Admin route registered at ${admin_path}/*`);
 if (!ws_options.adminAuthAcknowledged) console.warn(`[svelte-adapter-bunserve] Warning: Admin route ${admin_path}/* is mounted with NO adapter-level authentication. It is publicly reachable unless the app's admin() handler gates it (e.g. by validating a session cookie or bearer token). Set websocket.adminAuthAcknowledged: true once it is gated to silence this.`);
}

const IS_WIN32 = process.platform === 'win32';

/** The paths answered ahead of the app's routes; see `ownExactMounts`. */
const exactMounts = ownExactMounts({
	healthPath,
	readinessPath,
	authPath: authEndpointMounted() ? auth_path : null,
	wsPath: ws_options !== null && upgradeAdmission !== null ? ws_path : null
});

/**
 * A liveness/readiness probe answer, with the HEAD form carrying the same
 * status and headers as the GET and no body. Content-Length is stated rather
 * than left to the runtime: on a body-less response there is nothing to infer
 * it from, and a probe that reports 0 bytes for a 2-byte body is exactly the
 * kind of small lie a HEAD request exists to avoid.
 *
 * @param {string} body
 * @param {number} status
 * @param {boolean} isHead
 * @returns {Response}
 */
function probeResponse(body, status, isHead) {
	return new Response(isHead ? null : body, {
		status,
		headers: {
			'content-type': 'text/plain;charset=utf-8',
			'content-length': String(Buffer.byteLength(body))
		}
	});
}

/**
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @returns {Response | Promise<Response>}
 */
function fetchHandler(req, srv) {
	httpMetrics.begin(req);
	const complete = response => {
		httpMetrics.response(req, response);
		return req.method === 'HEAD' ? withHeadDate(response) : response;
	};
	try {
		const response = routeRequest(req, srv);
		return response instanceof Promise ? response.then(complete, error => { httpMetrics.failed(req); throw error; }) : complete(response);
	} catch (error) { httpMetrics.failed(req); throw error; }
}

let dateSecond = NaN;
let dateHeader = '';
/** Bun omits its automatic Date on HEAD; provide the current server date. */
function withHeadDate(response) {
	if (!response) return response;
	const second = Math.floor(now() / 1000);
	if (second !== dateSecond) {
		dateSecond = second;
		dateHeader = new Date(second * 1000).toUTCString(); // determinism-allow: formats the injected runtime clock
	}
	try {
		response.headers.set('date', dateHeader);
		return response;
	} catch {
		// Fetch responses may have immutable headers. This fallback only handles
		// those responses; mutable native bodies retain Bun's inferred length.
		const headers = new Headers(response.headers);
		headers.set('date', dateHeader);
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	}
}

/** @param {Request} req @param {import('bun').Server} srv */
function routeRequest(req, srv) {
	const method = req.method;
	// A target RFC 9112 does not allow, refused 400 ahead of every lane - the
	// probes, the WebSocket handshake and the built assets included - as on
	// svelte-adapter-uws. Bun has encoded or refused the rest of what that
	// adapter refuses here, so what is left to see is a fragment, which would
	// otherwise be read off as one: `/healthz#frag` as the probe.
	const href = requestTarget(req);
	if (invalidRequestTarget(href) || invalidHost(req.headers.get('host'))) {
		countRefusedHandshakeTarget(req);
		return response400();
	}
	const query = href.indexOf('?');
	const pathname = query === -1 ? href : href.slice(0, query);
	const search = query === -1 ? '' : href.slice(query);

	// HEAD as well as GET: a probe answering GET but 404ing HEAD is worse than
	// one that does not exist, because a load balancer configured to probe with
	// HEAD marks every instance permanently unhealthy and the endpoint looks
	// fine to anyone checking it by hand.
	if (method === 'GET' || method === 'HEAD') {
		// Health check (before the catch-all so it never hits SSR). This is a
		// LIVENESS probe: it reports 200 whenever the process is up, INCLUDING
		// during a graceful drain - so a k8s liveness probe never restarts an
		// instance mid-shutdown.
		if (healthPath && pathname === healthPath) {
			return probeResponse('OK', 200, method === 'HEAD');
		}
		// Readiness probe, distinct from liveness: 200 when ready and 503 once
		// graceful shutdown has begun, so a fronting load balancer stops routing
		// NEW traffic to a draining instance while its in-flight requests finish.
		if (readinessPath && pathname === readinessPath) {
			if (isDraining()) return probeResponse('draining', 503, method === 'HEAD');
			// Not ready YET is the other 503: the listener is up (the init hook
			// needs it) but the boot warmup has not finished, so routing here
			// would hand the first client the cold render.
			if (isStarting()) return probeResponse('starting', 503, method === 'HEAD');
			return probeResponse('OK', 200, method === 'HEAD');
		}
	}

	// === WEBSOCKET UPGRADE ===
	// Before the static and SSR lanes: the WS path is one exact string compare
	// and a handshake must never be shadowed by a static asset or the SSR
	// catch-all.
	// Returns null when the request is not this endpoint's to answer, which
	// includes every request on the path that is not a GET.
	const upgraded = tryUpgrade(req, srv, pathname);
	if (upgraded !== null) return upgraded;

	// === AUTH PREFLIGHT ===
	// Alongside the upgrade lane and ahead of static and SSR, for the same
	// reason: it is one exact string compare against an adapter-owned path, and
	// the SSR catch-all would otherwise render the app shell at a URL that is not
	// a page. Returns null when the request is not for this endpoint - which
	// includes every request on a server whose handler exports no `authenticate`,
	// since nothing is mounted there at all.
	const authenticated = tryAuthEndpoint(req, srv, pathname);
	if (authenticated !== null) return authenticated;

	const admin = tryAdminEndpoint(req, href);
	if (admin !== null) return admin;

	// === STATIC FILE FAST PATH ===
	// Minimum work: 1 Map lookup, no decode, no full URL handling.
	if (canonicalRedirectEnabled) {
		const redirected = tryCanonicalHostRedirect(req, href);
		if (redirected) return redirected;
	}

	const staticFile = staticCache.get(pathname);
	if (staticFile && (method === 'GET' || method === 'HEAD')) {
		return serveStatic(staticFile, req.headers, method === 'HEAD');
	}

	// Windows: refuse a path naming an alternate data stream (`:`) or an 8.3
	// short name (`~`), in the raw spelling and the decoded one - every lane
	// below decodes before it opens anything.
	if (IS_WIN32 && windowsReservedPath(pathname)) {
		return response400();
	}

	// === OWN PATHS, SPELLED ANOTHER WAY ===
	// A request SvelteKit would route onto one of the paths answered above
	// without spelling it - `/healthz/__data.json`, `/%68ealthz` - is refused,
	// as svelte-adapter-uws refuses it: it would reach the app's router as that
	// path. Every method, since it is read as that path whichever it is.
	if (shadowsExactMount(exactMounts, pathname, search)) return response400();

	if (adminRouteMounted() && !pathname.startsWith(admin_path + '/') && pathname.includes('%')) {
		const decoded = pathname.replace(/%([0-7][0-9a-f])/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
		if (decoded.startsWith(admin_path + '/')) return response400();
	}

	// === PRERENDERED CHECK ===
	if (method === 'GET' || method === 'HEAD') {
		const prerenderedResponse = tryPrerendered(pathname, search, req.headers, method === 'HEAD');
		if (prerenderedResponse) return prerenderedResponse;

		// A static file whose name a browser percent-encodes, asked for that
		// way: the fast path above matched the target as sent, which for such a
		// name never is the name.
		const encodedFile = pathname.includes('%') ? encodedStaticEntry(pathname) : undefined;
		if (encodedFile !== undefined) return serveStatic(encodedFile, req.headers, method === 'HEAD');
	}

	// === SSR catch-all ===
	const ip = srv.requestIP(req);
	const direct = ip ? ip.address : '';
	return handleSSR(req, direct);
}

/** @type {import('bun').Server | null} */
let bunServer = null;

/**
 * Start Bun.serve. Synchronous - the socket is bound when this returns.
 * @param {string} host
 * @param {number} port
 * @returns {import('bun').Server}
 */
export function start(host, port) {
	bunServer = Bun.serve({
		hostname: host,
		port,
		development: false,
		// Same env surface as BODY_SIZE_LIMIT's SSR precheck; 0 disables the cap.
		maxRequestBodySize: Number.isFinite(body_size_limit) && body_size_limit > 0
			? body_size_limit
			: Number.MAX_SAFE_INTEGER,
		// Set explicitly rather than inherited: Bun's ~10s default treats a
		// quiet RESPONSE as idle, so it severs a slow SSE or streaming render
		// mid-flight. See IDLE_TIMEOUT in handler/config.js.
		idleTimeout: idle_timeout,
		...(is_tls ? { tls: { cert: Bun.file(ssl_cert), key: Bun.file(ssl_key) } } : {}),
		// The websocket handler set is only installed when the build found a
		// handler module, so an app with no realtime code carries no WS surface
		// and no per-connection bookkeeping.
		...(ws_options ? { websocket: { ...toBunWebsocketOptions(ws_options), ...websocketHandlers } } : {}),
		fetch: fetchHandler,
		error(err) {
			console.error('Request error:', err);
			return response500();
		}
	});
	// The platform reaches the server through this for topic fan-out
	// (server.publish) and the native membership count (server.subscriberCount).
	setServer(bunServer);
	// Start the 1 Hz pressure sampler whenever the WS surface exists - the
	// zero-config path always samples, exactly like the sibling adapter, so
	// platform.pressure is live without any option set. The timer is unref'd
	// and costs one bounded walk per second.
	if (ws_options) startPressureSampling(ws_options.pressure);
	console.log(
		// LISTENING, not ready. The socket is bound here - the app's init hook
		// needs it - but readiness answers 503 until the init hook and the boot
		// warmup have both settled, so calling this line "ready" would name the
		// wrong event and invite exactly the deploy that routes into a cold
		// render.
		`Listening on ${is_tls ? 'https' : 'http'}://${host}:${bunServer.port} (listening in ${(processMonotonicNow() - _t_boot).toFixed(0)}ms)`
	);
	if (ws_options) console.log(`WebSocket endpoint registered at ${ws_path}`);
	// Only when it exists: an app with no `authenticate` hook has no endpoint
	// here, and a line naming one would send an operator looking for a route that
	// answers nothing.
	if (authEndpointMounted()) console.log(`WebSocket auth endpoint registered at ${auth_path}`);
	return bunServer;
}
