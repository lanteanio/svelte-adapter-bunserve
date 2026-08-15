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
import { processMonotonicNow, randomFloat, randomUuid } from '../runtime.js';
import { WS_REQUEST_ID_KEY, isDraining, recordUpgradeRejection } from './ws-state.js';
import { get_origin, origin, ws_options, ws_path } from './config.js';
import { WS_CONNECTION_PERMIT, awaitAdmissionSlot, upgradeAdmission } from './admission.js';
import { isCursorLaneUpgrade } from '../utils/upgrade-admission.js';

/** Upgrade-hook throws, throttled with decay. */
const upgradeThrewThrottle = createLogThrottle(() => processMonotonicNow());

/** Refused handshake headers, throttled with decay. */
const badHeaderThrottle = createLogThrottle(() => processMonotonicNow());

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
const originRefusedThrottle = createLogThrottle(() => processMonotonicNow());

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
		'[ws] the upgrade hook returned a `headers` key. Handshake headers belong on the\n' +
		'  context, and the returned key is treated as ordinary userData:\n' +
		'    export function upgrade(request, { headers }) {\n' +
		'      headers[\'sec-websocket-protocol\'] = \'v1\';\n' +
		'      return { user };\n' +
		'    }\n' +
		'  The returned object is frequently built by spreading parsed client input, which makes\n' +
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
 * The base every refusal backs off from: what svelte-adapter-uws derives from
 * its holding page's poll interval. This adapter serves no page, so the number
 * is carried across rather than re-derived - a client that waits half as long
 * against one adapter as the other is a difference an operator only finds under
 * load.
 */
const RETRY_AFTER_BASE_SECONDS = 2;

/**
 * What a shed upgrade gets: a bare 503 telling the client how long to wait.
 *
 * The spread is uws's, arithmetic included, and at the base both adapters use
 * it currently resolves to the base every time: `floor(rand * 2 * 0.5)` is
 * `floor(rand * 1)`, which is 0 for every draw below 1. So a refused fleet does
 * all come back in the same second today, in BOTH adapters - the anti-herd
 * property the shape suggests is not one either of them delivers, and it would
 * take a larger base or a wider spread to become real.
 *
 * It is written as the expression rather than as the constant 2 anyway: the
 * value has to track uws's, and hardcoding the answer to today's arithmetic is
 * how the two silently diverge the moment uws widens either number. Reading the
 * runtime's RNG seam also keeps a simulated run reproducible.
 *
 * uws answers with a holding page instead when its `waitingRoom` is left on,
 * and that page is the one part of its admission surface not implemented here;
 * `ws-options.js` names the gap when a config asks for it.
 */
function shedResponse() {
	const retryAfter = RETRY_AFTER_BASE_SECONDS
		+ Math.floor(randomFloat() * RETRY_AFTER_BASE_SECONDS * 0.5);
	return new Response('Server is at upgrade capacity, please retry', {
		status: 503,
		headers: { 'retry-after': String(retryAfter), 'content-type': 'text/plain' }
	});
}

/**
 * Sheds, throttled with decay - one schedule per reason, so a lane that is
 * refusing constantly cannot silence the first refusal from a different ceiling.
 * Four fixed categories, so this cannot grow with traffic.
 */
const shedThrottles = {
	over_capacity: createLogThrottle(() => processMonotonicNow()),
	cursor_lane: createLogThrottle(() => processMonotonicNow()),
	connection_capacity: createLogThrottle(() => processMonotonicNow()),
	deferred_overflow: createLogThrottle(() => processMonotonicNow())
};

/**
 * Which ceiling refused this upgrade, in an operator's terms: what filled up,
 * how full it is, and which option widens it. Both sides of the comparison are
 * named for the reason the origin refusal names both of its own - "full" without
 * the numbers cannot tell a ceiling that is one short from one set to zero.
 *
 * Read at refusal time, so the numbers are the ones that did the refusing.
 *
 * @param {NonNullable<typeof upgradeAdmission>} gate
 * @param {string} reason
 * @returns {{ state: string, knob: string }}
 */
function shedDetail(gate, reason) {
	switch (reason) {
		case 'cursor_lane':
			return {
				// The main lane's headroom is part of the diagnostic: a cursor
				// refusal while the main lane is nearly empty is the sub-budget
				// doing its job, and raising maxConcurrent would not move it.
				state: `the cursor lane is full (${gate.cursorInFlight} of ${gate.cursorMaxConcurrent} ` +
					`in flight, main lane ${gate.inFlight} of ${gate.maxConcurrent})`,
				knob: 'websocket.upgradeAdmission.cursorLane.fraction'
			};
		case 'connection_capacity':
			return {
				state: `the connection ceiling is full (${gate.connectionPermits} of ` +
					`${gate.maxConnections} reserved or live)`,
				knob: 'websocket.upgradeAdmission.maxConnections'
			};
		case 'deferred_overflow':
			return {
				state: `the pacing queue is full (${gate.deferredDepth} of ${gate.maxDeferred} waiting)`,
				knob: 'websocket.upgradeAdmission.perTickBudget or .maxDeferred'
			};
		default:
			return {
				state: `the concurrent-upgrade ceiling is full (${gate.inFlight} of ` +
					`${gate.maxConcurrent} in flight)`,
				knob: 'websocket.upgradeAdmission.maxConcurrent'
			};
	}
}

/**
 * Refuse an upgrade for want of capacity: count it, say so, and answer.
 *
 * A silent shed is the failure mode this file already names on the origin
 * refusal - the page loads, the socket gets a 503, and the server logs nothing,
 * so a ceiling doing precisely what it was configured to do is indistinguishable
 * from an outage, and the fastest thing that "fixes" it is to turn the ceiling
 * off. The counters are what an exporter reads; the line is what an operator
 * reads today. Neither says anything about the client - no address, no origin,
 * no headers - because a refusal is about this server's capacity.
 *
 * Every capacity refusal goes through here, which is what keeps a later one from
 * being added without its counter.
 *
 * @param {'over_capacity' | 'cursor_lane' | 'connection_capacity' | 'deferred_overflow'} reason
 * @returns {Response}
 */
function shed(reason) {
	recordUpgradeRejection(reason);
	// Unreachable with no controller, every call site being inside a null check
	// already - but a capacity refusal must never be the thing that throws, so
	// the numbers in the line are read through a guard rather than an assumption.
	const gate = upgradeAdmission;
	if (gate === null) return shedResponse();
	const { log: logIt, count: n } = shedThrottles[reason]();
	if (logIt) {
		const { state, knob } = shedDetail(gate, reason);
		const suffix = n > 1 ? ` (occurrence ${n})` : '';
		console.warn(
			`[ws] shed a WebSocket upgrade${suffix}: ${state}.\n` +
			`  The client was told to retry. This is the ceiling working; raise ${knob}\n` +
			'  only if a healthy server is refusing steady-state traffic rather than shedding a burst.'
		);
	}
	return shedResponse();
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
	// BEFORE any per-request work, which is the whole point of the ceilings: a
	// connection storm is shed without spending CPU on header parsing, the
	// origin comparison, or the app's hook. Both counters are taken here and
	// owned by runUpgrade from this line on - it releases the in-flight slot on
	// every path, and hands the connection permit to the socket only when the
	// handshake actually completes.
	//
	// Unconfigured - the default - takes the original path with no wrapper and
	// no extra await. That is not just a saved allocation: the wrapper adds a
	// microtask to every handshake, which reorders the deterministic simulation
	// and moved five golden fingerprints. A feature that is switched off must be
	// invisible, and the golden gate is what proves it.
	if (upgradeAdmission === null) return runUpgrade(req, srv, null);
	// Routed by SUBPROTOCOL, exactly as uws routes it: the worker's second
	// (cursor) socket offers a known token, and its upgrade is admitted only
	// while both the main ceiling and the cursor sub-budget have room. The main
	// lane is never gated by the sub-budget, which is what makes the cursor lane
	// sheddable without it ever being able to starve real clients.
	//
	// Gated on the lane being CARVED, not merely on the token being offered.
	// `tryAcquireCursor` refuses whenever `cursorInFlight >= cursorMaxConcurrent`,
	// and with no lane that ceiling is zero - so `0 >= 0` refuses the first
	// cursor upgrade and every one after it, on a server with full headroom.
	// Without this clause the commonest configurations shed every cursor socket
	// permanently, including the one that asks for the lane but carves it from
	// an unset `maxConcurrent`.
	const cursorLaneEnabled = upgradeAdmission.cursorMaxConcurrent > 0;
	const cursor = cursorLaneEnabled && isCursorLaneUpgrade(req.headers.get('sec-websocket-protocol'));
	if (cursor) {
		// Every cursor refusal is reported as a lane refusal, including one the
		// main ceiling caused, because that is the label uws gives it - and a
		// cursor socket that cannot connect is a cursor-lane symptom either way.
		if (!upgradeAdmission.tryAcquireCursor()) return Promise.resolve(shed('cursor_lane'));
	} else if (!upgradeAdmission.tryAcquire()) {
		return Promise.resolve(shed('over_capacity'));
	}
	if (!upgradeAdmission.tryAcquireConnection()) {
		releaseLane(cursor);
		return Promise.resolve(shed('connection_capacity'));
	}
	return settleUpgrade(req, srv, cursor);
}

/**
 * Give back whichever in-flight slot was taken. The cursor lane holds one slot
 * in each of two counters, so releasing the wrong one leaves the sub-budget
 * permanently spent and the lane refuses every later cursor upgrade.
 *
 * @param {boolean} cursor
 */
function releaseLane(cursor) {
	if (upgradeAdmission === null) return;
	if (cursor) upgradeAdmission.releaseCursorInFlight();
	else upgradeAdmission.release();
}

/** The sibling of `releaseLane` for the whole-lifetime permit. */
function releasePermit() {
	if (upgradeAdmission === null) return;
	upgradeAdmission.releaseConnection();
}

/**
 * The two counters one handshake took, each returnable exactly once, plus the
 * hang-up watch that can return them early.
 *
 * Once-only is the whole point: a hang-up and the handshake's own unwind both
 * end at a release, and `release()` / `releaseCursorInFlight()` are bare
 * decrements. A slot handed back twice reads as free capacity that does not
 * exist, so the gate stops gating; a permit handed back twice throws out of the
 * close callback and strands the app's close hook. uws keeps the same guard
 * (`inFlightReleased`) for the same reason.
 *
 * @param {Request} req
 * @param {boolean} cursor whether the in-flight slot came from the cursor lane
 */
function heldSlots(req, cursor) {
	let lane = true;
	let permit = true;
	const onAbort = () => giveBack();
	req.signal.addEventListener('abort', onAbort, { once: true });

	function giveBack() {
		if (lane) {
			lane = false;
			releaseLane(cursor);
		}
		if (permit) {
			permit = false;
			releasePermit();
		}
	}

	function stopWatching() {
		req.signal.removeEventListener('abort', onAbort);
	}

	return {
		/** `true` while the connection permit is still this handshake's to give. */
		get hasPermit() { return permit; },
		/**
		 * The permit is the socket's from here on - only its close callback
		 * releases it. Called BEFORE the upgrade, not after: `open` is dispatched
		 * synchronously inside `srv.upgrade`, so by the time that call returns a
		 * socket may already have opened, closed, and released this permit.
		 * The hang-up watch comes off in the same breath, because a socket
		 * closing inside that call also fires this request's abort signal.
		 */
		handOver() {
			stopWatching();
			permit = false;
		},
		/** Take the permit back when no socket took it after all. */
		reclaim() { permit = true; },
		/** Stop watching and give back whatever is still held here. */
		settle() {
			stopWatching();
			giveBack();
		}
	};
}

/**
 * Give the connection permit back when the upgrade produced no socket.
 *
 * Reads the same marker the close callback reads, which is what makes the two
 * agree across every ordering. The close callback CLEARS it as it releases, so a
 * marker still set means no socket ever owned the permit and this handshake owes
 * it back; a marker already cleared means a socket took it and gave it back
 * inside `srv.upgrade` itself - which is a real ordering, not a theoretical one,
 * because an `open` hook that closes its socket runs to completion before that
 * call returns.
 *
 * @param {Record<string, any>} data the userData handed to `srv.upgrade`
 * @param {ReturnType<typeof heldSlots> | null} held
 */
function reclaimPermit(data, held) {
	if (held === null) return;
	if (data[WS_CONNECTION_PERMIT] !== true) return;
	data[WS_CONNECTION_PERMIT] = false;
	held.reclaim();
}

/**
 * Owns the two counters `tryUpgrade` took, so no path can leak one.
 *
 * The in-flight slot is released however the handshake ends - refused, thrown,
 * completed, or abandoned - because it measures the UPGRADE WINDOW, which is
 * over either way. The connection permit is different: it measures the socket's
 * whole life, so a completed handshake hands it to the close callback and only a
 * handshake that never produced a socket releases it here.
 *
 * A client that hangs up mid-handshake is the case neither of those covers. The
 * app's `upgrade` hook is the app's: it cannot be cancelled and may await for as
 * long as it likes, so without a hang-up path both counters stay spent for the
 * full hook latency after the client has gone - and a fleet of connect-then-drop
 * clients is precisely the storm the ceiling exists to shed. uws hands both back
 * from `res.onAborted`; the request's abort signal is that same event here, and
 * this runtime fires it within tens of milliseconds of the socket going away
 * rather than at the end of the hook, which is the property the release depends
 * on (`probe/bun-api-facts.report.md`, upgrade-abort).
 *
 * What this deliberately gives up, exactly as uws gives it up: while a hung-up
 * handshake's hook keeps running, it is running OUTSIDE the ceiling. So
 * `maxConcurrent` bounds handshakes in flight, not app hooks in flight, and a
 * connect-then-drop fleet can hold more hooks open than the ceiling's number.
 * Holding the slots instead would mean a storm of clients that have already left
 * keeps out the clients that are still there, which is the worse trade.
 *
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @param {boolean} cursor whether the in-flight slot came from the cursor lane
 * @returns {Promise<Response | undefined>}
 */
async function settleUpgrade(req, srv, cursor) {
	const held = heldSlots(req, cursor);
	try {
		return await runUpgrade(req, srv, held);
	} finally {
		held.settle();
	}
}

/**
 * What a handshake answers with once its client has gone: the slots went back at
 * the hang-up, so there is no longer anything to admit it with. Nothing here
 * reaches a wire - the socket is already gone - but the handler still has to
 * answer, because answering is what ends the request.
 *
 * Deliberately not the shed response: this is a client that left, not a server
 * that refused, and counting it as capacity pressure would report a storm that
 * never happened.
 *
 * @returns {Response}
 */
function abandonedResponse() {
	return new Response('Client went away', { status: 503 });
}

/**
 * @param {Request} req
 * @param {import('bun').Server} srv
 * @param {ReturnType<typeof heldSlots> | null} held the counters this handshake
 *   is holding, or null when nothing is gated.
 * @returns {Promise<Response | undefined>}
 */
async function runUpgrade(req, srv, held) {
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
		recordUpgradeRejection('bad_origin');
		warnOriginRefused(req.headers.get('origin'), selfOrigin);
		return new Response('Forbidden origin', { status: 403 });
	}
	if (!isUpgradeOriginAllowed(req.headers.get('origin'), selfOrigin, ws_options.allowedOrigins)) {
		recordUpgradeRejection('bad_origin');
		warnOriginRefused(req.headers.get('origin'), selfOrigin);
		return new Response('Forbidden origin', { status: 403 });
	}

	// Shutdown has started: refuse rather than hand a client a socket on a
	// process that is about to exit. Checked before the app hook runs so a
	// draining server does no needless session work.
	if (isDraining()) return drainingResponse();

	/** @type {Record<string, any>} */
	const data = {};
	const requestId = resolveRequestId(req.headers.get('x-request-id')) ?? randomUuid();

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
			recordUpgradeRejection('hook_error');
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
		if (result === false) {
			recordUpgradeRejection('auth_rejected');
			return new Response('Unauthorized', { status: 401 });
		}
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
				// Counted as a hook error, which is where uws counts its own
				// equivalent: there the same unusable value throws out of the
				// response builder the app called, inside the hook. Same cause,
				// same answer, so the same label.
				recordUpgradeRejection('hook_error');
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
			// A returned `headers` key is ordinary userData. That silently ignores
			// the handshake intent of a hook that returns one, so say
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

	// Paced LAST, immediately before the socket is taken, so a handshake only
	// waits for its turn once everything that could refuse it has run. Waiting
	// first would spend queue depth on upgrades destined for a 403.
	//
	// Short-circuited rather than awaiting a resolved promise, for the reason
	// tryUpgrade skips its wrapper: an await that is always taken costs a
	// microtask on the unconfigured path and reorders the simulation.
	if (upgradeAdmission !== null) {
		// BEFORE the pacing wait, not after it. A handshake whose client has
		// already gone cannot be completed, so spending a per-tick slot or a
		// queue entry on it takes that place from a client who is still there -
		// the connect-then-drop storm would simply move from the ceiling to the
		// queue. Refusing it here also keeps it out of the shed counters, where
		// it would report capacity pressure that never happened.
		if (!held.hasPermit) return abandonedResponse();
		if (!await awaitAdmissionSlot()) return shed('deferred_overflow');
		// RE-CHECKED, for the reason the check above this exists. The pacing
		// queue parks a handshake across however many turns the budget needs,
		// and the drain latch is taken synchronously on SIGTERM - so a socket
		// admitted from the queue lands on a process that has already walked its
		// live connections and finished draining. It gets no advisory, no 1012,
		// and a 1006 when stop(true) arrives, which is precisely what the
		// earlier re-check was added to prevent.
		if (isDraining()) return drainingResponse();
		// Re-checked after the wait: the client may have left while this
		// handshake was parked, and the pacing queue can park it across many
		// turns.
		if (!held.hasPermit) return abandonedResponse();
		// Stamped before the upgrade rather than after: once `srv.upgrade`
		// returns true the socket may already have been handed to `open`, and a
		// close arriving before this line would then release nothing.
		data[WS_CONNECTION_PERMIT] = true;
		// And handed over before the call, not after it. `srv.upgrade` dispatches
		// `open` SYNCHRONOUSLY, so an `open` that closes its socket - refusing an
		// unauthenticated session, enforcing one socket per user, or the control
		// -egress guard cutting the connection - runs the close callback, and
		// with it the permit release, before this call returns. Holding the
		// permit across the call means that release and this frame's own both
		// count, which throws inside the close callback and strands every
		// teardown behind it. Measured ordering: open, abort, close, then the
		// return (`probe/bun-api-facts.report.md`, upgrade-abort).
		held.handOver();
	}

	// GUARDED. Bun validates headers itself and throws on anything it dislikes;
	// an escaping throw here reaches the top-level error handler, which prints a
	// stack plus source context per request with no throttle at all. The
	// validation above should mean this never fires, which is exactly why it
	// must not be the thing standing between a client and 667 bytes of stderr.
	let ok;
	try {
		ok = srv.upgrade(req, responseHeaders ? { data, headers: responseHeaders } : { data });
	} catch (err) {
		// The permit was handed over on the way in, so take it back unless a
		// socket existed long enough to release it itself.
		reclaimPermit(data, held);
		// Uncounted, as uws leaves it uncounted: a handshake the RUNTIME refused
		// is not one of the reasons its rejection counter carries.
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
	reclaimPermit(data, held);
	return new Response('WebSocket upgrade failed', { status: 400 });
}
