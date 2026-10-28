import '../helpers/configured-metrics.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// THE DOCUMENT A BUILD WITH NO REALTIME TIER SERVES.
//
// Its own file because `ws_options` is a build-time constant read at module
// load, and it is the one configuration where most of this manifest describes
// something the server does not contain. The scrape route is the whole reason
// such a build reaches for `platform` at all, so what it renders is the public
// contract for that build - and the rule the manifest states ("a signal this
// instance has not measured is absent, not zero") has no exception for a tier
// that is not there.
//
// Published anyway, the realtime families told a server with no upgrade path
// that it had admitted no upgrades, refused none under each of eleven reasons,
// and was holding no subscriptions.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = null;

// The platform module reaches the app's handler through a build-injected
// specifier, which nothing resolves outside a build - so the stub stands in for
// it, exactly as every other unit file that imports the platform does. A build
// with no handler compiles a module that exports no hooks, which is what the
// stub is with none set.

const { metricsSnapshot } = await import('../../src/runtime/handler/metrics.js');
const { createMemoryWallReader, processMemoryWall } = await import('../../src/runtime/utils/memory-wall.js');
const { resetRuntimeEnv, setRuntimeEnv } = await import('../../src/runtime/runtime.js');
const { httpPlatform, requestPlatform } = await import('../../src/runtime/handler/platform.js');

/** The value on a rendered line, as a string. */
function value(text, prefix) {
	const line = text.split('\n').find((l) => l.startsWith(prefix + ' ') || l.startsWith(prefix + '{'));
	return line === undefined ? undefined : line.slice(line.lastIndexOf(' ') + 1);
}

test('no realtime family appears at all', async () => {
	const text = await metricsSnapshot();
	for (const name of [
		'upgrade_admitted_total',
		'upgrade_rejected_total',
		'upgrade_deferred_rejected_total',
		'upgrade_rate_map_evicted_total',
		'ws_connections',
		'ws_subscriptions',
		'ws_publishes_total',
		'ws_backpressure_max_bytes',
		'ws_backpressure_connections',
		'pressure_saturation',
		'pressure_reason',
		'pressure_sample_timestamp_seconds'
	]) {
		assert.equal(value(text, name), undefined, `${name} describes a tier this build does not have`);
	}
});

test('and the process still answers for itself', async () => {
	// The two signals such a build CAN measure, and the reason the document is
	// worth serving there at all. They are read from the process at projection
	// time rather than from the pressure sampler's cache, which is what makes
	// them reachable with no sampler running.
	const text = await metricsSnapshot();
	assert.ok(Number(value(text, 'resident_memory_bytes')) > 1_000_000);
	// With no sampler the scrape reads the memory wall itself: the reading of an
	// independent reader on this host, within the resident set's drift between
	// the two reads, and absent where the host has no wall.
	const expected = createMemoryWallReader().measure(process.memoryUsage());
	const shown = value(text, 'heap_used_ratio');
	if (expected === null) assert.equal(shown, undefined);
	else assert.ok(Math.abs(Number(shown) - expected) <= Math.max(1e-6, expected * 0.1),
		`the wall reading ${expected}, got ${shown}`);
});

test('the scrape publishes the shared reader, and reads it at most once a second', async () => {
	// The scrape is the only reader here, and the route that drives it is the
	// app's to expose: each read sweeps the cgroup files and some take the
	// kernel's global cgroup lock, so a busy route must not set their rate.
	const real = processMemoryWall.measure;
	let reading = 0.375;
	let reads = 0;
	processMemoryWall.measure = () => { reads++; return reading; };
	// Far past any reading the earlier scrapes took on the real, epoch-anchored
	// clock, and small enough that every millisecond step is exact.
	let t = 2 ** 50;
	setRuntimeEnv({ clock: { monotonic: () => t } });
	try {
		assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), '0.375', 'the reader, exactly');
		reading = 0.5;
		t += 999;
		assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), '0.375', 'reused within the second');
		assert.equal(reads, 1);
		t += 1;
		assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), '0.5', 'read again once it has passed');
		assert.equal(reads, 2);
		reading = null;
		t += 1000;
		assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), undefined, 'unlimited retracts the earlier value');
		reading = 0;
		t += 1000;
		assert.equal(value(await metricsSnapshot(), 'heap_used_ratio'), '0', 'a measured zero resumes reporting');
	} finally {
		processMemoryWall.measure = real;
		resetRuntimeEnv();
	}
});

test('an app can still register its own instruments and read them back', async () => {
	// The documented use of `platform.metrics` on this build.
	httpPlatform.metrics.counter('orders_placed_total', 'orders placed').inc({ tier: 'pro' }, 2);
	assert.equal(value(httpPlatform.metrics.serialize(), 'orders_placed_total{tier="pro"}'), '2');
	assert.doesNotMatch(await httpPlatform.metricsSnapshot(), /orders_placed_total/);
});

test('and a request on this build is linked to exactly those members', async () => {
	// The wiring itself, not a hand-built stand-in: `requestPlatform` is what SSR
	// calls, so reverting the choice it makes fails here rather than only in the
	// live lane. What such a build must NOT have is the realtime surface - a
	// present-but-broken `publish` is worse than an absent one, since an app can
	// feature-detect the second.
	const p = requestPlatform('r-1');
	assert.equal(Object.getPrototypeOf(p), httpPlatform, 'linked to the tier-less members');
	assert.equal(p.requestId, 'r-1');
	assert.equal(p.metrics, httpPlatform.metrics);
	assert.match(await p.metricsSnapshot(), /^# HELP /m);
	assert.equal(p.publish, undefined, 'and no realtime member it cannot honour');
	assert.equal(p.pressure, undefined);
});
