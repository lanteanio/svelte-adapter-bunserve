import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetricRegistry, formatValue } from '../../src/runtime/utils/metrics.js';
import { SIGNALS, SIGNALS_BY_NAME } from '../../src/runtime/observability-manifest.js';

// The adapter's own metrics registry and the document it renders.
//
// The exposition format is a contract with something that parses it, and every
// property here is one a scrape would break on: a label value that ends the
// line, a family rendered twice, a counter that goes backwards, a document
// whose order changes between scrapes so no two can be diffed.

/** The value line for a family, or undefined. */
function sampleLine(text, name) {
	return text.split('\n').find((line) => line.startsWith(name + ' ') || line.startsWith(name + '{'));
}

test('a declared signal renders with the manifest help and type', () => {
	const registry = createMetricRegistry();
	// The call site passes no help at all, which is the adapter's own style: the
	// manifest is where that text is reviewed.
	registry.counter('upgrade_admitted_total').inc();
	const text = registry.serialize();
	assert.match(text, /# HELP upgrade_admitted_total WebSocket upgrades accepted/);
	assert.match(text, /# TYPE upgrade_admitted_total counter/);
	assert.equal(sampleLine(text, 'upgrade_admitted_total'), 'upgrade_admitted_total 1');
});

test('the manifest help wins over a call-site string for a declared signal', () => {
	// So a scrape shows the reviewed sentence rather than whatever the wiring
	// site happened to type.
	const registry = createMetricRegistry();
	registry.counter('upgrade_admitted_total', 'something else entirely').inc();
	assert.match(registry.serialize(), /# HELP upgrade_admitted_total WebSocket upgrades accepted/);
});

test('the document is in manifest order, and app families come after', () => {
	// Two scrapes of an unchanged server must be byte-identical, or no two can
	// be diffed. Insertion order would make the document depend on which event
	// happened first.
	const registry = createMetricRegistry();
	registry.gauge('ws_connections').set(3);
	registry.counter('app_own_total', 'the app is here too').inc();
	registry.counter('upgrade_admitted_total').inc();
	const text = registry.serialize();
	const order = text.split('\n').filter((l) => l.startsWith('# TYPE')).map((l) => l.split(' ')[2]);
	assert.deepEqual(order, [
		'upgrade_admitted_total',
		'ws_connections',
		'metrics_snapshot_workers_expected',
		'metrics_snapshot_workers_reporting',
		'metrics_snapshot_degraded',
		'app_own_total'
	]);
	assert.equal(text, registry.serialize(), 'and stable across scrapes');
});

test('the series inside a family are ordered too, not left in insertion order', () => {
	// The family order above is the manifest's; this is the other half. A family
	// whose label sets render in the order events happened to arrive makes two
	// scrapes of an unchanged server differ, and a diff between them unreadable.
	const registry = createMetricRegistry();
	const counter = registry.counter('upgrade_rejected_total');
	for (const reason of ['ip_rate_limit', 'draining', 'bad_origin', 'auth_rejected']) {
		counter.inc({ reason });
	}
	const lines = registry.serialize().split('\n').filter((l) => l.startsWith('upgrade_rejected_total{'));
	assert.deepEqual(lines, [
		'upgrade_rejected_total{reason="auth_rejected"} 1',
		'upgrade_rejected_total{reason="bad_origin"} 1',
		'upgrade_rejected_total{reason="draining"} 1',
		'upgrade_rejected_total{reason="ip_rate_limit"} 1'
	]);
});

test('an app registers on the same registry and lands in the same document', () => {
	// The whole point of the adapter owning it: one registry, one scrape.
	const registry = createMetricRegistry();
	registry.counter('orders_placed_total', 'orders placed').inc({ tier: 'pro' }, 4);
	assert.match(registry.serialize(), /^orders_placed_total\{tier="pro"\} 4$/m);
});

// - what a counter accepts ----------------------------------------------------

test('inc defaults to 1 and honours an explicit value', () => {
	const registry = createMetricRegistry();
	const counter = registry.counter('ws_publishes_total');
	counter.inc();
	counter.inc(undefined, 9);
	assert.equal(sampleLine(registry.serialize(), 'ws_publishes_total'), 'ws_publishes_total 10');
});

test('an unusable increment is 1, and a negative one is ignored', () => {
	// A caller passing something unusable must not be able to poison a series
	// into unreadability for the life of the process, and a counter that goes
	// backwards is read as a reset - charging the whole value as fresh traffic.
	const registry = createMetricRegistry();
	const counter = registry.counter('ws_publishes_total');
	counter.inc(undefined, /** @type {any} */ ('7'));
	counter.inc(undefined, NaN);
	counter.inc(undefined, Infinity);
	assert.equal(sampleLine(registry.serialize(), 'ws_publishes_total'), 'ws_publishes_total 3');
	counter.inc(undefined, -5);
	assert.equal(sampleLine(registry.serialize(), 'ws_publishes_total'), 'ws_publishes_total 3');
});

test('labels in a different order are one series, not two', () => {
	const registry = createMetricRegistry();
	const counter = registry.counter('pressure_reason_transitions_total');
	counter.inc({ from: 'NONE', to: 'MEMORY' });
	counter.inc({ to: 'MEMORY', from: 'NONE' });
	const lines = registry.serialize().split('\n').filter((l) => l.startsWith('pressure_reason_transitions_total'));
	assert.deepEqual(lines, ['pressure_reason_transitions_total{from="NONE",to="MEMORY"} 2']);
});

test('two label sets that only a forged separator would merge stay apart', () => {
	// The key separator is NUL precisely because a printable one can be forged
	// out of a label VALUE, and two distinct series merging is one wrong number
	// that nothing downstream can detect.
	const registry = createMetricRegistry();
	const counter = registry.counter('upgrade_rate_map_evicted_total');
	counter.inc({ door: 'x,y' });
	counter.inc({ 'door,z': 'y' });
	const lines = registry.serialize().split('\n').filter((l) => l.startsWith('upgrade_rate_map_evicted_total{'));
	assert.equal(lines.length, 2, JSON.stringify(lines));
});

test('a label value cannot end the line or open a new sample', () => {
	// A raw newline in a value would end the sample line and Prometheus rejects
	// the document whole - every series in it, not just this one.
	const registry = createMetricRegistry();
	registry.counter('upgrade_rejected_total').inc({ reason: 'a"b\\c\nd' });
	const line = sampleLine(registry.serialize(), 'upgrade_rejected_total');
	assert.equal(line, 'upgrade_rejected_total{reason="a\\"b\\\\c\\nd"} 1');
	assert.equal(registry.serialize().split('\n').filter((l) => l.startsWith('upgrade_rejected_total')).length, 1);
});

// - gauges --------------------------------------------------------------------

test('a gauge replaces rather than accumulates, and refuses a non-number', () => {
	const registry = createMetricRegistry();
	const gauge = registry.gauge('ws_connections');
	gauge.set(5);
	gauge.set(2);
	assert.equal(sampleLine(registry.serialize(), 'ws_connections'), 'ws_connections 2');
	gauge.set(/** @type {any} */ ('3'));
	assert.equal(sampleLine(registry.serialize(), 'ws_connections'), 'ws_connections 2');
});

test('a gauge can hold a non-finite value and it renders as Prometheus spells it', () => {
	const registry = createMetricRegistry();
	registry.gauge('heap_used_ratio').set(NaN);
	assert.equal(sampleLine(registry.serialize(), 'heap_used_ratio'), 'heap_used_ratio NaN');
	assert.equal(formatValue(Infinity), '+Inf');
	assert.equal(formatValue(-Infinity), '-Inf');
});

// - histograms ----------------------------------------------------------------

test('a histogram renders cumulative buckets plus sum and count', () => {
	const registry = createMetricRegistry();
	const histogram = registry.histogram('app_latency_seconds', 'app latency', { buckets: [0.1, 1] });
	histogram.observe(0.05);
	histogram.observe(0.5);
	histogram.observe(5);
	const lines = registry.serialize().split('\n').filter((l) => l.startsWith('app_latency_seconds'));
	assert.deepEqual(lines, [
		'app_latency_seconds_bucket{le="0.1"} 1',
		'app_latency_seconds_bucket{le="1"} 2',
		'app_latency_seconds_bucket{le="+Inf"} 3',
		'app_latency_seconds_sum 5.55',
		'app_latency_seconds_count 3'
	]);
});

test('a histogram takes both call shapes and refuses a non-finite sample', () => {
	const registry = createMetricRegistry();
	const histogram = registry.histogram('app_latency_seconds', 'app latency', { buckets: [1] });
	histogram.observe(0.5);
	histogram.observe({ route: 'a' }, 0.5);
	histogram.observe(NaN);
	histogram.observe(undefined, /** @type {any} */ ('x'));
	const lines = registry.serialize().split('\n').filter((l) => /_count(\{| )/.test(l));
	assert.deepEqual(lines.sort(), [
		'app_latency_seconds_count 1',
		'app_latency_seconds_count{route="a"} 1'
	]);
});

test('unsorted buckets are sorted, so the cumulative counts are monotonic', () => {
	const registry = createMetricRegistry();
	registry.histogram('app_latency_seconds', 'app latency', { buckets: [1, 0.1] }).observe(0.5);
	const lines = registry.serialize().split('\n').filter((l) => l.includes('_bucket'));
	assert.deepEqual(lines, [
		'app_latency_seconds_bucket{le="0.1"} 0',
		'app_latency_seconds_bucket{le="1"} 1',
		'app_latency_seconds_bucket{le="+Inf"} 1'
	]);
});

// - what is absent, and what is a truthful zero -------------------------------

test('a signal that was never registered is absent, not zero', () => {
	// A zero published for something this build never measures reads as healthy
	// and no alert ever fires. Absence reads as staleness, which is the truth.
	const registry = createMetricRegistry();
	const text = registry.serialize();
	assert.doesNotMatch(text, /ws_connections/);
	assert.doesNotMatch(text, /upgrade_rejected_total/);
});

test('a registered unlabelled counter is a truthful zero; a labelled one is omitted', () => {
	// An unlabelled counter has exactly one knowable zero series. A labelled
	// family has no label values until its first event, and inventing one would
	// publish a series that never goes away.
	const registry = createMetricRegistry();
	registry.counter('upgrade_admitted_total');
	registry.counter('upgrade_rejected_total');
	const text = registry.serialize();
	assert.equal(sampleLine(text, 'upgrade_admitted_total'), 'upgrade_admitted_total 0');
	assert.doesNotMatch(text, /^upgrade_rejected_total/m);
	assert.doesNotMatch(text, /# TYPE upgrade_rejected_total/);
});

test('the document always carries its own completeness, even when empty', () => {
	// An alert written against metrics_snapshot_degraded on the sibling must not
	// silently evaluate over a missing series here: a rule that never fires reads
	// exactly like a system that is never degraded.
	const text = createMetricRegistry().serialize();
	assert.match(text, /^metrics_snapshot_workers_expected 1$/m);
	assert.match(text, /^metrics_snapshot_workers_reporting 1$/m);
	assert.match(text, /^metrics_snapshot_degraded 0$/m);
});

// - registration --------------------------------------------------------------

test('registering the same name twice keeps what was counted', () => {
	// A module evaluated twice must not silently reset the counters.
	const registry = createMetricRegistry();
	registry.counter('ws_publishes_total').inc(undefined, 5);
	registry.counter('ws_publishes_total').inc();
	assert.equal(sampleLine(registry.serialize(), 'ws_publishes_total'), 'ws_publishes_total 6');
});

test('reset drops everything', () => {
	const registry = createMetricRegistry();
	registry.gauge('ws_connections').set(9);
	registry.reset();
	assert.doesNotMatch(registry.serialize(), /ws_connections/);
});

test('read hands back the structured values behind the document', () => {
	const registry = createMetricRegistry();
	registry.counter('upgrade_rejected_total').inc({ reason: 'draining' }, 2);
	registry.gauge('ws_connections').set(7);
	registry.histogram('app_latency_seconds', 'app latency', { buckets: [1] }).observe(0.5);
	const read = registry.read();
	assert.deepEqual(read.find((s) => s.name === 'upgrade_rejected_total'),
		{ name: 'upgrade_rejected_total', labels: { reason: 'draining' }, value: 2 });
	assert.deepEqual(read.find((s) => s.name === 'ws_connections'),
		{ name: 'ws_connections', labels: {}, value: 7 });
	assert.deepEqual(read.find((s) => s.name === 'app_latency_seconds').histogram,
		{ buckets: [1], counts: [1], count: 1, sum: 0.5 });
});

// - the manifest itself -------------------------------------------------------

test('every declared signal is well-formed and uniquely named', () => {
	const seen = new Set();
	for (const signal of SIGNALS) {
		assert.match(signal.name, /^[a-z][a-z0-9_]*$/, signal.name);
		assert.ok(!seen.has(signal.name), `duplicate ${signal.name}`);
		seen.add(signal.name);
		assert.ok(['counter', 'gauge', 'histogram'].includes(signal.type), signal.name);
		assert.ok(Array.isArray(signal.labels), signal.name);
		assert.ok(typeof signal.help === 'string' && signal.help.length > 0, signal.name);
		// A counter's name says it accumulates; anything else must not claim to.
		if (signal.type === 'counter') assert.match(signal.name, /_total$/, signal.name);
		assert.equal(SIGNALS_BY_NAME.get(signal.name), signal);
	}
});

test('a unit-suffixed name matches its declared unit', () => {
	// A bucket bound or a threshold read in the wrong unit is the classic
	// observability defect, and the name is the only thing most readers see.
	for (const signal of SIGNALS) {
		if (signal.name.endsWith('_seconds')) assert.equal(signal.unit, 'seconds', signal.name);
		if (signal.name.endsWith('_bytes')) assert.equal(signal.unit, 'bytes', signal.name);
		if (signal.unit === 'seconds') assert.match(signal.name, /_seconds$/, signal.name);
		if (signal.unit === 'bytes') assert.match(signal.name, /_bytes$/, signal.name);
	}
});
