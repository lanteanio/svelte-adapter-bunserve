import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

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
register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { metricsSnapshot } = await import('../../src/runtime/handler/metrics.js');
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
		'ws_closed_socket_aborts_total',
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
	const ratio = Number(value(text, 'heap_used_ratio'));
	assert.ok(ratio > 0 && ratio <= 1, `heap ratio is a fraction, got ${ratio}`);
});

test('an app can still register its own instruments and read them back', async () => {
	// The documented use of `platform.metrics` on this build.
	httpPlatform.metrics.counter('orders_placed_total', 'orders placed').inc({ tier: 'pro' }, 2);
	const text = await httpPlatform.metricsSnapshot();
	assert.equal(value(text, 'orders_placed_total{tier="pro"}'), '2');
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
	assert.match(await p.metricsSnapshot(), /^# HELP /);
	assert.equal(p.publish, undefined, 'and no realtime member it cannot honour');
	assert.equal(p.pressure, undefined);
});
