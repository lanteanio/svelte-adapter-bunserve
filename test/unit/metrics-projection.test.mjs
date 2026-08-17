import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
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
	allowUnauthenticatedSubscribe: true
}).options;

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { metricsSnapshot, metricsRegistry } = await import('../../src/runtime/handler/metrics.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
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
	// The projection reads the authoritative state, so nothing can drift: these
	// are the same fields platform.publishCount and platform.closedWsAborts read.
	wsCounters.publishCount = 12;
	wsCounters.closedWsAborts = 3;
	wsCounters.totalSubscriptions = 40;
	const text = await metricsSnapshot();
	assert.equal(value(text, 'ws_publishes_total'), '12');
	assert.equal(value(text, 'ws_closed_socket_aborts_total'), '3');
	assert.equal(value(text, 'ws_subscriptions'), '40');
	assert.equal(value(text, 'ws_publishes_total'), String(platform.publishCount));
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
	pressureSnapshot.value = 0.5;
	pressureSnapshot.maxBufferedBytes = 4096;
	pressureSnapshot.backpressuredConnections = 2;
	wsCounters.lastResidentBytes = 123456;
	wsCounters.lastHeapUsedRatio = 0.25;
	const text = await metricsSnapshot();
	assert.equal(value(text, 'pressure_saturation'), '0.5');
	assert.equal(value(text, 'ws_backpressure_max_bytes'), '4096');
	assert.equal(value(text, 'ws_backpressure_connections'), '2');
	assert.equal(value(text, 'resident_memory_bytes'), '123456');
	assert.equal(value(text, 'heap_used_ratio'), '0.25');
});

test('a reason transition is counted from and to', async () => {
	wsCounters.pressureReasonTransitions.set('NONE>MEMORY', 3);
	wsCounters.pressureReasonTransitions.set('MEMORY>NONE', 2);
	const text = await metricsSnapshot();
	assert.equal(value(text, 'pressure_reason_transitions_total{from="NONE",to="MEMORY"}'), '3');
	assert.equal(value(text, 'pressure_reason_transitions_total{from="MEMORY",to="NONE"}'), '2');
});

// - what is absent ------------------------------------------------------------

test('the admission gauges are absent on a server with no ceiling', async () => {
	// There is no in-flight ledger to read without one, and a zero would say "no
	// upgrades in flight" on a server that simply does not count them.
	const text = await metricsSnapshot();
	assert.doesNotMatch(text, /upgrade_inflight/);
	assert.doesNotMatch(text, /upgrade_deferred_depth/);
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

// - the platform surface ------------------------------------------------------

test('the platform exposes the registry an app registers on', async () => {
	assert.equal(platform.metrics, metricsRegistry);
	platform.metrics.counter('orders_placed_total', 'orders placed').inc({ tier: 'pro' }, 2);
	const text = await platform.metricsSnapshot();
	assert.equal(value(text, 'orders_placed_total{tier="pro"}'), '2');
	// After the adapter's own, so the document still starts with the manifest.
	assert.ok(text.indexOf('orders_placed_total') > text.indexOf('upgrade_admitted_total'));
});

test('the snapshot is a promise resolving to text, never null', async () => {
	// The sibling can answer null (no registry configured) and its collection is
	// a round trip that can fail; here there is one process and the answer is in
	// memory. A route written against the sibling awaits either way.
	const promise = platform.metricsSnapshot();
	assert.ok(promise instanceof Promise);
	const text = await promise;
	assert.equal(typeof text, 'string');
	assert.match(text, /^# HELP /);
	assert.match(text, /^metrics_snapshot_degraded 0$/m);
});
