// Admission control for WebSocket upgrades.
//
// This mirrors svelte-adapter-uws's module of the same name, deliberately and
// closely: the two adapters are drop-in replacements for each other, so an
// `upgradeAdmission` block carried from one to the other has to mean the same
// thing in both - the same option names, the same defaults, the same refusal
// points. Where this file differs from the uws original it is because the
// TRANSPORT differs, never because the contract does, and each such place says
// so.
//
// The counters themselves are transport-agnostic; only the code that calls
// them knows what a socket is.

import { monotonicNow, setImmediateTimer } from '../runtime.js';

const DEFAULT_MAX_DEFERRED = 1024;

/**
 * The Sec-WebSocket-Protocol token the cursor-only upgrade lane is keyed on.
 * The worker's second (cursor) WebSocket sets this subprotocol; the upgrade
 * handler reads it to route the upgrade through the deprioritised cursor lane.
 * The token is read only; the server still echoes the negotiated subprotocol
 * back to the client unchanged.
 */
export const CURSOR_LANE_SUBPROTOCOL = 'svelte-realtime-cursor';

/**
 * `true` when the comma-separated `Sec-WebSocket-Protocol` request header lists
 * the cursor-lane token. Pure so the token parsing is unit-testable and
 * isolated from the upgrade hot path. Trims each offered token so the common
 * `"a, b"` spacing matches.
 *
 * @param {string | undefined | null} secProtocol the raw request header value
 * @returns {boolean}
 */
export function isCursorLaneUpgrade(secProtocol) {
	if (typeof secProtocol !== 'string' || secProtocol.length === 0) return false;
	const offered = secProtocol.split(',');
	for (let i = 0; i < offered.length; i++) {
		if (offered[i].trim() === CURSOR_LANE_SUBPROTOCOL) return true;
	}
	return false;
}

/**
 * Build a self-contained admission controller for WebSocket upgrades.
 *
 * Four independent layers, all opt-in (zero or unset = disabled):
 *
 * - `maxConcurrent` caps how many upgrades may be in flight at once.
 *   Crossed requests get rejected before any per-request work, so a
 *   connection storm can be shed without spending CPU on TLS / header
 *   parsing.
 * - `maxConnections` caps reserved upgrades plus live WebSocket connections.
 *   A permit is acquired before per-request work and held until the socket's
 *   close callback, so sequential handshakes cannot bypass the live-connection
 *   ceiling.
 * - `perTickBudget` caps how many upgrade calls run per event-loop tick. Once
 *   the budget is spent, subsequent calls are deferred via setImmediate so the
 *   loop is not starved by 10K synchronous handshakes from one I/O batch. Its
 *   queue is always finite: `maxDeferred` defaults to 1024 while pacing is
 *   enabled, and overflow is refused instead of retaining another closure.
 * - `cursorLane.fraction` reserves a fraction of `maxConcurrent` for a
 *   deprioritised cursor-only upgrade lane (the worker's second WebSocket). A
 *   cursor upgrade is admitted only while both the main ceiling has room and
 *   the cursor sub-budget has room, so a flood of cursor reconnects can never
 *   starve main-WS admission. Unset (or `maxConcurrent` unset) keeps the second
 *   counter at zero and the main lane byte-identical.
 *
 * The returned object owns the counters and queue; one instance per server.
 * Pure factory: no module state, no globals - all state lives in the closure so
 * multiple instances do not interfere.
 *
 * @param {{ maxConcurrent?: number, maxConnections?: number, perTickBudget?: number, maxDeferred?: number, cursorLane?: { fraction?: number } }} [opts]
 */
export function createUpgradeAdmission(opts) {
	const maxConcurrent = (opts && opts.maxConcurrent) || 0;
	const configuredMaxConnections = opts && opts.maxConnections;
	if (
		configuredMaxConnections !== undefined &&
		(!Number.isSafeInteger(configuredMaxConnections) || configuredMaxConnections < 0)
	) {
		throw new TypeError('upgradeAdmission.maxConnections must be a non-negative safe integer.');
	}
	const maxConnections = configuredMaxConnections || 0;
	const perTickBudget = (opts && opts.perTickBudget) || 0;
	const configuredMaxDeferred = opts && opts.maxDeferred;
	if (
		configuredMaxDeferred !== undefined &&
		(!Number.isSafeInteger(configuredMaxDeferred) || configuredMaxDeferred < 0)
	) {
		throw new TypeError('upgradeAdmission.maxDeferred must be a non-negative safe integer.');
	}
	const maxDeferred = perTickBudget > 0
		? (configuredMaxDeferred === undefined ? DEFAULT_MAX_DEFERRED : configuredMaxDeferred)
		: 0;
	// Cursor-lane sub-budget: a fraction of the main ceiling reserved for the
	// deprioritised cursor-only upgrade lane. Only meaningful when the gate has
	// a ceiling to carve from; with no ceiling the lane stays at zero and the
	// main lane is untouched. The floor of 1 keeps a configured lane usable even
	// for a small ceiling.
	const cursorFraction = (opts && opts.cursorLane && typeof opts.cursorLane.fraction === 'number' && opts.cursorLane.fraction > 0)
		? Math.min(1, opts.cursorLane.fraction)
		: 0.25;
	const cursorMaxConcurrent = (maxConcurrent > 0 && opts && opts.cursorLane)
		? Math.max(1, Math.floor(maxConcurrent * cursorFraction))
		: 0;
	let inFlight = 0;
	let cursorInFlight = 0;
	let connectionPermits = 0;
	let perTickCount = 0;
	/** @type {Array<{ fn: () => void, enqueuedAt: number } | undefined>} */
	const deferred = [];
	let deferredHead = 0;
	let deferredTail = 0;
	let deferredDepth = 0;
	let deferredRejectedTotal = 0;
	/** @type {null | ((depth: number, oldestAgeMs: number, rejectedTotal: number) => void)} */
	let deferredObserver = null;
	let drainScheduled = false;

	function oldestDeferredAgeMs() {
		if (deferredDepth === 0) return 0;
		const oldest = deferred[deferredHead];
		return oldest === undefined ? 0 : Math.max(0, monotonicNow() - oldest.enqueuedAt);
	}

	function notifyDeferredObserver() {
		if (deferredObserver === null) return;
		try {
			deferredObserver(deferredDepth, oldestDeferredAgeMs(), deferredRejectedTotal);
		} catch {
			// Metrics are observe-only: an exporter must never break admission.
		}
	}

	function scheduleDrain() {
		if (drainScheduled) return;
		drainScheduled = true;
		setImmediateTimer(drain);
	}

	function dequeue() {
		const entry = /** @type {{ fn: () => void, enqueuedAt: number }} */ (deferred[deferredHead]);
		deferred[deferredHead] = undefined;
		deferredHead = deferredHead + 1 === maxDeferred ? 0 : deferredHead + 1;
		deferredDepth--;
		if (deferredDepth === 0) {
			deferredHead = 0;
			deferredTail = 0;
		}
		return entry;
	}

	function drain() {
		drainScheduled = false;
		perTickCount = 0;
		while (perTickCount < perTickBudget && deferredDepth > 0) {
			const entry = dequeue();
			perTickCount++;
			// House style here rather than uws's error-registry id: this repo has
			// no registry, and inventing one spelling for a single call site would
			// be a divergence in the opposite direction.
			try { entry.fn(); } catch (err) { console.error('[ws] a deferred upgrade callback threw', err); }
		}
		notifyDeferredObserver();
		// A drain that ran callbacks consumed this tick's budget. Schedule one
		// final empty turn after the queue empties so the counter resets before a
		// later, otherwise-unrelated upgrade arrives.
		if (deferredDepth > 0 || perTickCount > 0) scheduleDrain();
	}

	return {
		/** `true` if there is room; caller is responsible for `release()`. */
		tryAcquire() {
			if (maxConcurrent > 0 && inFlight >= maxConcurrent) return false;
			inFlight++;
			return true;
		},
		release() { inFlight--; },
		/**
		 * Reserve one whole-lifetime connection permit. The reservation includes
		 * the upgrade window, preventing concurrent handshakes from overshooting
		 * the configured live-connection ceiling. Disabled ceilings are a no-op.
		 */
		tryAcquireConnection() {
			if (maxConnections <= 0) return true;
			if (connectionPermits >= maxConnections) return false;
			connectionPermits++;
			return true;
		},
		/** Release a permit acquired by `tryAcquireConnection()`. */
		releaseConnection() {
			if (maxConnections <= 0) return;
			if (connectionPermits <= 0) {
				throw new Error('upgradeAdmission connection permit released without an acquisition.');
			}
			connectionPermits--;
		},
		/**
		 * Acquire a slot for a cursor-only upgrade (the worker's second
		 * WebSocket). All-or-nothing, mirroring `tryAcquire()`: admitted only
		 * when both the main ceiling has room AND the cursor sub-budget has
		 * room. On success it consumes one slot from each counter and the caller
		 * is responsible for `releaseCursorInFlight()`. The main lane's
		 * `tryAcquire()` is never gated by the cursor sub-budget, so the cursor
		 * lane is sheddable without ever starving the main lane.
		 *
		 * @returns {boolean}
		 */
		tryAcquireCursor() {
			if (maxConcurrent > 0 && inFlight >= maxConcurrent) return false;
			if (cursorInFlight >= cursorMaxConcurrent) return false;
			inFlight++;
			cursorInFlight++;
			return true;
		},
		/**
		 * Release a slot taken by `tryAcquireCursor()`: decrements both the main
		 * in-flight counter and the cursor sub-budget counter, keeping the two in
		 * step so the cursor lane cannot leak across an aborted or timed-out
		 * cursor upgrade.
		 */
		releaseCursorInFlight() { inFlight--; cursorInFlight--; },
		/** Live snapshot, primarily for tests / introspection. */
		get inFlight() { return inFlight; },
		/** Configured concurrent-upgrade ceiling (`0` when the gate is open). */
		get maxConcurrent() { return maxConcurrent; },
		/** Configured reserved-or-live connection ceiling (`0` when disabled). */
		get maxConnections() { return maxConnections; },
		/** Effective finite deferred-callback ceiling (`0` when pacing is off). */
		get maxDeferred() { return maxDeferred; },
		/** Upgrade callbacks currently retained by the pacing queue. */
		get deferredDepth() { return deferredDepth; },
		/** Live age in milliseconds of the oldest retained callback, or `0`. */
		get deferredOldestAgeMs() { return oldestDeferredAgeMs(); },
		/** Callbacks refused because the finite pacing queue was full. */
		get deferredRejectedTotal() { return deferredRejectedTotal; },
		/**
		 * Install the internal metrics observer. It receives an initial snapshot
		 * and every later enqueue, overflow, and drain transition.
		 *
		 * @param {null | ((depth: number, oldestAgeMs: number, rejectedTotal: number) => void)} observer
		 */
		setDeferredObserver(observer) {
			deferredObserver = typeof observer === 'function' ? observer : null;
			notifyDeferredObserver();
		},
		/** Reserved upgrades plus live connections currently holding permits. */
		get connectionPermits() { return connectionPermits; },
		/** Remaining permits, or `null` when the live-connection gate is disabled. */
		get connectionHeadroom() {
			return maxConnections > 0 ? maxConnections - connectionPermits : null;
		},
		/** Live count of cursor-lane upgrades in flight. */
		get cursorInFlight() { return cursorInFlight; },
		/**
		 * Reserved cursor-lane ceiling (`0` when the lane is disabled - no
		 * `cursorLane` option or no main ceiling to carve from).
		 */
		get cursorMaxConcurrent() { return cursorMaxConcurrent; },
		/**
		 * Read-only: `true` if a `tryAcquire()` would currently succeed. Acquires
		 * nothing and mutates no counter, so a capacity probe can ask "is there
		 * room?" without ever consuming a slot. Pacing is full only when this
		 * tick's synchronous budget AND the finite deferred queue are both
		 * exhausted; a transient spent tick with queue room remains admissible.
		 *
		 * @returns {boolean}
		 */
		hasCapacity() {
			return !(maxConcurrent > 0 && inFlight >= maxConcurrent) &&
				!(maxConnections > 0 && connectionPermits >= maxConnections) &&
				!(perTickBudget > 0 && perTickCount >= perTickBudget && deferredDepth >= maxDeferred);
		},
		/**
		 * Run `fn` (the actual upgrade call) under the per-tick budget. Returns
		 * `true` if `fn` ran synchronously, `false` if deferred to a later tick,
		 * or `null` when the finite queue is full.
		 *
		 * @param {() => void} fn
		 * @returns {boolean | null}
		 */
		admit(fn) {
			if (perTickBudget <= 0) { fn(); return true; }
			if (perTickCount < perTickBudget) {
				perTickCount++;
				// Reset on the next turn even when no request exceeds the budget;
				// otherwise a quiet request much later is mistaken for this tick.
				scheduleDrain();
				fn();
				return true;
			}
			if (deferredDepth >= maxDeferred) {
				deferredRejectedTotal++;
				notifyDeferredObserver();
				return null;
			}
			deferred[deferredTail] = { fn, enqueuedAt: monotonicNow() };
			deferredTail = deferredTail + 1 === maxDeferred ? 0 : deferredTail + 1;
			deferredDepth++;
			notifyDeferredObserver();
			scheduleDrain();
			return false;
		}
	};
}
