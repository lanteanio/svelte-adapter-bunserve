/**
 * Managed WebSocket drain, run as its own shutdown step.
 *
 * This exists because Bun's graceful stop does NOT end WebSockets. Probed
 * behavior: after `server.stop()` an open socket still completes an echo
 * round-trip, and its close event never arrives; only `stop(true)` ends it, and
 * that cuts every client simultaneously with a 1006 and leaves no window for
 * the app's close hooks to run. So a deployment either hangs waiting for
 * sockets that will never leave, or guillotines them.
 *
 * Draining explicitly fixes both halves: clients are told to come back on a
 * jittered schedule (each rolls its own delay, so a fleet does not return in
 * one tick), then closed with a real code, then given a bounded moment for
 * their close handlers to finish before the process moves on.
 */

import { platform } from './platform.js';
import { beginDraining, pendingCloseHooks, wsConnections } from './ws-state.js';
import { ws_options } from './config.js';
import { setTimer, wallEpoch } from '../runtime.js';

/** How long to wait for connections to actually go before giving up on them. */
const CLOSE_SETTLE_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 25;

/**
 * @param {number} windowMs - reconnect spread; 0 closes immediately with no advisory
 * @returns {Promise<void>}
 */
export async function drainWebSockets(windowMs) {
	// No WebSocket surface configured: nothing was ever registered, and
	// touching the platform here would only construct state at shutdown.
	if (ws_options === null) return;
	// Latch FIRST, before anything is closed. The upgrade lane reads this to
	// refuse new handshakes; an upgrade whose app hook is mid-await right now
	// would otherwise land a fresh connection behind the drain and be cut by
	// stop(true) with no advisory. Latched even when there is nothing live,
	// because "nothing live" is exactly the moment an in-flight upgrade is
	// about to change that.
	beginDraining();
	const live = wsConnections.size;
	// NOTHING live and nothing settling: only then is there genuinely no work.
	// Returning on `live === 0` alone skipped the settle wait below in the most
	// common ordering there is - a load balancer has already taken the clients
	// away, and the close hooks they triggered are still mid-`await` when
	// SIGTERM lands a few milliseconds later. Measured returning in 0ms with a
	// close hook outstanding, which `process.exit(0)` then killed.
	if (live === 0 && pendingCloseHooks.size === 0) return;

	if (live > 0 && windowMs > 0) {
		const advised = platform.adviseReconnect({ windowMs, close: true });
		if (advised < live) {
			// The difference is connections whose advisory could not be written -
			// a client past its backpressure limit. They are still closed, but
			// they never saw the reconnect window and their close frame cannot
			// flush either, so they get a 1006. Say so rather than reporting them
			// as advised.
			console.warn(
				`${live - advised} of ${live} WebSocket connection(s) could not be sent the reconnect ` +
				'advisory (client backpressure); they will see a 1006 rather than 1012.'
			);
		}
		console.log(`Draining ${advised} WebSocket connection(s) over a ${windowMs}ms reconnect window...`);
	} else if (live > 0) {
		// Advisory disabled: still close deliberately rather than leaving them
		// for stop(true), so close hooks run and clients see a real code.
		let closed = 0;
		for (const ws of [...wsConnections]) {
			try {
				ws.end(1012, 'server draining');
				closed++;
			} catch {
				/* already gone; the close handler has run or is about to */
			}
		}
		console.log(`Closed ${closed} WebSocket connection(s) (reconnect advisory disabled).`);
	}

	// Give the close handlers a bounded moment. Not awaited forever: a socket
	// whose client never acknowledges the close would otherwise hold the whole
	// shutdown open, and stop(true) is the backstop for exactly that case.
	//
	// Waits on the in-flight close HOOKS, not only on the registry. Bun runs the
	// server-side close handler synchronously inside `raw.close()`, so
	// `wsConnections` is already empty the moment the loop above returns - a
	// poll watching only the registry exits on its first test and the whole
	// settle window is unreachable. What actually needs the window is an app
	// close hook that awaits (`await redis.srem(...)`): it returns to callHook
	// at its first await and was being killed a few milliseconds later by
	// process.exit. Those promises are tracked for exactly this.
	const deadline = wallEpoch() + CLOSE_SETTLE_TIMEOUT_MS;
	while (
		(wsConnections.size > 0 || pendingCloseHooks.size > 0) &&
		wallEpoch() < deadline
	) {
		await new Promise((resolve) => setTimer(resolve, POLL_INTERVAL_MS));
	}
	if (wsConnections.size > 0) {
		console.warn(
			`${wsConnections.size} WebSocket connection(s) did not close within ${CLOSE_SETTLE_TIMEOUT_MS}ms; ` +
			'they will be cut when the server stops.'
		);
	}
	if (pendingCloseHooks.size > 0) {
		console.warn(
			`${pendingCloseHooks.size} WebSocket close hook(s) had not finished within ` +
			`${CLOSE_SETTLE_TIMEOUT_MS}ms; their remaining work will not complete.`
		);
	}
}
