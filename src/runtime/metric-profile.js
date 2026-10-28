import { SIGNALS, SIGNALS_BY_NAME } from './public-observability-manifest.js';

/** Measurement sources declare applicability; missing samples never infer it. */
export const METRIC_SOURCE_GROUPS = Object.freeze(Object.fromEntries(Object.entries({
	http: ['http_requests_total', 'http_request_duration_seconds'],
	upgrade: ['upgrade_admitted_total', 'upgrade_rejected_total', 'upgrade_duration_seconds'],
	'upgrade-rate-limit': ['upgrade_rate_map_evicted_total'],
	'upgrade-admission': ['upgrade_inflight', 'ws_connection_headroom'],
	'upgrade-pacing': ['upgrade_deferred_depth', 'upgrade_deferred_oldest_age_seconds', 'upgrade_deferred_rejected_total'],
	'waiting-room': ['waiting_room_queue_depth'],
	'protection-posture': ['protection_posture_transitions_total', 'protection_posture_state'],
	websocket: ['ws_connections', 'ws_connection_duration_seconds', 'ws_messages_total', 'ws_message_duration_seconds'],
	'message-admission': ['ws_message_admission_rejected_total'],
	subscriptions: ['ws_subscriptions'],
	publish: ['ws_publishes_total', 'ws_publish_outcomes_total'],
	backpressure: ['ws_backpressure_max_bytes', 'ws_backpressure_connections'],
	drops: ['ws_dropped_frames_total', 'ws_dropped_bytes_total'],
	egress: ['egress_refused_total', 'egress_window_evicted_total'],
	pressure: ['pressure_saturation', 'pressure_reason', 'pressure_reason_transitions_total', 'pressure_sample_timestamp_seconds'],
	'process-memory': ['resident_memory_bytes', 'heap_used_ratio'],
	'os-pressure': ['psi_cpu_some_avg10', 'psi_memory_full_avg10', 'psi_io_full_avg10', 'cpu_throttled_ratio'],
	descriptors: ['open_fds', 'fd_soft_limit'],
	'state-audit': ['state_divergence_total'],
	relay: ['relay_gap_frames_total', 'relay_spill_quarantines_total', 'relay_spill_dropped_bytes_total', 'relay_spill_pending_age_seconds', 'relay_frame_refused_total', 'relay_frame_oversized_total'],
	'framework-assertions': ['framework_assertion_violations_total'],
	'resource-audit': ['framework_resource_growth_suspected_total']
}).map(([name, signals]) => [name, Object.freeze(signals)])));

const sourceNames = Object.keys(METRIC_SOURCE_GROUPS);
const signalSources = new Map();
for (const [source, names] of Object.entries(METRIC_SOURCE_GROUPS)) {
	for (const name of names) {
		if (!SIGNALS_BY_NAME.has(name) || signalSources.has(name)) throw new Error('Invalid metric source declaration: ' + name);
		signalSources.set(name, source);
	}
}
for (const signal of SIGNALS) {
	if (signal.merged !== true && !signalSources.has(signal.name)) throw new Error('Metric has no source declaration: ' + signal.name);
}

/**
 * Declare sources implemented by an entire reporting runtime. This inventory is
 * fixed by the implementation, not inferred from a scrape or changed to hide a
 * failed sampler. Names, HELP and no-data laws retain their canonical meanings.
 * @param {{ sources: readonly string[], droppedFrameCoverage?: 'all-deliveries' | 'direct-sends' | 'unavailable' }} options
 */
export function createMetricProfile({ sources, droppedFrameCoverage = 'unavailable' }) {
	if (!Array.isArray(sources) || sources.length > sourceNames.length) throw new TypeError('Metric sources must be a bounded array');
	const selected = new Set(sources);
	if (selected.size !== sources.length) throw new TypeError('Metric sources must be unique');
	for (const source of selected) {
		if (typeof source !== 'string' || !Object.hasOwn(METRIC_SOURCE_GROUPS, source)) throw new TypeError('Unknown metric source: ' + source);
	}
	if (selected.has('drops')) {
		if (droppedFrameCoverage !== 'all-deliveries' && droppedFrameCoverage !== 'direct-sends') {
			throw new TypeError('Drop measurement requires explicit all-deliveries or direct-sends coverage');
		}
	} else if (droppedFrameCoverage !== 'unavailable') throw new TypeError('Drop coverage requires the drops measurement source');
	const signals = Object.freeze(SIGNALS.filter(signal => signal.merged === true || selected.has(signalSources.get(signal.name))));
	return Object.freeze({
		schemaVersion: 1,
		sources: Object.freeze(sourceNames.filter(source => selected.has(source))),
		droppedFrameCoverage,
		signals,
		requiredWorkerSignals: Object.freeze(signals.filter(signal => signal.merged !== true && signal.optional !== true && signal.scope === 'worker'))
	});
}

/** The native adapter continues to require its complete measurement inventory. */
export const NATIVE_METRIC_PROFILE = createMetricProfile({ sources: sourceNames, droppedFrameCoverage: 'all-deliveries' });
