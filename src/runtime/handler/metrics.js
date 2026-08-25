/**
 * The adapter's metrics, projected onto its registry at read time.
 *
 * NOTHING IS EMITTED FROM A HOT PATH. The runtime already counts what matters -
 * refusals by reason, publishes, closed-socket aborts, the admission gate's
 * levels, the pressure sampler's last reading - and every one of those is the
 * authoritative number. The sibling increments a parallel set of instruments at
 * around twenty call sites; doing that here would put a metrics write on the
 * publish and upgrade paths and create a second number that can disagree with
 * the first. Reading the authoritative one when something scrapes costs nothing
 * until then, and cannot drift.
 *
 * The consequence worth stating: a scrape reflects the moment it was taken, and
 * the pressure-derived gauges reflect the last sampler tick rather than the
 * scrape. `pressure_sample_timestamp_seconds` is what makes that visible - alert
 * on its age, not on the freshness of the gauges beside it.
 *
 * This is also why `wsCounters.metricsSampleHook` stays null: it exists so a
 * metrics feature could sample gauges on the sampler's tick, and a projection
 * does not need to. Left in place because the posture export beside it will.
 */

import { createMetricRegistry, retractFamily } from '../utils/metrics.js';
import { PRESSURE_REASON_CODES } from '../observability-manifest.js';
import { pressureSnapshot, wsConnections, wsCounters } from './ws-state.js';
import { upgradeAdmission } from './admission.js';
import { authRateLimiter, rateMapEvictions, upgradeRateLimiter } from './rate-limit.js';
import { ws_options } from './config.js';

/**
 * The one registry. Created eagerly rather than on first use: an app registers
 * its own instruments on it from `init`, which runs before anything scrapes, and
 * a lazily created registry would hand that app a different object than the one
 * the projection later writes into.
 */
export const metricsRegistry = createMetricRegistry({
	// The projection runs on ANY serialize, not only through metricsSnapshot().
	// `platform.metrics` is a documented member and the registry it hands back is
	// this one, so an app that renders it directly - `platform.metrics.serialize()`
	// in a route, or a library given the registry - would otherwise get a
	// document whose adapter families are whatever the last scrape left, or
	// missing entirely on a server nothing has scraped. The hook is what makes
	// there be one way for the document to be built.
	beforeSerialize: () => projectMetrics()
});

/**
 * Every gauge, registered on FIRST VALUE rather than at module load.
 *
 * NONE of them are registered eagerly, and that is the rule rather than a
 * property of which ones happened to need it: a registered family renders a
 * series whether anything set it or not, so eager registration publishes a
 * zero for every configuration that cannot produce a reading - a psi gauge on
 * Windows, an admission gauge with no ceiling, a connection count on a build
 * with no WebSocket tier. The instrument is held here after the first set, so
 * the cost is one map lookup per scrape rather than a re-registration.
 *
 * @type {Map<string, { set: (value: number) => void }>}
 */
const optionalGauges = new Map();

/**
 * @param {string} name
 * @param {number} value
 */
function setOptional(name, value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return;
	let gauge = optionalGauges.get(name);
	if (gauge === undefined) optionalGauges.set(name, (gauge = metricsRegistry.gauge(name)));
	gauge.set(value);
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
	retractFamily(metricsRegistry, name);
}

/**
 * Bring the registry up to date with what the runtime currently knows.
 *
 * Called once per scrape, immediately before rendering. Everything here is a
 * read of state the runtime maintains anyway; the whole pass is a few dozen
 * property reads plus one walk of the refusal bag and the transition map, both
 * bounded by their own vocabularies.
 */
export function projectMetrics() {
	// - The process ------------------------------------------------------------
	//
	// True of any instance, WebSocket tier or not, and read HERE rather than
	// taken from the pressure sampler's cache: that sampler only runs where a
	// realtime tier exists, and a build with none can still answer these - it is
	// the same process. A scrape is not a hot path, so this costs one call when
	// something asks and nothing until then.
	const mem = process.memoryUsage();
	setOptional('resident_memory_bytes', mem.rss);
	setOptional('heap_used_ratio', mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0);

	// EVERYTHING BELOW BELONGS TO THE REALTIME TIER, and a build with no
	// WebSocket handler has none. Published anyway, those families told a server
	// with no upgrade path at all that it had admitted no upgrades, refused none
	// under each of eleven reasons, and was holding no subscriptions - seventeen
	// zero series describing a tier that does not exist, on the exact build whose
	// only use for this document is a scrape route. The rule the manifest states
	// has no exception for "the number happens to be zero".
	if (ws_options === null) return;

	// - The upgrade door ------------------------------------------------------
	metricsRegistry.projectCounter('upgrade_admitted_total', undefined, wsCounters.upgradeAdmittedTotal);
	for (const [reason, count] of Object.entries(wsCounters.upgradeRejectedByReason)) {
		// EVERY reason, including the zeroes. The bag is seeded with the whole
		// vocabulary at boot, so this publishes a zero series per reason from the
		// first scrape - which is what lets a dashboard show "no origin refusals"
		// as a flat line rather than as a gap that reads like a missing exporter.
		metricsRegistry.projectCounter('upgrade_rejected_total', { reason }, count);
	}
	// The same number the reason bag already carries, published under the name
	// the sibling gives it so an alert written there evaluates here.
	metricsRegistry.projectCounter(
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
		metricsRegistry.projectCounter('upgrade_rate_map_evicted_total', { door: 'upgrade' }, rateMapEvictions.upgrade);
	}
	if (authRateLimiter !== null) {
		metricsRegistry.projectCounter('upgrade_rate_map_evicted_total', { door: 'auth' }, rateMapEvictions.auth);
	}

	// Only where a ceiling exists. Without one there is no in-flight ledger to
	// read, and a zero here would say "no upgrades in flight" on a server that
	// simply does not count them.
	if (upgradeAdmission !== null) {
		setOptional('upgrade_inflight', upgradeAdmission.inFlight);
		setOptional('upgrade_deferred_depth', upgradeAdmission.deferredDepth);
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
	metricsRegistry.projectCounter('ws_publishes_total', undefined, wsCounters.publishCount);
	metricsRegistry.projectCounter('ws_closed_socket_aborts_total', undefined, wsCounters.closedWsAborts);
	// Publish-egress enforcement, under the names the sibling gives them so an
	// alert written there evaluates here. Both scopes from the first scrape,
	// zeroes included: a flat line reads as "nothing refused", a gap as a
	// missing exporter.
	for (const [scope, count] of Object.entries(wsCounters.egressRefusedByScope)) {
		metricsRegistry.projectCounter('egress_refused_total', { scope }, count);
	}
	for (const [scope, count] of Object.entries(wsCounters.egressEvictedByScope)) {
		metricsRegistry.projectCounter('egress_window_evicted_total', { scope }, count);
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
		metricsRegistry.projectCounter(
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
		setOptional('psi_cpu_some_avg10', psi.cpuSome10);
		setOptional('psi_memory_full_avg10', psi.memoryFull10);
		setOptional('psi_io_full_avg10', psi.ioFull10);
	} else {
		clearOptional('psi_cpu_some_avg10');
		clearOptional('psi_memory_full_avg10');
		clearOptional('psi_io_full_avg10');
	}
	const cpu = pressureSnapshot.cpuThrottle;
	if (cpu !== null && typeof cpu === 'object') setOptional('cpu_throttled_ratio', cpu.throttledRatio);
	else clearOptional('cpu_throttled_ratio');
}

/**
 * The Prometheus document for this instance.
 *
 * A PROMISE, and never null, where the sibling's is a promise that can be null.
 * Its collection is a round trip to a primary that may not answer; here there is
 * one process and the answer is already in memory. The signature is kept because
 * an app's scrape route written against the sibling awaits it, and a route that
 * awaits a string is correct either way - while a route that checks for null
 * simply never takes that branch.
 *
 * @returns {Promise<string>}
 */
export function metricsSnapshot() {
	// `serialize()` projects through the registry's own hook, so there is no
	// projection here to keep in step with it.
	return Promise.resolve(metricsRegistry.serialize());
}
