import { counters } from './state.js';

/** @type {Array<() => void>} */
let drainResolvers = [];

/** Called when an SSR request handler settles (see counters.inFlightCount). */
export function requestDone() {
	counters.inFlightCount--;
	if (counters.inFlightCount === 0 && drainResolvers.length > 0) {
		for (const resolve of drainResolvers) resolve();
		drainResolvers = [];
	}
}

/**
 * Returns a promise that resolves when all in-flight SSR requests have completed.
 * @returns {Promise<void>}
 */
export function drain() {
	if (counters.inFlightCount === 0) return Promise.resolve();
	return new Promise((resolve) => { drainResolvers.push(resolve); });
}

/**
 * True once graceful shutdown has begun. The readiness route reports a 503
 * while draining so a fronting load balancer stops routing NEW traffic to this
 * instance (it stays live - the process is up - but is no longer ready) while
 * in-flight requests finish. Liveness (`healthCheckPath`) is unaffected.
 * @returns {boolean}
 */
export function isDraining() {
	return counters.draining;
}

/**
 * Flip readiness to NOT-ready at the very start of shutdown so the readiness
 * route reports 503 and a fronting load balancer drains this instance before
 * the listen socket closes. Idempotent. Liveness stays 200 - the process is
 * still up.
 */
export function markDraining() {
	counters.draining = true;
}
