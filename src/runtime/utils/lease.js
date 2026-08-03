// Per-connection send-gate: the server grants a WINDOW (a request count
// plus a duration), and it is compared against the wall clock on every check -
// it is never a decremented countdown, so a stalled event loop can never
// silently extend a window. When the window is spent or expired, further
// requests queue up to a bound; past the bound they are refused. A re-grant
// resets the window and drains the queue in FIFO order.
//
// The neutral public method names keep the on-wire / app-facing vocabulary out
// of every call site; only a 0..1 scalar, booleans, and counts leave the
// object. The window's internal accounting never crosses to a hook or frame
// the app can read.
//
// The default clock routes through the runtime seam (wallEpoch is the exact
// wall clock in the default env, exactly the raw read the sibling adapter
// defaults to), so a seeded simulation controls lease deadlines too.

import { wallEpoch } from '../runtime.js';

/**
 * Default zero-config window sizing. Internal tuning knob only; never user
 * exposed. Generous for a healthy single connection; narrowed by the server
 * as its admission posture tightens.
 * @type {{ requestCount: number, ttlMs: number }}
 */
export const DEFAULT_GRANT = { requestCount: 256, ttlMs: 10000 };

/** Hard ceiling on queued-but-not-yet-permitted requests before refusal. */
export const MAX_QUEUED_REQUESTS = 256;

/**
 * Build a per-connection send-gate state machine.
 *
 * @param {{ requestCount: number, ttlMs: number, maxQueue?: number, now?: () => number }} opts
 *   `requestCount` / `ttlMs` size the window applied by `grant()`; `maxQueue`
 *   bounds the queue depth (default {@link MAX_QUEUED_REQUESTS}); `now` is an
 *   injectable clock reader (default: the seam's exact wall clock) so tests
 *   drive time.
 * @returns {{
 *   grant(count?: number, ttlMs?: number): void,
 *   live(): boolean,
 *   expiresAt(): number,
 *   tryAcquire(): boolean,
 *   available(): number,
 *   granted(): number,
 *   queued(): number,
 *   enqueue(item: any): boolean,
 *   requestN(count: number, ttlMs?: number): any[],
 *   pressureValue(): number
 * }}
 */
export function createLeaseState(opts) {
	const now = (opts && opts.now) || wallEpoch;
	const maxQueue = opts && typeof opts.maxQueue === 'number' ? opts.maxQueue : MAX_QUEUED_REQUESTS;
	const defaultCount = opts && typeof opts.requestCount === 'number' ? opts.requestCount : 0;
	const defaultTtl = opts && typeof opts.ttlMs === 'number' ? opts.ttlMs : 0;

	// Absolute deadline: the clock value read at grant time plus the duration.
	// Compared against now() on every check; never decremented.
	let _expiresAt = 0;
	// Remaining permits in the current window.
	let _available = 0;
	// Size of the current window, kept so the saturation scalar has a
	// denominator.
	let _granted = 0;
	/** @type {any[]} */
	const _queue = [];

	function fresh() {
		return _available > 0 && now() < _expiresAt;
	}

	return {
		// Apply a fresh window: fix the absolute deadline and reset the
		// permit counters. Defaults to the configured size when called with
		// no arguments. Does NOT drain the queue - drains happen via
		// requestN, which models the re-grant + drain on the inbound path.
		grant(count, ttlMs) {
			const c = typeof count === 'number' ? count : defaultCount;
			const t = typeof ttlMs === 'number' ? ttlMs : defaultTtl;
			_expiresAt = now() + t;
			_available = c;
			_granted = c;
		},

		// True while the current window is valid: permits remain and the
		// absolute deadline has not been reached.
		live() {
			return fresh();
		},

		// The current window's absolute deadline. 0 before the first grant.
		expiresAt() {
			return _expiresAt;
		},

		// Admission for one flow-controlled request. Consumes a permit and
		// returns true when the window is valid; returns false (without
		// consuming) when spent or expired.
		tryAcquire() {
			if (!fresh()) return false;
			_available--;
			return true;
		},

		// Remaining permits in the current window.
		available() {
			return _available;
		},

		// Size of the current window.
		granted() {
			return _granted;
		},

		// Number of items waiting for a future window.
		queued() {
			return _queue.length;
		},

		// Push one item onto the bounded queue. Returns false (and keeps the
		// queue unchanged) when the bound is reached, so the caller can turn
		// the refusal into a degraded signal rather than an unbounded buffer.
		enqueue(item) {
			if (_queue.length >= maxQueue) return false;
			_queue.push(item);
			return true;
		},

		// Apply a re-grant of `count` permits (and `ttlMs`, defaulting to the
		// configured duration) and drain as many queued items as the window
		// covers, in FIFO order. Returns the drained items so the caller can
		// run them after the window state is settled.
		requestN(count, ttlMs) {
			const t = typeof ttlMs === 'number' ? ttlMs : defaultTtl;
			_expiresAt = now() + t;
			_available = count;
			_granted = count;
			const drained = [];
			while (_available > 0 && _queue.length > 0) {
				drained.push(_queue.shift());
				_available--;
			}
			return drained;
		},

		// Saturation in 0..1. 0 == idle (full window unspent), 1 == exhausted
		// (no permits left or window dead). Higher means more saturated.
		pressureValue() {
			return leasePressureValue({ granted: _granted, available: fresh() ? _available : 0, fallback: 0 });
		}
	};
}

/**
 * Map a window's remaining/total permits to a 0..1 saturation scalar, the
 * same shape the worker pressure snapshot folds in. Direction: idle (full
 * window) reads near 0, exhausted (no permits or dead window) reads near 1, so
 * a higher value always means more saturation.
 *
 * A connection that never opted in has no window (`granted <= 0`); there is no
 * ratio to compute, so the supplied `fallback` (the worker's existing
 * threshold-derived scalar, 0 when healthy) is returned instead of dividing by
 * zero.
 *
 * @param {{ granted: number, available: number, fallback?: number }} w
 * @returns {number}
 */
export function leasePressureValue(w) {
	const granted = w.granted | 0;
	if (granted <= 0) {
		const fb = typeof w.fallback === 'number' ? w.fallback : 0;
		return fb < 0 ? 0 : fb > 1 ? 1 : fb;
	}
	const outstanding = granted - (w.available > 0 ? w.available : 0);
	const r = outstanding / granted;
	return r < 0 ? 0 : r > 1 ? 1 : r;
}

/**
 * Size the next send-gate window from the worker's current posture. Heap
 * headroom and subscriber load narrow the window so a tightening worker hands
 * out smaller windows; an idle worker hands out the full base size. Always
 * floors so a connection makes forward progress.
 *
 * Pure so the sizing direction (shrinks under load, floors) is testable without
 * reaching into process state. The caller supplies the live readings.
 *
 * @param {{ heapRatio: number, subscriberRatio: number, base?: number, floor?: number }} w
 *   `heapRatio` is heapUsed/heapTotal (0..1); `subscriberRatio` is total
 *   subscriptions per connection; `base` is the full window (default
 *   {@link DEFAULT_GRANT}.requestCount); `floor` is the smallest window handed
 *   out (default 8).
 * @returns {number}
 */
export function leaseGrantSize(w) {
	const base = typeof w.base === 'number' ? w.base : DEFAULT_GRANT.requestCount;
	const floor = typeof w.floor === 'number' ? w.floor : 8;
	const heapRatio = typeof w.heapRatio === 'number' && w.heapRatio > 0 ? w.heapRatio : 0;
	const subRatio = typeof w.subscriberRatio === 'number' && w.subscriberRatio > 0 ? w.subscriberRatio : 0;
	let scale = 1;
	if (heapRatio > 0.7) scale *= (1 - heapRatio);
	if (subRatio > 25) scale *= 25 / subRatio;
	if (scale < 0.05) scale = 0.05;
	else if (scale > 1) scale = 1;
	return Math.max(floor, Math.round(base * scale));
}

/**
 * Fold the worker's 0..1 saturation scalar from its raw readings. Each active
 * threshold contributes its sample's distance toward the threshold (worst-of),
 * clamped to 0..1; a fully healthy worker reads 0. The worst per-connection
 * send-gate reading observed since the last sample is folded in worst-of too,
 * so a saturated opted-in connection lifts the worker value even while the
 * global counters look calm.
 *
 * Pure so the value direction (rises under any breach, the gate peak lifts it,
 * idle reads 0) is testable without a live worker. The caller supplies the
 * readings, the configured thresholds, and the current gate peak.
 *
 * @param {{ heapUsedRatio: number, publishRate: number, subscriberRatio: number, psiCpuSome10?: number, psiMemoryFull10?: number, psiIoFull10?: number, cpuThrottledRatio?: number }} sample
 * @param {{ memoryHeapUsedRatio: number | false, publishRatePerSec: number | false, subscriberRatio: number | false, psiCpuSome?: number | false, psiMemoryFull?: number | false, psiIoFull?: number | false, cpuThrottledRatio?: number | false }} thresholds
 * @param {number} leaseSaturationPeak - worst gate reading since the last sample
 * @returns {number}
 */
export function samplePressureValue(sample, thresholds, leaseSaturationPeak) {
	let value = leaseSaturationPeak > 0 ? leaseSaturationPeak : 0;
	if (thresholds.memoryHeapUsedRatio !== false && thresholds.memoryHeapUsedRatio > 0) {
		const r = sample.heapUsedRatio / thresholds.memoryHeapUsedRatio;
		if (r > value) value = r;
	}
	if (thresholds.publishRatePerSec !== false && thresholds.publishRatePerSec > 0) {
		const r = sample.publishRate / thresholds.publishRatePerSec;
		if (r > value) value = r;
	}
	if (thresholds.subscriberRatio !== false && thresholds.subscriberRatio > 0) {
		const r = sample.subscriberRatio / thresholds.subscriberRatio;
		if (r > value) value = r;
	}
	// Kernel-sourced signals fold in worst-of like the process-local ones.
	// Their sample fields are simply absent on hosts without the source, so
	// the non-Linux path is byte-identical.
	if (thresholds.psiCpuSome !== undefined && thresholds.psiCpuSome !== false && thresholds.psiCpuSome > 0 && sample.psiCpuSome10 !== undefined) {
		const r = sample.psiCpuSome10 / thresholds.psiCpuSome;
		if (r > value) value = r;
	}
	if (thresholds.psiMemoryFull !== undefined && thresholds.psiMemoryFull !== false && thresholds.psiMemoryFull > 0 && sample.psiMemoryFull10 !== undefined) {
		const r = sample.psiMemoryFull10 / thresholds.psiMemoryFull;
		if (r > value) value = r;
	}
	if (thresholds.psiIoFull !== undefined && thresholds.psiIoFull !== false && thresholds.psiIoFull > 0 && sample.psiIoFull10 !== undefined) {
		const r = sample.psiIoFull10 / thresholds.psiIoFull;
		if (r > value) value = r;
	}
	if (thresholds.cpuThrottledRatio !== undefined && thresholds.cpuThrottledRatio !== false && thresholds.cpuThrottledRatio > 0 && sample.cpuThrottledRatio !== undefined) {
		const r = sample.cpuThrottledRatio / thresholds.cpuThrottledRatio;
		if (r > value) value = r;
	}
	if (value < 0) value = 0; else if (value > 1) value = 1;
	return value;
}
