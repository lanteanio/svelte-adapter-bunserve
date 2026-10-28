/* global WARMUP_PATHS */
import process from 'node:process';
import { env } from './env.js';
import { setTimer } from './runtime.js';
import { start } from './server.js';
import { formatVersionBanner, versionInfo } from './version-info.js';
import { abortInFlightRequests, drain, markDraining, markReady } from './handler/lifecycle.js';
import { runWarmup } from './handler/warmup.js';
import { platform } from './handler/platform.js';
import { drainWebSockets } from './handler/ws-drain.js';
import { beginDraining, wsCounters } from './handler/ws-state.js';
import { stopPressureSampling } from './handler/pressure-metrics.js';
import { runWsLifecycleHook } from './handler/ws-lifecycle.js';
import { shutdownBudget, runShutdownCleanup } from './handler/shutdown.js';

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

function force_shutdown() {
	try {
		abortInFlightRequests();
	} finally {
		try { bunServer.stop(true); }
		finally { process.exit(1); }
	}
}

/** @param {'SIGINT' | 'SIGTERM'} reason */
async function graceful_shutdown(reason) {
	if (shutting_down) {
		force_shutdown();
		return;
	}
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

	const budget = shutdownBudget(shutdown_timeout);
	const context = { reason, signal: budget.signal, deadline: budget.deadline };
	let clean = true;
	try {
		clean = await budget.wait(runWsLifecycleHook('shutdown', context)) && clean;
		clean = await budget.wait(drainWebSockets(ws_reconnect_window)) && clean;
		bunServer.stop()?.catch?.(() => {});
		stopPressureSampling();
		wsCounters.metricsSampleHook = null;
		wsCounters.postureExportHook = null;
		clean = await budget.wait(drain()) && clean;
		abortInFlightRequests();
		clean = await runShutdownCleanup(reason, budget) && clean;
	} catch (err) {
		clean = false;
		console.error('[shutdown] cleanup failed:', err);
	} finally {
		abortInFlightRequests();
		budget.clear();
		bunServer.stop(true);
		console.log(clean ? 'Shutdown complete.' : 'Shutdown budget expired or cleanup failed.');
		process.exit(0);
	}
}
// Registered BEFORE the init hook is awaited. `init` is where an app opens
// Redis or Postgres, so taking seconds is normal - and a SIGTERM arriving
// during it would otherwise hit no handler at all and default-terminate the
// process: no drain, no advisory, a 1006 for every client and in-flight SSR
// requests dropped. Kubernetes sends SIGTERM to still-booting pods routinely.
let booted = false;
/** @type {'SIGINT' | 'SIGTERM' | null} */
let boot_signal = null;
/** @param {'SIGINT' | 'SIGTERM'} reason */
function onSignal(reason) {
	if (booted) { void graceful_shutdown(reason); return; }
	if (boot_signal) { force_shutdown(); return; }
	boot_signal = reason;
	beginDraining();
	markDraining();
}
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

// The app's one-shot startup hook, after the listener is up so it can publish
// and read platform.connections. A throw here is NOT swallowed: boot failure
// should be loud, and the alternative is serving traffic with a half-armed
// realtime surface whose only symptom is one stderr line.
await runWsLifecycleHook('init');

// Warm the SSR render path before readiness commits, so the first client a load
// balancer routes in does not pay the cold render. After the init hook, because
// an app's lazy server modules are what a warmup is warming and init is where
// they are wired up. Bounded and best-effort - it never rejects - and readiness
// commits either way: an instance that never reports ready is worse than one
// whose first render is cold.
if (!boot_signal && WARMUP_PATHS.length > 0) {
	await runWarmup({ paths: WARMUP_PATHS, platform });
}
booted = true;
if (boot_signal) await graceful_shutdown(boot_signal);
else markReady();

export { host, port };
