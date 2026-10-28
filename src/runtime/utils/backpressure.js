/**
 * Bounded backpressure sampling over the live connection set, for the 1 Hz
 * pressure sampler. The sibling adapter's module of the same name also
 * carries its transport's HTTP drain helper; this adapter's HTTP lane is
 * Bun.serve's own, so only the transport-agnostic fold lives here.
 */

/**
 * Cap on the number of connections the 1 Hz pressure sampler reads
 * `getBufferedAmount()` for in a single tick. Each read is one native call,
 * but a worker holding tens of thousands of sockets would still pay a
 * measurable per-tick cost if it walked every one, so the walk is bounded: at
 * or below the cap the aggregate is exact; above it the reported figures are
 * a bounded sample of the connection set (documented on `PressureSnapshot`).
 * This walk is off the publish fast path entirely - it runs only on the
 * sampler tick.
 */
export const BACKPRESSURE_SAMPLE_CAP = 1024;

/**
 * A sampled connection counts toward `backpressuredConnections` when it holds
 * more than this many bytes of un-flushed outbound at sample time. Set above
 * the transient in-flight bytes of a healthy flush so a normal high-throughput
 * consumer does not register, while a wedged slow consumer - whose queue climbs
 * toward `maxBackpressure` (1 MB default), where the backend begins refusing
 * frames - does.
 */
export const BACKPRESSURE_SAMPLE_THRESHOLD_BYTES = 64 * 1024;

/**
 * Walk up to `cap` connections, reading each one's outbound queue depth via
 * `getBufferedAmount()`, and fold the readings into two aggregate telemetry
 * figures: the worst queue depth seen, and the count of connections holding
 * more than `threshold` bytes at sample time. Zero-allocation apart from the
 * single result object - it folds inline over the connection iterable rather
 * than building an intermediate array, so the 1 Hz sampler pays a fixed,
 * bounded per-tick cost even on a worker holding tens of thousands of sockets.
 * A connection closing mid-walk throws from `getBufferedAmount()`; count it as
 * 0 (already gone). At or below the cap the figures are exact; above it they
 * are a bounded sample of the connection set.
 *
 * Pure with respect to everything but the supplied connections: the only
 * side-effecting boundary is `getBufferedAmount()`, so a unit test drives it
 * with mock connections and no real socket. Kept in this module (not inline in
 * the sampler) so the hot-path-sensitive bounded walk is unit-testable without
 * pulling the sampler's build-time-configured module graph.
 *
 * @param {Iterable<{ getBufferedAmount: () => number }>} connections
 * @param {number} cap  max connections to read this tick (bounds the cost)
 * @param {number} threshold  a reading strictly above this counts as backpressured
 * @param {((ws: any) => number) | null} [heldBytes] payload bytes waiting at the delivery boundary
 * @returns {{ maxBufferedBytes: number, backpressuredConnections: number, sampled: number }}
 */
export function foldConnectionBackpressure(connections, cap, threshold, heldBytes = null) {
	let maxBufferedBytes = 0;
	let backpressuredConnections = 0;
	let sampled = 0;
	for (const ws of connections) {
		if (sampled >= cap) break;
		let amt;
		try { amt = ws.getBufferedAmount() + (heldBytes === null ? 0 : heldBytes(ws)); } catch { amt = 0; }
		if (amt > maxBufferedBytes) maxBufferedBytes = amt;
		if (amt > threshold) backpressuredConnections++;
		sampled++;
	}
	return { maxBufferedBytes, backpressuredConnections, sampled };
}

/**
 * Record a refused direct delivery in the current pressure window.
 * Retain only its encoded byte length, never the payload.
 *
 * @param {{ droppedFramesWindow: number, droppedBytesWindow: number }} target
 * @param {{ byteLength: number }} message
 */
export function recordBackpressureDrop(target, message) {
	target.droppedFramesWindow++;
	target.droppedBytesWindow += message.byteLength;
}

/**
 * Close and reset the exact drop window. Kept separate from the bounded queue
 * sampler: a drop that drains before the next tick, or occurs beyond the
 * sampler's 1,024-connection cap, must still be counted.
 *
 * @param {{ droppedFramesWindow: number, droppedBytesWindow: number }} target
 * @returns {{ droppedFrames: number, droppedBytes: number }}
 */
export function takeBackpressureDropWindow(target) {
	const droppedFrames = target.droppedFramesWindow;
	const droppedBytes = target.droppedBytesWindow;
	target.droppedFramesWindow = 0;
	target.droppedBytesWindow = 0;
	return { droppedFrames, droppedBytes };
}

// Only nested drains need a set; the ordinary synchronous call owns one slot.
let drainingCoalesced = null;
const parentDrains = new Set();

/**
 * Drain a coalesce-by-key buffer.
 *
 * Iterates entries in insertion order and calls `send` for each, using the
 * uWS send-status contract (see platform.js): 1 = sent clean, 0 = enqueued
 * behind backpressure (accepted and delivered in order, but the socket is
 * now under pressure), 2 = dropped past maxBackpressure. A sent (1) or
 * enqueued (0) entry is removed from the map; a dropped (2) entry is retained
 * for a later flush. The drain continues while sends land clean and STOPS the
 * moment the socket signals pressure - the first enqueued-behind-backpressure
 * (0) or dropped (2) result - so a backpressured socket is never pushed
 * harder and a healthy one drains all of its pending keys in one pass.
 *
 * Reentrant calls for the same map only enqueue. The active drain retains
 * replacements made by `send` and retries a new value once before later keys.
 * Repeated replacement or growth yields after bounded work. A true return
 * asks the caller to schedule a continuation.
 *
 * Map insertion order is preserved across overwrites: setting an existing
 * key replaces the value but keeps the original slot. Latest value wins,
 * order is stable.
 *
 * @template T
 * @param {Map<unknown, T>} pending
 * @param {(value: T, key: unknown) => number} send  uWS send status: 1 sent clean, 0 enqueued-under-backpressure, 2 dropped
 * @returns {boolean | undefined} true when reentrant work needs a continuation
 */
export function drainCoalesced(pending, send) {
	const previous = drainingCoalesced;
	if (previous !== null) {
		if (previous === pending || parentDrains.has(pending)) return;
		parentDrains.add(previous);
	}
	drainingCoalesced = pending;
	let remaining = pending.size * 2;
	let yielded = false;
	try {
		for (const [key, first] of pending) {
			let value = first;
			let retried = false;
			for (;;) {
				if (remaining-- === 0) return true;
				const result = send(value, key);
				if (result === 2) return;
				if (Object.is(pending.get(key), value)) {
					pending.delete(key);
					if (result === 0) return;
					break;
				}
				if (result === 0) return;
				if (!pending.has(key)) break;
				if (retried) { yielded = true; break; }
				retried = true;
				value = pending.get(key);
			}
		}
		return yielded;
	} finally {
		drainingCoalesced = previous;
		if (previous !== null) parentDrains.delete(previous);
	}
}
