import { counters, requestSignals } from './state.js';

/** @type {Array<() => void>} */
let drainResolvers = [];

/** Called when an SSR render or streaming response settles (see counters.inFlightCount). */
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
 * The boot window between the listener coming up and the instance being fit to
 * receive traffic: the app's init hook, then the SSR warmup.
 *
 * Readiness reports 503 throughout, which is what makes the warmup a GATE
 * rather than a race. The listener is already accepting - it has to be, because
 * the init hook is documented to run with the platform live and able to publish
 * - so without this the readiness probe would answer 200 the instant the socket
 * bound, a load balancer would route immediately, and the first real client
 * would land on the cold render the warmup exists to absorb. Liveness stays 200
 * the whole time: the process is up, it is simply not ready.
 */
let starting = true;

/** @returns {boolean} */
export function isStarting() {
	return starting;
}

/**
 * Commit readiness. Called once, after the init hook and the warmup pass have
 * both settled - including when either failed, because neither is a
 * correctness gate and an instance that never reports ready is worse than one
 * whose first render is cold.
 */
export function markReady() {
	starting = false;
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

/** Abort requests still active when shutdown stops waiting. */
export function abortInFlightRequests() {
	const reason = new DOMException('The server shut down before the request finished', 'AbortError');
	for (const controller of requestSignals) controller.abort(reason);
	requestSignals.clear();
}
