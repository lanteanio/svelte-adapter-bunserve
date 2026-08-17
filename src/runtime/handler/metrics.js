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

import { createMetricRegistry } from '../utils/metrics.js';
import { PRESSURE_REASON_CODES } from '../observability-manifest.js';
import { pressureSnapshot, wsConnections, wsCounters } from './ws-state.js';
import { upgradeAdmission } from './admission.js';
import { rateMapEvictions } from './rate-limit.js';

/**
 * The one registry. Created eagerly rather than on first use: an app registers
 * its own instruments on it from `init`, which runs before anything scrapes, and
 * a lazily created registry would hand that app a different object than the one
 * the projection later writes into.
 */
export const metricsRegistry = createMetricRegistry();

/** Gauges are held once rather than re-registered per scrape. */
const gauges = {
	connections: metricsRegistry.gauge('ws_connections'),
	subscriptions: metricsRegistry.gauge('ws_subscriptions'),
	backpressureMaxBytes: metricsRegistry.gauge('ws_backpressure_max_bytes'),
	backpressureConnections: metricsRegistry.gauge('ws_backpressure_connections'),
	saturation: metricsRegistry.gauge('pressure_saturation'),
	reason: metricsRegistry.gauge('pressure_reason'),
	sampleTimestamp: metricsRegistry.gauge('pressure_sample_timestamp_seconds'),
	residentBytes: metricsRegistry.gauge('resident_memory_bytes'),
	heapUsedRatio: metricsRegistry.gauge('heap_used_ratio')
};

/**
 * Gauges that only exist on some configurations or platforms. Registered on
 * FIRST VALUE rather than at module load, because a registered family renders a
 * series - and a psi gauge reading zero on Windows, or an admission gauge
 * reading zero on a server with no ceiling, is a number that looks like a
 * measurement and is not one.
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
 * Bring the registry up to date with what the runtime currently knows.
 *
 * Called once per scrape, immediately before rendering. Everything here is a
 * read of state the runtime maintains anyway; the whole pass is a few dozen
 * property reads plus one walk of the refusal bag and the transition map, both
 * bounded by their own vocabularies.
 */
export function projectMetrics() {
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
	metricsRegistry.projectCounter('upgrade_rate_map_evicted_total', { door: 'upgrade' }, rateMapEvictions.upgrade);
	metricsRegistry.projectCounter('upgrade_rate_map_evicted_total', { door: 'auth' }, rateMapEvictions.auth);

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
	gauges.connections.set(wsConnections.size);
	gauges.subscriptions.set(wsCounters.totalSubscriptions);
	metricsRegistry.projectCounter('ws_publishes_total', undefined, wsCounters.publishCount);
	metricsRegistry.projectCounter('ws_closed_socket_aborts_total', undefined, wsCounters.closedWsAborts);
	gauges.backpressureMaxBytes.set(pressureSnapshot.maxBufferedBytes);
	gauges.backpressureConnections.set(pressureSnapshot.backpressuredConnections);

	// - Pressure ---------------------------------------------------------------
	gauges.saturation.set(pressureSnapshot.value);
	gauges.reason.set(PRESSURE_REASON_CODES[pressureSnapshot.reason] ?? 0);
	// Seconds, not milliseconds, because the name says seconds. The sampler
	// records wall-clock ms; a scrape that read them as seconds would date every
	// sample to 1970 and every freshness alert would fire forever.
	gauges.sampleTimestamp.set(wsCounters.lastSampleWallMs / 1000);
	gauges.residentBytes.set(wsCounters.lastResidentBytes);
	gauges.heapUsedRatio.set(wsCounters.lastHeapUsedRatio);
	for (const [key, count] of wsCounters.pressureReasonTransitions) {
		const arrow = key.indexOf('>');
		metricsRegistry.projectCounter(
			'pressure_reason_transitions_total',
			{ from: key.slice(0, arrow), to: key.slice(arrow + 1) },
			count
		);
	}

	// Kernel readings, absent off-Linux and absent until the first sample that
	// could read them.
	const psi = pressureSnapshot.psi;
	if (psi !== null && typeof psi === 'object') {
		setOptional('psi_cpu_some_avg10', psi.cpuSome10);
		setOptional('psi_memory_full_avg10', psi.memoryFull10);
		setOptional('psi_io_full_avg10', psi.ioFull10);
	}
	const cpu = pressureSnapshot.cpuThrottle;
	if (cpu !== null && typeof cpu === 'object') setOptional('cpu_throttled_ratio', cpu.throttledRatio);
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
	projectMetrics();
	return Promise.resolve(metricsRegistry.serialize());
}
