// Readiness-gated boot warmup.
//
// A cold SvelteKit SSR render costs about twenty times a warm one. Measured on
// THIS runtime rather than carried over from the sibling: on Bun 1.3.14 against
// the repository fixture, the first render of `/` took 16.1-18.0 ms and the
// settled mean was 0.75-0.92 ms, a ratio of 17-24x across runs. The second
// request is already near-warm (~1.6 ms), so the whole penalty lands on
// whichever client arrives first after a deploy.
//
// A load balancer will not route until the readiness probe reports ready, so a
// warmup pass run DURING the `starting` window - after the app's init hook,
// before the flip to `ready` - guarantees the render path is warm before the
// first real client is ever routed in. A bare boot-time request burst cannot
// make that guarantee: it races the balancer.
//
// Only the SSR lane is warmed, because only it was measured to pay: a static or
// health route already answers at warm latency.
//
// The warmup render goes straight through `server.respond`, the same engine
// entry a real request reaches, with a Request this module constructs and tags
// in a WeakSet. The tag is by object identity, never a header, so a real client
// cannot forge a request that reads as synthetic; `platform.isWarmupRequest`
// lets an app's own hooks recognise the warmup render and skip the side effects
// a real visit would incur (analytics, rate counting, audit log).

import { server } from '../_init.js';
import { origin } from './config.js';
import { monotonicNow, setTimer, clearTimer } from '../runtime.js';
import { isDedupBufferable } from './ssr-dedup.js';
import { tagWarmupRequest } from './warmup-registry.js';

// A warmup runs on the readiness-critical boot path: readiness cannot commit
// until it returns, so it has to be BOUNDED in every direction. Each render is
// aborted if it outlasts the per-render budget, and the whole pass is raced
// against a total budget so readiness flips even if a render ignores its abort
// (a synchronous stall in app code cannot be interrupted at all). Warmup is
// best-effort: a bound that trips loses the warmup, never readiness.
const WARMUP_RENDER_BUDGET_MS = 5000;
const WARMUP_TOTAL_BUDGET_MS = 15000;

/** A warmup render needs a client address only if the app asks for one. */
function warmupClientAddress() {
	return '127.0.0.1';
}

/**
 * Render each path once through the real SSR engine so the render path, the
 * app's lazy server modules and the JIT are warm before readiness commits.
 *
 * Never throws: a warmup is an optimization, not a correctness gate, so a
 * failed render is reported and boot continues to `ready`.
 *
 * @param {string[]} paths absolute pathnames, e.g. ['/']
 * @param {object} platform the request platform passed to `server.respond`
 * @returns {Promise<number>} how many paths rendered without error
 */
export async function warmSSR(paths, platform) {
	// A warmup render has no incoming Host header to derive an origin from, so
	// it uses the configured ORIGIN when set and a loopback placeholder
	// otherwise. Which origin it is does not matter - the point is to warm the
	// render engine, not to produce a client-facing URL.
	const base = origin || 'http://localhost';
	let warmed = 0;
	for (const p of paths) {
		try {
			// Abort a render that outlasts its budget: an app load awaiting a
			// resource that is not up at boot must not hold readiness. SvelteKit
			// honours the request signal, so an aborted render rejects here and
			// is contained by the catch.
			const request = new Request(base + p, {
				method: 'GET',
				signal: AbortSignal.timeout(WARMUP_RENDER_BUDGET_MS)
			});
			tagWarmupRequest(request);
			const response = await server.respond(request, {
				platform,
				getClientAddress: warmupClientAddress
			});
			// Drain a FINITE body so the full render completes rather than
			// parking half-done. A never-ending stream (an SSE route) must NOT
			// be buffered - arrayBuffer() on it would await forever and hang
			// readiness - so cancel it instead; its headers and first render
			// already warmed the path. Same rule the real SSR dedup path applies.
			if (response.body) {
				if (isDedupBufferable(response)) await response.arrayBuffer();
				else await response.body.cancel();
			}
			warmed++;
		} catch (err) {
			console.warn(
				`[adapter-bunserve] a boot warmup render of ${p} failed; readiness proceeds without it:`,
				err instanceof Error ? err.message : err
			);
		}
	}
	return warmed;
}

/**
 * Run the configured warmup during the `starting` window. Bounded and
 * best-effort: it logs what it warmed and how long it took, and never rejects.
 *
 * @param {{ paths: string[], platform: object }} config
 * @returns {Promise<void>}
 */
export async function runWarmup(config) {
	const paths = Array.isArray(config?.paths) && config.paths.length > 0 ? config.paths : ['/'];
	const t0 = monotonicNow();
	// The total-budget backstop: readiness commits within this bound whatever a
	// render does. Resolves to a sentinel on timeout; a warmup still running
	// past it settles on its own per-render aborts and its result is discarded.
	const TIMED_OUT = -1;
	let timer;
	const budget = new Promise((resolve) => {
		timer = setTimer(() => resolve(TIMED_OUT), WARMUP_TOTAL_BUDGET_MS);
		// Unref'd so a warmup budget can never be the thing holding the process
		// open - the timer outlives the race it lost.
		if (typeof timer?.unref === 'function') timer.unref();
	});
	const warmed = await Promise.race([warmSSR(paths, config.platform), budget]);
	clearTimer(timer);
	const ms = (monotonicNow() - t0).toFixed(0);
	if (warmed === TIMED_OUT) {
		console.warn(
			`[adapter-bunserve] the boot warmup exceeded its ${WARMUP_TOTAL_BUDGET_MS}ms total budget; ` +
			'readiness proceeds without it.'
		);
	} else if (warmed > 0) {
		console.log(`[adapter-bunserve] Warmed ${warmed} SSR path(s) before readiness (${ms}ms)`);
	}
}
