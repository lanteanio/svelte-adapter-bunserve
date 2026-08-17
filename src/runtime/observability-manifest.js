/**
 * What this adapter publishes about itself, declared once.
 *
 * A metric's NAME, TYPE, LABEL VOCABULARY and HELP are a contract with whatever
 * scrapes it: a dashboard, an alert rule, a recording rule. Declaring them in
 * one list rather than at each emit site is what makes that contract reviewable
 * - and what lets the renderer emit a stable, diffable document in a fixed
 * order instead of in whatever order the first sample happened to arrive.
 *
 * THE NAMES ARE svelte-adapter-uws's, exactly. A deployment that moves between
 * the two adapters keeps its dashboards, and a series that means one thing there
 * cannot mean another here. Where this adapter cannot produce a signal at all,
 * the entry is ABSENT rather than present and zero: a zero published for
 * something never measured is the worst of both worlds, since it reads as
 * healthy and alerts never fire.
 *
 * What is deliberately not here yet, and why:
 *
 * - `http_requests_total` and the duration histograms need instrumentation on
 *   the request path itself. That is a hot path with a benchmark gate over it,
 *   so it is its own slice rather than a line in this one.
 * - `relay_*`, `state_divergence_total` and the waiting-room gauge belong to
 *   multi-worker clustering and the holding page, both recorded parity gaps.
 * - `protection_posture_*` arrives with `websocket.protection`, and the egress
 *   ceilings with theirs. Each label arrives with its feature, which is how the
 *   refusal reasons have been handled.
 *
 * Pure data. No imports, no state.
 */

/**
 * @typedef {Object} Signal
 * @property {string} name
 * @property {'counter' | 'gauge' | 'histogram'} type
 * @property {string[]} labels label names this family may carry
 * @property {string | null} unit for documentation; the name already carries it
 * @property {string} help one line, rendered into the document
 * @property {boolean} [optional] true when the signal is absent on some
 *   platforms or configurations, so a missing family is not a defect
 * @property {number[]} [buckets] histogram bounds, in the metric's own unit
 */

/**
 * Duration histograms are declared in SECONDS with fractional bounds, never in
 * milliseconds, so a bucket bound always reads in the same unit as the sample.
 * Unused by the adapter's own signals today; kept because an app registering a
 * histogram on this registry needs the convention stated somewhere.
 */
export const SECONDS = 'seconds';

/** @type {readonly Signal[]} */
export const SIGNALS = Object.freeze([
	// - The upgrade door ------------------------------------------------------
	{
		name: 'upgrade_admitted_total',
		type: 'counter',
		labels: [],
		unit: null,
		help: 'WebSocket upgrades accepted'
	},
	{
		name: 'upgrade_rejected_total',
		type: 'counter',
		labels: ['reason'],
		unit: null,
		help: 'WebSocket upgrades rejected before open'
	},
	{
		name: 'upgrade_deferred_rejected_total',
		type: 'counter',
		labels: [],
		unit: null,
		help: 'Upgrade callbacks shed because the bounded deferral queue was full'
	},
	{
		name: 'upgrade_rate_map_evicted_total',
		type: 'counter',
		labels: ['door'],
		unit: null,
		help: 'Rate-limit entries evicted at the map cap'
	},
	{
		name: 'upgrade_inflight',
		type: 'gauge',
		labels: [],
		unit: null,
		optional: true,
		help: 'Upgrades currently between admission and open'
	},
	{
		name: 'upgrade_deferred_depth',
		type: 'gauge',
		labels: [],
		unit: null,
		optional: true,
		help: 'Upgrade callbacks waiting in the bounded pacing queue'
	},
	{
		name: 'ws_connection_headroom',
		type: 'gauge',
		labels: [],
		unit: null,
		optional: true,
		help: 'Remaining reserved-or-live WebSocket connection permits'
	},

	// - The connections themselves --------------------------------------------
	{
		name: 'ws_connections',
		type: 'gauge',
		labels: [],
		unit: null,
		help: 'Live WebSocket connections'
	},
	{
		name: 'ws_subscriptions',
		type: 'gauge',
		labels: [],
		unit: null,
		help: 'Live topic subscriptions; divide by ws_connections for the subscriber ratio'
	},
	{
		name: 'ws_publishes_total',
		type: 'counter',
		labels: [],
		unit: null,
		help: 'Publish calls made (fan-out is one call; not per-recipient deliveries)'
	},
	{
		name: 'ws_backpressure_max_bytes',
		type: 'gauge',
		labels: [],
		unit: 'bytes',
		help: 'Worst per-connection outbound buffered bytes over the sampled set'
	},
	{
		name: 'ws_backpressure_connections',
		type: 'gauge',
		labels: [],
		unit: null,
		help: 'Sampled connections holding a backpressured outbound queue'
	},
	{
		name: 'ws_closed_socket_aborts_total',
		type: 'counter',
		labels: [],
		unit: null,
		help: 'Sends and subscribes refused because the socket had already closed'
	},

	// - Pressure ---------------------------------------------------------------
	{
		name: 'pressure_saturation',
		type: 'gauge',
		labels: [],
		unit: 'ratio',
		help: 'Instance saturation, 0 healthy to 1 at the configured thresholds'
	},
	{
		name: 'pressure_reason',
		type: 'gauge',
		labels: [],
		unit: 'enum',
		help: 'Pressure reason as a severity-ordered code (0 none to 6 memory)'
	},
	{
		name: 'pressure_reason_transitions_total',
		type: 'counter',
		labels: ['from', 'to'],
		unit: null,
		help: 'Pressure reason changes, including incidents and recoveries'
	},
	{
		name: 'pressure_sample_timestamp_seconds',
		type: 'gauge',
		labels: [],
		unit: SECONDS,
		help: 'Unix time of the most recent pressure sample; alert on its age'
	},
	{
		name: 'resident_memory_bytes',
		type: 'gauge',
		labels: [],
		unit: 'bytes',
		help: 'Resident set size of the process'
	},
	{
		name: 'heap_used_ratio',
		type: 'gauge',
		labels: [],
		unit: 'ratio',
		help: 'Used fraction of the V8 heap'
	},
	{
		name: 'psi_cpu_some_avg10',
		type: 'gauge',
		labels: [],
		unit: 'percent',
		optional: true,
		help: 'Kernel pressure-stall CPU some avg10'
	},
	{
		name: 'psi_memory_full_avg10',
		type: 'gauge',
		labels: [],
		unit: 'percent',
		optional: true,
		help: 'Kernel pressure-stall memory full avg10'
	},
	{
		name: 'psi_io_full_avg10',
		type: 'gauge',
		labels: [],
		unit: 'percent',
		optional: true,
		help: 'Kernel pressure-stall IO full avg10'
	},
	{
		name: 'cpu_throttled_ratio',
		type: 'gauge',
		labels: [],
		unit: 'ratio',
		optional: true,
		help: 'Fraction of the window the cgroup CPU quota held the process suspended'
	},

	// - The document's own completeness ---------------------------------------
	//
	// Carried even though this adapter is single-process and the answers are
	// therefore constant. svelte-adapter-uws emits them from a cluster merge, and
	// an alert written against `metrics_snapshot_degraded` there must not silently
	// evaluate over a missing series here - a rule that never fires reads exactly
	// like a system that is never degraded.
	{
		name: 'metrics_snapshot_workers_expected',
		type: 'gauge',
		labels: [],
		unit: null,
		help: 'Workers the metrics snapshot asked for a report (always 1: this adapter is single-process)'
	},
	{
		name: 'metrics_snapshot_workers_reporting',
		type: 'gauge',
		labels: [],
		unit: null,
		help: 'Workers with complete metric reports (always 1: this adapter is single-process)'
	},
	{
		name: 'metrics_snapshot_degraded',
		type: 'gauge',
		labels: [],
		unit: null,
		help: '1 when the collection did not complete and this document is partial (always 0 here)'
	}
]);

/**
 * The signals the renderer fills in itself, rather than reading from a sample.
 * Held here so the renderer and the manifest cannot drift about which those are.
 */
export const SNAPSHOT_SIGNALS = Object.freeze({
	metrics_snapshot_workers_expected: 1,
	metrics_snapshot_workers_reporting: 1,
	metrics_snapshot_degraded: 0
});

/** @type {Map<string, Signal>} */
export const SIGNALS_BY_NAME = new Map(SIGNALS.map((signal) => [signal.name, signal]));
