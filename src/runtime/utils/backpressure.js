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
 * @returns {{ maxBufferedBytes: number, backpressuredConnections: number, sampled: number }}
 */
export function foldConnectionBackpressure(connections, cap, threshold) {
	let maxBufferedBytes = 0;
	let backpressuredConnections = 0;
	let sampled = 0;
	for (const ws of connections) {
		if (sampled >= cap) break;
		let amt;
		try { amt = ws.getBufferedAmount(); } catch { amt = 0; }
		if (amt > maxBufferedBytes) maxBufferedBytes = amt;
		if (amt > threshold) backpressuredConnections++;
		sampled++;
	}
	return { maxBufferedBytes, backpressuredConnections, sampled };
}
