import '../helpers/configured-metrics.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// What the scrape actually says about a running server.
//
// The registry's own tests cover the document format; this covers the
// PROJECTION - that each series carries the number the runtime authoritatively
// holds, and that a signal this build cannot measure is absent rather than a
// zero that reads as healthy.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
}).options;


const { metricsSnapshot, metricsRegistry } = await import('../../src/runtime/handler/metrics.js');
const { runtimeMetricProfile } = await import('../../src/runtime/handler/metric-profile.js');
const { SIGNALS, SIGNALS_BY_NAME } = await import('../../src/runtime/observability-manifest.js');
const { processMemoryWall } = await import('../../src/runtime/utils/memory-wall.js');
const { httpPlatform, platform } = await import('../../src/runtime/handler/platform.js');
const {
	UPGRADE_REJECTION_REASONS, pressureSnapshot, recordUpgradeRejection, wsCounters
} = await import('../../src/runtime/handler/ws-state.js');

/** The value on a rendered line, as a string. */
function value(text, prefix) {
	const line = text.split('\n').find((l) => l.startsWith(prefix + ' ') || l.startsWith(prefix + '{'));
	return line === undefined ? undefined : line.slice(line.lastIndexOf(' ') + 1);
}

/** Every line of one family. */
function family(text, name) {
	return text.split('\n').filter((l) => l.startsWith(name + '{') || l.startsWith(name + ' '));
}

/**
 * Count the shared memory-wall reader's reads while fn runs, with the
 * reader answering `reading`.
 */
async function readsDuring(reading, fn) {
	const real = processMemoryWall.measure;
	let reads = 0;
	processMemoryWall.measure = () => { reads++; return reading; };
	try {
		await fn();
	} finally {
		processMemoryWall.measure = real;
	}
	return reads;
}

// DECLARED FIRST, and it has to be: `lastSampleWallMs` only ever goes from zero
// to a time, so the window this describes exists once per process and any test
// that sets it closes the window for every test after it.
test('nothing the sampler produces is published before its first tick', async () => {
	// A zero here is not a reading. It says the process holds no memory, has no
	// saturation, and was last sampled in 1970 - and an orchestrator's first
	// scrape lands inside exactly this window.
	assert.equal(wsCounters.lastSampleWallMs, 0, 'no sample has been taken yet');
	const text = await metricsSnapshot();
	assert.equal(value(text, 'metrics_snapshot_workers_reporting'), '0', 'supported gauges remain required before sampling');
	for (const name of [
		'pressure_sample_timestamp_seconds',
		'pressure_saturation',
		'pressure_reason',
		'ws_backpressure_max_bytes',
		'ws_backpressure_connections',
		'heap_used_ratio'
	]) {
		assert.equal(family(text, name).length, 0, `${name} is absent until something measures it`);
	}
	// What the runtime knows continuously is published from the first scrape.
	assert.notEqual(value(text, 'ws_connections'), undefined);
	assert.notEqual(value(text, 'ws_subscriptions'), undefined);
	// And so is the process itself. These are not the sampler's to withhold:
	// they are read from the process when something scrapes, so an instance that
	// runs no sampler at all still answers them.
	assert.ok(Number(value(text, 'resident_memory_bytes')) > 0, 'resident memory is a real reading');
	// heap_used_ratio is the sampler's reading here, so it waits for the tick
	// like the gauges above: a live read in this window would be a value the
	// MEMORY reason and the send gate never used. Only the stamp says a
	// reading exists - a figure in the counter without one is not served.
	wsCounters.lastMeasuredHeapUsedRatio = 0.5;
	const reads = await readsDuring(0.75, async () => {
		assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), undefined);
	});
	assert.equal(reads, 0, 'and the scrape takes no reading of its own');
	wsCounters.lastMeasuredHeapUsedRatio = 0;
});

test('every family rendered by a default WebSocket build has a manifest entry', async () => {
	// Run before an app registers its own families on the shared registry.
	const text = await metricsSnapshot();
	const families = text.split('\n').filter(line => line.startsWith('# TYPE ')).map(line => line.split(' ')[2]);
	assert.ok(families.includes('egress_refused_total'));
	assert.ok(families.includes('egress_window_evicted_total'));
	assert.deepEqual(families.filter(name => !SIGNALS_BY_NAME.has(name)), []);
	for (const name of ['egress_refused_total', 'egress_window_evicted_total']) {
		const signal = SIGNALS_BY_NAME.get(name);
		assert.equal(signal.type, 'counter');
		assert.deepEqual(signal.labels, ['scope']);
		assert.equal(signal.unit, null);
		assert.notEqual(signal.optional, true);
		assert.ok(text.includes(`# HELP ${name} ${signal.help}\n`));
	}
});

test('the refusal bag is published under every reason, zeroes included', async () => {
	// A dashboard should show "no origin refusals" as a flat zero line rather
	// than as a gap, which reads like a missing exporter.
	recordUpgradeRejection('bad_origin');
	recordUpgradeRejection('bad_origin');
	recordUpgradeRejection('ip_rate_limit');
	const text = await metricsSnapshot();
	assert.equal(value(text, 'upgrade_rejected_total{reason="bad_origin"}'), '2');
	assert.equal(value(text, 'upgrade_rejected_total{reason="ip_rate_limit"}'), '1');
	assert.equal(value(text, 'upgrade_rejected_total{reason="draining"}'), '0');
	assert.equal(
		family(text, 'upgrade_rejected_total').length,
		UPGRADE_REJECTION_REASONS.length,
		'one series per declared reason'
	);
});

test('an admitted upgrade is counted, so the refusals have a denominator', async () => {
	wsCounters.upgradeAdmittedTotal = 7;
	assert.equal(value(await metricsSnapshot(), 'upgrade_admitted_total'), '7');
});

test('the counters follow the runtime rather than a parallel tally', async () => {
	// The projection reads the authoritative state, so nothing can drift: the
	// registry is the only way out for these counters, which is how uws reports
	// them too - platform carries the registry, not a getter per counter.
	wsCounters.publishCount = 12;
	wsCounters.closedWsAborts = 3;
	wsCounters.totalSubscriptions = 40;
	const text = await metricsSnapshot();
	assert.equal(value(text, 'ws_publishes_total'), '12');
	assert.doesNotMatch(text, /ws_closed_socket_aborts_total/);
	assert.equal(value(text, 'ws_subscriptions'), '40');
});

test('a later scrape reflects the newer value, not the sum of the two', async () => {
	// A projected counter is SET from the source, and setting it repeatedly must
	// not accumulate - the source is already cumulative.
	wsCounters.publishCount = 100;
	await metricsSnapshot();
	await metricsSnapshot();
	assert.equal(value(await metricsSnapshot(), 'ws_publishes_total'), '100');
});

test('the pressure reason is the severity code the sibling uses', async () => {
	// A gauge cannot carry a string, and a dashboard that thresholds on this
	// number has to mean the same thing on both adapters.
	//
	// The sample stamp opens the window the test above closes: from here on this
	// file describes a server whose sampler has ticked at least once.
	wsCounters.lastSampleWallMs = 1_700_000_000_000;
	pressureSnapshot.reason = 'MEMORY';
	assert.equal(value(await metricsSnapshot(), 'pressure_reason'), '6');
	pressureSnapshot.reason = 'SUBSCRIBERS';
	assert.equal(value(await metricsSnapshot(), 'pressure_reason'), '1');
	pressureSnapshot.reason = 'NONE';
	assert.equal(value(await metricsSnapshot(), 'pressure_reason'), '0');
});

test('the sample timestamp is in seconds, as its name says', async () => {
	// The sampler records wall-clock milliseconds. Published as-is, every sample
	// would be dated fifty thousand years out and every freshness alert would
	// fire forever.
	wsCounters.lastSampleWallMs = 1_700_000_000_000;
	assert.equal(value(await metricsSnapshot(), 'pressure_sample_timestamp_seconds'), '1700000000');
});

test('the pressure gauges carry the last sample', async () => {
	// Stated explicitly rather than inherited from whichever test ran first: the
	// stamp is what opens the window, and a test that depends on a neighbour for
	// it passes or fails on declaration order.
	wsCounters.lastSampleWallMs = 1_700_000_000_000;
	pressureSnapshot.value = 0.5;
	pressureSnapshot.maxBufferedBytes = 4096;
	pressureSnapshot.backpressuredConnections = 2;
	const text = await metricsSnapshot();
	assert.equal(value(text, 'pressure_saturation'), '0.5');
	assert.equal(value(text, 'ws_backpressure_max_bytes'), '4096');
	assert.equal(value(text, 'ws_backpressure_connections'), '2');
});

test('resident memory is the process, not the sampler', async () => {
	// It used to be republished from the sampler's cache, which meant a build
	// with no WebSocket handler - where no sampler ever runs - could not answer
	// it at all. It is read at projection time now, so a stale cache cannot be
	// served and no realtime tier is needed to have it.
	const text = await metricsSnapshot();
	assert.ok(Number(value(text, 'resident_memory_bytes')) > 1_000_000, 'a real resident size');
});

test("heap_used_ratio is the sampler's reading once there is one", async () => {
	// The family contract feeds the gauge and the MEMORY reason from one
	// reading, so the gauge publishes the value the reason was decided on -
	// the two cannot disagree near the threshold - and the scrape does no
	// cgroup reads of its own.
	wsCounters.lastSampleWallMs = 1_700_000_000_000;
	wsCounters.lastMeasuredHeapUsedRatio = 0.25;
	const reads = await readsDuring(0.75, async () => {
		assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), '0.25');
		wsCounters.lastMeasuredHeapUsedRatio = 0;
		assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), '0', 'a measured zero remains present');
	});
	assert.equal(reads, 0, 'the scrape reads no cgroup file where the sampler has read them');
	// A reset stamp (the simulator zeroes it between runs) withdraws the series
	// rather than leaving the last reading up.
	wsCounters.lastSampleWallMs = 0;
	assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), undefined);
	wsCounters.lastSampleWallMs = 1_700_000_000_000;
});

test('heap_used_ratio is declared as svelte-adapter-uws declares it', () => {
	const signal = SIGNALS.find((s) => s.name === 'heap_used_ratio');
	assert.equal(signal?.optional, true, 'an unknown wall has no measurement');
	assert.equal(signal?.help,
		'Used fraction of the nearest memory wall (heap vs the V8 limit, resident set vs the cgroup memory limit, worst-of)');
});

test('a value written under heap_used_ratio is never served as the reading', async () => {
	// An app holding its own handle on the name cannot publish under it: the
	// next scrape sets the reading over whatever was written.
	wsCounters.lastSampleWallMs = 1_700_000_000_000;
	wsCounters.lastMeasuredHeapUsedRatio = 0.125;
	metricsRegistry.gauge('heap_used_ratio').set(0.4242);
	assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), '0.125');
});

test('a reason transition is counted from and to', async () => {
	wsCounters.pressureReasonTransitions.set('NONE>MEMORY', 3);
	wsCounters.pressureReasonTransitions.set('MEMORY>NONE', 2);
	const text = await metricsSnapshot();
	assert.equal(value(text, 'pressure_reason_transitions_total{from="NONE",to="MEMORY"}'), '3');
	assert.equal(value(text, 'pressure_reason_transitions_total{from="MEMORY",to="NONE"}'), '2');
});

// - what is absent ------------------------------------------------------------

test('ungated upgrades and an absent pacing queue have measured idle state', async () => {
	// The independent handshake tracker is idle; no pacing queue exists.
	const text = await metricsSnapshot();
	assert.equal(value(text, 'upgrade_inflight'), '0');
	assert.equal(value(text, 'upgrade_deferred_depth'), '0');
	assert.equal(value(text, 'upgrade_deferred_oldest_age_seconds'), '0');
	assert.doesNotMatch(text, /ws_connection_headroom/);
});

test('the kernel gauges are absent when the platform has no readings', async () => {
	// Off Linux `psi` and `cpuThrottle` are null for the life of the process, and
	// a zero there is a measurement that never happened.
	pressureSnapshot.psi = null;
	pressureSnapshot.cpuThrottle = null;
	const text = await metricsSnapshot();
	assert.doesNotMatch(text, /psi_cpu_some_avg10/);
	assert.doesNotMatch(text, /cpu_throttled_ratio/);
});

test('and present once a reading exists', async () => {
	pressureSnapshot.psi = { cpuSome10: 12.5, memoryFull10: 0, ioFull10: 3 };
	pressureSnapshot.cpuThrottle = { throttledRatio: 0.4, nrThrottledDelta: 2 };
	const text = await metricsSnapshot();
	assert.equal(value(text, 'psi_cpu_some_avg10'), '12.5');
	assert.equal(value(text, 'psi_memory_full_avg10'), '0');
	assert.equal(value(text, 'psi_io_full_avg10'), '3');
	assert.equal(value(text, 'cpu_throttled_ratio'), '0.4');
	pressureSnapshot.psi = null;
	pressureSnapshot.cpuThrottle = null;
});

test('and absent again when the kernel stops answering', async () => {
	// The order matters, and it is the point: a reading existed a moment ago.
	// `/proc/pressure/*` returns null for a TRANSIENT failure as readily as a
	// permanent one - a container losing the mount, a read racing a cgroup move -
	// and a gauge left registered would republish the pre-failure number as
	// current, which no dashboard can tell from a live one and no alert on the
	// value can fire on.
	pressureSnapshot.psi = { cpuSome10: 12.5, memoryFull10: 0, ioFull10: 3 };
	pressureSnapshot.cpuThrottle = { throttledRatio: 0.4, nrThrottledDelta: 2 };
	assert.equal(value(await metricsSnapshot(), 'psi_cpu_some_avg10'), '12.5');
	pressureSnapshot.psi = null;
	pressureSnapshot.cpuThrottle = null;
	const text = await metricsSnapshot();
	assert.doesNotMatch(text, /psi_cpu_some_avg10/);
	assert.doesNotMatch(text, /psi_memory_full_avg10/);
	assert.doesNotMatch(text, /psi_io_full_avg10/);
	assert.doesNotMatch(text, /cpu_throttled_ratio/);
	// And measurable again without a restart.
	pressureSnapshot.psi = { cpuSome10: 7, memoryFull10: 1, ioFull10: 2 };
	assert.equal(value(await metricsSnapshot(), 'psi_cpu_some_avg10'), '7');
	pressureSnapshot.psi = null;
	await metricsSnapshot();
});

test('a handle an app took on the same name cannot resurrect it permanently', async () => {
	// Instruments resolve their family BY NAME on every write, which is what
	// makes a handle survive `reset()` - and it means an app holding one for a
	// name the adapter retracts re-creates the family by writing to it. The
	// retraction has to keep working after that: guarded on the map delete it
	// would fire once, find nothing, and never retract again, so the resurrected
	// family would publish "the CPU is not stalled at all" from a source that
	// stopped answering, for the life of the process.
	pressureSnapshot.psi = { cpuSome10: 12.5, memoryFull10: 0, ioFull10: 3 };
	await metricsSnapshot();
	const appHandle = metricsRegistry.gauge('psi_cpu_some_avg10');
	pressureSnapshot.psi = null;
	assert.doesNotMatch(await metricsSnapshot(), /psi_cpu_some_avg10/, 'retracted');

	appHandle.set(0);
	assert.equal(value(await metricsSnapshot(), 'psi_cpu_some_avg10'), undefined,
		'and retracted again on the very next scrape, not left publishing a zero');
	// Twice more, because "fires once then never again" is exactly the shape of
	// the guard this replaces.
	appHandle.set(0);
	assert.doesNotMatch(await metricsSnapshot(), /psi_cpu_some_avg10/);
	appHandle.set(0);
	assert.doesNotMatch(await metricsSnapshot(), /psi_cpu_some_avg10/);
});

test('the eviction counter names every door that meters', async () => {
	// Both doors take the defaults here, so both keep a map, and both publish a
	// zero from the first scrape - the flat line that says "no evictions" rather
	// than a gap that reads like a missing exporter. The other half of the rule -
	// a door with no limiter naming no series - is its own file, because the
	// limiters are built once from module-level config.
	const text = await metricsSnapshot();
	assert.equal(value(text, 'upgrade_rate_map_evicted_total{door="upgrade"}'), '0');
	assert.equal(value(text, 'upgrade_rate_map_evicted_total{door="auth"}'), '0');
});

// - the platform surface ------------------------------------------------------

test('the platform exposes the registry an app registers on', async () => {
	assert.equal(platform.metrics, metricsRegistry);
	platform.metrics.counter('orders_placed_total', 'orders placed').inc({ tier: 'pro' }, 2);
	assert.equal(value(platform.metrics.serialize(), 'orders_placed_total{tier="pro"}'), '2');
	assert.doesNotMatch(await platform.metricsSnapshot(), /orders_placed_total/,
		'application metrics stay in the operator registry, outside the adapter mirror');
});

test('a build with no realtime tier serves the same two members', async () => {
	// What a WebSocket-less build's request platform is prototype-linked to.
	// Both members are documented as being on every instance, so they are
	// defined once and the realtime platform takes them from here - a second
	// declaration is how one of the two ends up answering with a different
	// registry, or with nothing at all.
	const requestPlatform = Object.assign(Object.create(httpPlatform), { requestId: 'r-1' });
	assert.equal(requestPlatform.metrics, metricsRegistry);
	assert.equal(typeof requestPlatform.metricsSnapshot, 'function');
	assert.match(await requestPlatform.metricsSnapshot(), /^# HELP /m);
	// The realtime platform serves the SAME members, not copies of them.
	assert.equal(
		Object.getOwnPropertyDescriptor(platform, 'metrics').get,
		Object.getOwnPropertyDescriptor(httpPlatform, 'metrics').get
	);
	assert.equal(platform.metricsSnapshot, httpPlatform.metricsSnapshot);
});

test('a sampled runtime renders every required supported family and reports complete', async () => {
 wsCounters.lastSampleWallMs = 1_700_000_000_000;
 const text = await metricsSnapshot();
 assert.deepEqual(runtimeMetricProfile.sources, [
  'http', 'upgrade', 'upgrade-rate-limit', 'upgrade-admission', 'upgrade-pacing',
  'websocket', 'subscriptions', 'publish', 'backpressure', 'drops', 'egress',
  'pressure', 'process-memory', 'os-pressure', 'framework-assertions'
 ]);
 assert.deepEqual(runtimeMetricProfile.requiredWorkerSignals.map(signal => signal.name).sort(), [
  'http_requests_total', 'upgrade_admitted_total', 'upgrade_rejected_total',
  'upgrade_rate_map_evicted_total', 'upgrade_inflight', 'upgrade_deferred_depth',
  'upgrade_deferred_oldest_age_seconds', 'upgrade_deferred_rejected_total',
  'ws_connections', 'ws_messages_total', 'ws_subscriptions', 'ws_publishes_total',
  'ws_publish_outcomes_total', 'ws_backpressure_max_bytes', 'ws_backpressure_connections',
  'ws_dropped_frames_total', 'ws_dropped_bytes_total', 'egress_refused_total',
  'egress_window_evicted_total', 'pressure_saturation', 'pressure_reason',
  'pressure_reason_transitions_total', 'pressure_sample_timestamp_seconds',
  'framework_assertion_violations_total'
 ].sort());
 const missing = runtimeMetricProfile.requiredWorkerSignals.filter(signal =>
  !text.includes(`# TYPE ${signal.name} ${signal.type}\n`));
 assert.deepEqual(missing, [], 'every implemented required source must render');
 for (const source of ['relay_', 'state_divergence_total', 'waiting_room_queue_depth',
  'protection_posture_', 'ws_message_admission_rejected_total']) {
  assert.ok(!text.includes(source), source);
 }
 assert.equal(value(text, 'metrics_snapshot_workers_expected'), '1');
 assert.equal(value(text, 'metrics_snapshot_workers_reporting'), '1');
 assert.equal(value(text, 'metrics_snapshot_degraded'), '0');
 assert.match(text, /^# ws_dropped_coverage direct-sends$/m);
});

test('the sampler projects current adapter values into the operator registry', async () => {
	wsCounters.publishCount = 4242;
	assert.equal(typeof wsCounters.metricsSampleHook, 'function');
	wsCounters.metricsSampleHook();
	const direct = platform.metrics.serialize();
	assert.equal(value(direct, 'ws_publishes_total'), '4242');
	const snapshot = await platform.metricsSnapshot();
	for (const name of ['ws_publishes_total', 'upgrade_admitted_total', 'ws_connections']) {
		assert.equal(value(direct, name), value(snapshot, name), name);
	}
	assert.equal(value(direct, 'orders_placed_total{tier="pro"}'), '2');
	assert.doesNotMatch(snapshot, /orders_placed_total/);
});

test('a configured snapshot is a promise resolving to canonical adapter text', async () => {
	const promise = platform.metricsSnapshot();
	assert.ok(promise instanceof Promise);
	const text = await promise;
	assert.equal(typeof text, 'string');
	assert.match(text, /^# HELP /m);
	assert.match(text, /^metrics_snapshot_degraded 0$/m);
});
