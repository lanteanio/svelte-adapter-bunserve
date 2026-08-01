import path from 'node:path';
import './_init.js';
import { base } from './manifest-bridge.js';
import { staticCache, counters } from './handler/state.js';
import { cacheDir, clientDir, prerenderedDir, serveStatic, tryPrerendered } from './handler/static-assets.js';
import { handleSSR } from './handler/ssr.js';
import { requestDone, isDraining } from './handler/lifecycle.js';
import { response400, response500 } from './handler/http-helpers.js';
import { is_tls, ssl_cert, ssl_key, body_size_limit, idle_timeout, ws_options, ws_path } from './handler/config.js';
import { tryUpgrade } from './handler/upgrade.js';
import { websocketHandlers } from './handler/ws.js';
import { setServer } from './handler/ws-state.js';
import { toBunWebsocketOptions } from './utils/ws-options.js';

/* global HEALTH_CHECK_PATH */
/* global READINESS_CHECK_PATH */
/* global STATIC_HEADERS */

const _t_boot = performance.now();

cacheDir(path.join(clientDir, base), base, true, STATIC_HEADERS);
cacheDir(path.join(prerenderedDir, base), base, false, STATIC_HEADERS);
console.log(`Static files indexed in ${(performance.now() - _t_boot).toFixed(1)}ms (${staticCache.size} entries)`);

const healthPath = HEALTH_CHECK_PATH;
const readinessPath = READINESS_CHECK_PATH;

const IS_WIN32 = process.platform === 'win32';

/**
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @returns {Response | Promise<Response>}
 */
function fetchHandler(req, srv) {
	const method = req.method;
	const url = new URL(req.url);
	const pathname = url.pathname;

	if (method === 'GET') {
		// Health check (before the catch-all so it never hits SSR). This is a
		// LIVENESS probe: it reports 200 whenever the process is up, INCLUDING
		// during a graceful drain - so a k8s liveness probe never restarts an
		// instance mid-shutdown.
		if (healthPath && pathname === healthPath) {
			return new Response('OK');
		}
		// Readiness probe, distinct from liveness: 200 when ready and 503 once
		// graceful shutdown has begun, so a fronting load balancer stops routing
		// NEW traffic to a draining instance while its in-flight requests finish.
		if (readinessPath && pathname === readinessPath) {
			return isDraining()
				? new Response('draining', { status: 503 })
				: new Response('OK');
		}
	}

	// === WEBSOCKET UPGRADE ===
	// Before the static and SSR lanes: the WS path is one exact string compare
	// and must never be shadowed by a static asset or the SSR catch-all.
	// Returns null when the request is not for this endpoint.
	const upgraded = tryUpgrade(req, srv, pathname);
	if (upgraded !== null) return upgraded;

	// === STATIC FILE FAST PATH ===
	// Minimum work: 1 Map lookup, no decode, no full URL handling.
	const staticFile = staticCache.get(pathname);
	if (staticFile && (method === 'GET' || method === 'HEAD')) {
		return serveStatic(staticFile, req.headers, method === 'HEAD');
	}

	// Windows: reject paths with : (Alternate Data Streams) or ~ (8.3 short names)
	if (IS_WIN32 && (pathname.includes(':') || pathname.includes('~'))) {
		return response400();
	}

	// === PRERENDERED CHECK ===
	if (method === 'GET' || method === 'HEAD') {
		const prerenderedResponse = tryPrerendered(pathname, url.search, req.headers, method === 'HEAD');
		if (prerenderedResponse) return prerenderedResponse;
	}

	// === SSR catch-all ===
	const ip = srv.requestIP(req);
	const direct = ip ? ip.address : '';
	counters.inFlightCount++;
	return handleSSR(req, direct).finally(requestDone);
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
	console.log(
		`Listening on ${is_tls ? 'https' : 'http'}://${host}:${bunServer.port} (ready in ${(performance.now() - _t_boot).toFixed(0)}ms)`
	);
	if (ws_options) console.log(`WebSocket endpoint registered at ${ws_path}`);
	return bunServer;
}
