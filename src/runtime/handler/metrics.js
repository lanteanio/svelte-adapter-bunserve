import { threadId } from 'node:worker_threads';
import { PRESSURE_REASON_CODES, SIGNALS_BY_NAME } from '../observability-manifest.js';
import { externalMetricsRegistry } from '../metrics-bridge.js';
import { mirrorRegistry, containMetricInstrument, readMetricMirror } from '../utils/metrics-mirror.js';
import { pressureSnapshot, wsConnections, wsCounters } from './ws-state.js';
import { upgradeAdmission } from './admission.js';
import { authRateLimiter, rateMapEvictions, upgradeRateLimiter } from './rate-limit.js';
import { ws_options } from './config.js';
import { processMemoryWall } from '../utils/memory-wall.js';
import { readAssertionViolations } from '../utils/assertions.js';
import { monotonicNow } from '../runtime.js';
import { mergeSamples } from '../utils/metrics-merge.js';
import { createWsTransportMetrics } from './ws-transport-metrics.js';
import { runtimeMetricProfile } from './metric-profile.js';

/**
 * How long a build with no WebSocket tier reuses its scrape's memory-wall
 * reading. Every reader read sweeps the cgroup limit files, and every
 * GROUP_LIST_EVERY reads takes the kernel's global cgroup lock to read the
 * group list; with no sampler the scrape is the only reader, and the scrape
 * route is the app's to expose. Reusing a reading for a second holds the
 * reader to the sampler's own 1 Hz whoever drives the route.
 */
const SCRAPE_WALL_REUSE_MS = 1000;

/** @type {{ at: number, value: number | null } | null} */
let scrapeWall = null;

/** @param {{ heapUsed: number, rss: number }} mem */
function scrapeWallReading(mem) {
	const at = monotonicNow();
	if (scrapeWall === null || at - scrapeWall.at >= SCRAPE_WALL_REUSE_MS) {
		scrapeWall = { at, value: processMemoryWall.measure(mem) };
	}
	return scrapeWall.value;
}

// The configured registry retains its identity. No registry means no metrics.
export const metricsRegistry = externalMetricsRegistry;
const instrumentRegistry = externalMetricsRegistry == null ? null : mirrorRegistry(externalMetricsRegistry);
const instruments = new Map();
const projectedCounters = new Map();

/** Register a declared instrument once. Operator emit failures are contained. */
export function metricsInstrument(kind, name) {
 if (instruments.has(name)) return instruments.get(name);
 const signal = SIGNALS_BY_NAME.get(name);
 if (!signal || signal.type !== kind) throw new Error(`Unknown ${kind} metric: ${name}`);
 const options = kind === 'histogram' ? { labelNames: signal.labels, buckets: [...signal.buckets] } : signal.labels;
 const instrument = containMetricInstrument(instrumentRegistry?.[kind]?.(name, signal.help, options));
 instruments.set(name, instrument);
 return instrument;
}

function projectCounter(name, labels, value) {
 const key = name + JSON.stringify(labels ?? {});
 const previous = projectedCounters.get(key) ?? 0;
 projectedCounters.set(key, value);
 metricsInstrument('counter', name)?.inc(labels, value >= previous ? value - previous : value);
}

/** Gauges with a current measurement; instruments remain stable across removal. */
const optionalGauges = new Map();

/**
 * @param {string} name
 * @param {number} value
 */
function setOptional(name, value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return;
	let gauge = optionalGauges.get(name);
	if (gauge === undefined) optionalGauges.set(name, (gauge = metricsInstrument('gauge', name)));
	gauge?.set(value);
}

/**
 * Withdraw an optional gauge whose source has stopped answering.
 *
 * Skipping the `set` is not enough, and that is the whole reason this exists: a
 * gauge registered by an earlier scrape keeps rendering its LAST value, so a
 * kernel file that read fine at boot and fails now publishes the boot reading as
 * current. `/proc/pressure/*` returning null is a transient failure as often as
 * a permanent one - a container losing the mount, a read racing a cgroup move -
 * and a frozen number is worse than a missing one, because a dashboard cannot
 * tell it from a live reading and an alert on it never fires.
 *
 * @param {string} name
 */
function clearOptional(name) {
	// BOTH, UNCONDITIONALLY. Guarding the retract on the map delete looks like an
	// optimisation and is a leak: an app that took its own handle on the same
	// name re-creates the family by writing to it (instruments resolve by name,
	// which is what makes them survive a reset), the map entry is already gone,
	// and the guard then skips the retract forever - so the resurrected family
	// publishes a reading from a source that stopped answering, for the life of
	// the process. Two map operations per scrape per name is not worth a rule
	// that can only be wrong.
	optionalGauges.delete(name);
	instruments.get(name)?.setOptional?.(null, false);
}

/**
 * Bring the registry up to date with what the runtime currently knows.
 *
 * Called once per scrape, immediately before rendering. Everything here is a
 * read of state the runtime maintains anyway; the whole pass is a few dozen
 * property reads plus one walk each of the refusal bag, the transition map and
 * the assertion counts, all bounded by their own vocabularies - and, on a build
 * with no WebSocket tier, at most one memory-wall read of the cgroup limit files
 * a second.
 */
function setTransient(name, value) {
 if (value === null) { clearOptional(name); return; }
 metricsInstrument('gauge', name)?.setOptional?.(value, false);
}

export function projectMetrics() {
	if (metricsRegistry == null) return;
	// - The process ------------------------------------------------------------
	//
	// True of any instance, WebSocket tier or not. Resident memory is read HERE
	// rather than taken from the pressure sampler's cache: that sampler only
	// runs where a realtime tier exists, and a build with none can still answer
	// it - it is the same process. A scrape is not a hot path, so this costs one
	// call when something asks and nothing until then.
	const mem = process.memoryUsage();
	setOptional('resident_memory_bytes', mem.rss);
	// The memory-wall reading, not arena fullness (which JavaScriptCore keeps
	// fitted to usage). The family contract feeds this gauge, the MEMORY
	// reason, the value fold and the send-gate window from ONE reading, so
	// where a sampler runs the gauge is the sampler's - and, like the other
	// sampled gauges, absent until its first tick rather than a value no
	// consumer used. A build with no WebSocket tier has no sampler and nothing
	// to disagree with, so its scrape reads the reader itself, at most once a
	// second. No discoverable wall is an unavailable measurement.
	const measuredHeapUsedRatio = ws_options === null
		? scrapeWallReading(mem)
		: wsCounters.lastSampleWallMs > 0 ? wsCounters.lastMeasuredHeapUsedRatio : null;
	if (measuredHeapUsedRatio === null) clearOptional('heap_used_ratio');
	else metricsInstrument('gauge', 'heap_used_ratio')?.setOptional?.(measuredHeapUsedRatio, processMemoryWall.hasEngineLimit());

	// The framework's own invariants, process-wide like the counts behind them.
	// Only a category that has fired has a series: the family is labelled, and a
	// healthy server has no label values to publish.
	for (const [severity, counts] of Object.entries(readAssertionViolations())) {
		for (const [category, count] of counts) {
			projectCounter('framework_assertion_violations_total', { category, severity }, count);
		}
	}

	// EVERYTHING BELOW BELONGS TO THE REALTIME TIER, and a build with no
	// WebSocket handler has none. Published anyway, those families told a server
	// with no upgrade path at all that it had admitted no upgrades, refused none
	// under each of its reasons, and was holding no subscriptions - a column of
	// zero series describing a tier that does not exist, on the exact build whose
	// only use for this document is a scrape route. The rule the manifest states
	// has no exception for "the number happens to be zero".
	if (ws_options === null) return;

	// - The upgrade door ------------------------------------------------------
	projectCounter('upgrade_admitted_total', undefined, wsCounters.upgradeAdmittedTotal);
	for (const [reason, count] of Object.entries(wsCounters.upgradeRejectedByReason)) {
		// EVERY reason, including the zeroes. The bag is seeded with the whole
		// vocabulary at boot, so this publishes a zero series per reason from the
		// first scrape - which is what lets a dashboard show "no origin refusals"
		// as a flat line rather than as a gap that reads like a missing exporter.
		projectCounter('upgrade_rejected_total', { reason }, count);
	}
	// The same number the reason bag already carries, published under the name
	// the sibling gives it so an alert written there evaluates here.
	projectCounter(
		'upgrade_deferred_rejected_total',
		undefined,
		wsCounters.upgradeRejectedByReason.deferred_overflow ?? 0
	);
	// One series per door that HAS a limiter. A door with none keeps no map to
	// evict from, so its zero is not "nothing was evicted" but "nothing is being
	// counted" - the same distinction the admission gauges below make, and the
	// one that decides whether a flat line on a dashboard means healthy or
	// unconfigured.
	if (upgradeRateLimiter !== null) {
		projectCounter('upgrade_rate_map_evicted_total', { door: 'upgrade' }, rateMapEvictions.upgrade);
	}
	if (authRateLimiter !== null) {
		projectCounter('upgrade_rate_map_evicted_total', { door: 'auth' }, rateMapEvictions.auth);
	}

	// In-flight handshakes are measured with and without admission. With no
	// controller there is no pacing queue, so both queue measurements are zero.
	setOptional('upgrade_inflight', wsCounters.upgradeInFlight);
	setOptional('upgrade_deferred_depth', upgradeAdmission?.deferredDepth ?? 0);
	setOptional('upgrade_deferred_oldest_age_seconds', (upgradeAdmission?.deferredOldestAgeMs ?? 0) / 1000);
	if (upgradeAdmission !== null) {
		if (upgradeAdmission.maxConnections > 0) {
			setOptional(
				'ws_connection_headroom',
				upgradeAdmission.maxConnections - upgradeAdmission.connectionPermits
			);
		}
	}

	// - The connections -------------------------------------------------------
	setOptional('ws_connections', wsConnections.size);
	setOptional('ws_subscriptions', wsCounters.totalSubscriptions);
	projectCounter('ws_publishes_total', undefined, wsCounters.publishCount);
	// Publish-egress enforcement, under the names the sibling gives them so an
	// alert written there evaluates here. Both scopes from the first scrape,
	// zeroes included: a flat line reads as "nothing refused", a gap as a
	// missing exporter.
	for (const [scope, count] of Object.entries(wsCounters.egressRefusedByScope)) {
		projectCounter('egress_refused_total', { scope }, count);
	}
	for (const [scope, count] of Object.entries(wsCounters.egressEvictedByScope)) {
		projectCounter('egress_window_evicted_total', { scope }, count);
	}

	// - Pressure ---------------------------------------------------------------
	//
	// EVERY reading below the guard comes from the pressure sampler, and until
	// its first tick there is no reading - only the zeroed fields it will later
	// fill. Published anyway, a scrape in that window says the process holds no
	// memory, has no saturation, and was last sampled in 1970: three numbers that
	// read as measurements, one of which breaks every freshness alert written
	// against it. Absent until measured, which is the rule the manifest states
	// and the optional gauges beside them already follow. The window is one
	// `sampleIntervalMs` after boot, which is exactly when an orchestrator's
	// first scrape lands.
	if (wsCounters.lastSampleWallMs > 0) {
		setOptional('ws_backpressure_max_bytes', pressureSnapshot.maxBufferedBytes);
		setOptional('ws_backpressure_connections', pressureSnapshot.backpressuredConnections);
		setOptional('pressure_saturation', pressureSnapshot.value);
		setOptional('pressure_reason', PRESSURE_REASON_CODES[pressureSnapshot.reason] ?? 0);
		// Seconds, not milliseconds, because the name says seconds. The sampler
		// records wall-clock ms; a scrape that read them as seconds would date
		// every sample to 1970 and every freshness alert would fire forever.
		setOptional('pressure_sample_timestamp_seconds', wsCounters.lastSampleWallMs / 1000);
	}
	for (const [key, count] of wsCounters.pressureReasonTransitions) {
		const arrow = key.indexOf('>');
		projectCounter(
			'pressure_reason_transitions_total',
			{ from: key.slice(0, arrow), to: key.slice(arrow + 1) },
			count
		);
	}

	// Kernel readings, absent off-Linux and absent until the first sample that
	// could read them - and absent AGAIN the moment one stops reading. A null
	// here is not only "this platform never had them": the sampler returns null
	// for a transient read failure too, and a gauge left registered from an
	// earlier scrape would answer with the reading from before the failure, as
	// though it were current. See clearOptional.
	const psi = pressureSnapshot.psi;
	if (psi !== null && typeof psi === 'object') {
		setTransient('psi_cpu_some_avg10', psi.cpuSome10);
		setTransient('psi_memory_full_avg10', psi.memoryFull10);
		setTransient('psi_io_full_avg10', psi.ioFull10);
	} else {
		clearOptional('psi_cpu_some_avg10');
		clearOptional('psi_memory_full_avg10');
		clearOptional('psi_io_full_avg10');
	}
	const cpu = pressureSnapshot.cpuThrottle;
	if (cpu !== null && typeof cpu === 'object') setTransient('cpu_throttled_ratio', cpu.throttledRatio);
	else clearOptional('cpu_throttled_ratio');
}

/** Render the adapter instruments mirrored from this process. */
export async function metricsSnapshot() {
 if (metricsRegistry == null) return null;
 projectMetrics();
 return mergeSamples([{ worker: threadId, samples: readMetricMirror() }], { expected: 1, reporting: 1, degraded: false, metricSources: runtimeMetricProfile.sources, droppedFrameCoverage: runtimeMetricProfile.droppedFrameCoverage });
}

// Register counters and immediately measurable gauges before serving requests.
// Sampled gauges are created only when their first measurement is available;
// some registries publish a default zero as soon as a gauge is registered.
if (instrumentRegistry != null) {
	for (const signal of runtimeMetricProfile.requiredWorkerSignals) {
		if (signal.type === 'counter') metricsInstrument('counter', signal.name);
	}
	projectMetrics();
}

// External registries may be scraped through an app import. Keep the same
// registry current on the existing sampler without adding another timer.
if (externalMetricsRegistry != null) wsCounters.metricsSampleHook = () => projectMetrics();

if (metricsRegistry != null && ws_options !== null) wsCounters.transportMetricHooks = createWsTransportMetrics(metricsInstrument, monotonicNow, wsCounters);
