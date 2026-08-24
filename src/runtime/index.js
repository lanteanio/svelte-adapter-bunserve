import process from 'node:process';
import { env } from './env.js';
import { setTimer, wallEpoch } from './runtime.js';
import { start } from './server.js';
import { formatVersionBanner, versionInfo } from './version-info.js';
import { drain, markDraining } from './handler/lifecycle.js';
import { drainWebSockets } from './handler/ws-drain.js';
import { beginDraining, wsCounters } from './handler/ws-state.js';
import { stopPressureSampling } from './handler/pressure-metrics.js';
import { runWsLifecycleHook } from './handler/ws-lifecycle.js';

const host = env('HOST', '0.0.0.0');
const port_raw = env('PORT', '3000');

/**
 * @param {string} name
 * @param {string} raw
 * @param {number} min
 */
function parseIntEnv(name, raw, min) {
	const trimmed = raw.trim();
	const n = Number(trimmed);
	if (trimmed === '' || !Number.isInteger(n)) throw new Error(`${name} must be a valid integer, got "${raw}"`);
	if (n < min) throw new Error(`${name} must be >= ${min}, got ${n}`);
	return n;
}

const port = parseIntEnv('PORT', port_raw, 0);
const shutdown_timeout = parseIntEnv('SHUTDOWN_TIMEOUT', env('SHUTDOWN_TIMEOUT', '30'), 0);
const shutdown_delay = parseIntEnv('SHUTDOWN_DELAY_MS', env('SHUTDOWN_DELAY_MS', '0'), 0);

/**
 * Window, in ms, over which draining WebSocket clients spread their reconnect.
 * Each client rolls its own delay inside it, so a fleet does not re-hammer the
 * replacement instance in one backoff tick. 0 disables the advisory and closes
 * connections immediately.
 */
const ws_reconnect_window = parseIntEnv(
	'SHUTDOWN_RECONNECT_WINDOW_MS',
	env('SHUTDOWN_RECONNECT_WINDOW_MS', '3000'),
	0
);

// Single-process by design: multi-node scale-out rides the transport-agnostic
// extensions bus (Redis/Valkey), not in-process clustering. Loud, not silent,
// when a deployment carries the other adapter's cluster knob - read through
// env() so a prefixed deployment gets the same warn-not-throw behavior.
if (env('CLUSTER_WORKERS', undefined) !== undefined) {
	console.warn(
		'[adapter-bunserve] CLUSTER_WORKERS is ignored: this adapter runs single-process. ' +
		'For multi-node deployments use the transport-agnostic extensions bus (Redis/Valkey).'
	);
}

// The version banner, before the listen line: when two surfaces disagree at
// runtime, mixed sibling versions are the usual cause, and this puts the
// resolved answer at the top of every boot log.
console.log(formatVersionBanner(versionInfo()));

const bunServer = start(host, port);

let shutting_down = false;

/** @param {'SIGINT' | 'SIGTERM'} reason */
async function graceful_shutdown(reason) {
	if (shutting_down) return;
	shutting_down = true;
	console.log(`Received ${reason}, shutting down gracefully...`);

	// Latch the WebSocket drain flag FIRST, before anything that can await.
	// The upgrade lane reads it to refuse new handshakes, and everything below
	// - the load-balancer delay, the app's shutdown hook - can take seconds.
	// Latching it inside drainWebSockets instead would leave a window, bounded
	// only by SHUTDOWN_TIMEOUT, where clients are still handed sockets on a
	// process whose shutdown hook has already torn down its pools.
	beginDraining();

	// Step 1: Flip readiness to 503 while STILL accepting, and give the load
	// balancer time to remove this instance from rotation (Kubernetes rolling
	// updates). SHUTDOWN_DELAY_MS=0 (default) skips the wait and is correct
	// for non-k8s deploys.
	markDraining();
	if (shutdown_delay > 0) {
		console.log(`Waiting ${shutdown_delay}ms for load balancer drain...`);
		await new Promise((resolve) => setTimer(resolve, shutdown_delay));
	}

	// Step 1b: Drain WebSockets EXPLICITLY, before the graceful stop.
	// `server.stop()` does not touch them - an echo round-trip still completes
	// after it (probed) - and their close event never fires, so the only thing
	// that would ever end them is `stop(true)`, which cuts every client at once
	// with a 1006 and gives the app's close hooks no chance to run. Advising
	// first lets each client roll its own reconnect delay instead of the whole
	// fleet returning in one tick.
	// Step 1b: the app's one-shot shutdown hook, BEFORE the sockets are drained
	// and before the listener closes. That ordering is the family's contract
	// ("before the listen socket is closed and before existing WebSocket
	// connections are kicked") and it is the useful one: the documented use is
	// flushing a last frame to connected clients or draining a queue through
	// them, all of which need the connections to still exist. Running it after
	// the drain handed it `platform.connections === 0` every time.
	//
	// Bounded by the same shutdown timeout as the SSR drain: an app hook that
	// never resolves must not hold the process open past its deadline.
	// ONE deadline for the whole shutdown, shared by the app hook and the SSR
	// drain below. Racing each against a full SHUTDOWN_TIMEOUT made the worst
	// case two of them plus the WS drain - about 62s at the defaults, against
	// Kubernetes' 30s terminationGracePeriodSeconds. A hook that hangs then
	// consumed the entire grace period and the pod was SIGKILLed before the
	// WebSocket drain ran at all, so every client got the 1006 the drain exists
	// to prevent.
	const budget_ms = shutdown_timeout * 1000;
	const deadline = wallEpoch() + budget_ms;
	// The WebSocket drain is INSIDE the budget. Outside it, the real worst case
	// is SHUTDOWN_DELAY_MS + 30s + the drain's own 2s settle window - over the
	// 30s terminationGracePeriodSeconds this deadline exists to fit inside, so
	// the pod is SIGKILLed at the end of the very sequence meant to avoid that.
	//
	// The SSR drain gets a RESERVED slice. Sharing one deadline strictly leaves
	// it whatever the earlier stages do not eat, so a `shutdown` hook that hangs
	// consumes the whole budget, `Math.max(0, ...)` becomes a zero-length race,
	// and every in-flight HTTP request is cut by the stop(true) a tick later. A
	// misbehaving hook must not turn the request drain into a no-op, so a
	// quarter of the budget is fenced off for it.
	const ssr_drain_reserve_ms = Math.ceil(budget_ms * 0.25);
	const pre_drain_deadline = deadline - ssr_drain_reserve_ms;
	/**
	 * @param {Promise<unknown>} work
	 * @param {number} at
	 */
	const untilDeadline = (work, at) =>
		Promise.race([
			work,
			new Promise((resolve) => setTimer(resolve, Math.max(0, at - wallEpoch())))
		]);

	await untilDeadline(runWsLifecycleHook('shutdown'), pre_drain_deadline);

	await untilDeadline(drainWebSockets(ws_reconnect_window), pre_drain_deadline);

	// Step 2: Graceful stop - refuses new connections; in-flight HTTP requests
	// run to completion (probed Bun.serve semantics). Fire-and-forget: stop()'s
	// own settlement is NOT a gate here, twice over. On runtimes where graceful
	// stop leaves idle connections open (probed), awaiting it would park
	// shutdown on every keep-alive client until the timeout. On runtimes where
	// the promise resolves only when the LAST connection closes, it stays
	// pending on a connection that sent part of a request and then stopped - so
	// a shutdown gated on it hangs on one stalled client until the platform's
	// kill arrives, which on a rolling deploy is a pod that eats its whole
	// grace period and dies by SIGKILL. The gate is the SSR drain counter,
	// raced against the shutdown timeout - same contract as the family's
	// other adapters - and the stop(true) below is what ends a connection that
	// will never finish its request.
	// Older Bun versions return undefined here, current ones a promise; its
	// settlement is deliberately not awaited (see above), so swallow any
	// rejection rather than let it surface as an unhandled rejection during
	// an otherwise clean exit.
	bunServer.stop()?.catch?.(() => {});

	// Stop the pressure sampler once the listener is closed - it kept
	// sampling through the drain above (the drain IS load worth measuring),
	// and stopping before the export hooks are cleared means a late tick can
	// never call a torn-down consumer.
	stopPressureSampling();
	wsCounters.metricsSampleHook = null;
	wsCounters.postureExportHook = null;

	await untilDeadline(drain(), deadline);

	// Emit after drain so handlers can safely close DB pools etc.
	// @ts-expect-error custom events cannot be typed
	process.emit('sveltekit:shutdown', reason);

	// Step 3: Hard-close whatever survived (idle keep-alive connections, a
	// request past the timeout), then exit explicitly - a Bun process can
	// otherwise stay alive on residual event-loop liveness (probed).
	bunServer.stop(true);
	console.log('Shutdown complete.');
	process.exit(0);
}

// Registered BEFORE the init hook is awaited. `init` is where an app opens
// Redis or Postgres, so taking seconds is normal - and a SIGTERM arriving
// during it would otherwise hit no handler at all and default-terminate the
// process: no drain, no advisory, a 1006 for every client and in-flight SSR
// requests dropped. Kubernetes sends SIGTERM to still-booting pods routinely.
process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
process.on('SIGINT', () => graceful_shutdown('SIGINT'));

// The app's one-shot startup hook, after the listener is up so it can publish
// and read platform.connections. A throw here is NOT swallowed: boot failure
// should be loud, and the alternative is serving traffic with a half-armed
// realtime surface whose only symptom is one stderr line.
await runWsLifecycleHook('init');

export { host, port };
