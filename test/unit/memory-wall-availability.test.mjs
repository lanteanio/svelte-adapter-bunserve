import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryWallReader } from '../../src/runtime/utils/memory-wall.js';
import { createMetricRegistry } from '../../src/runtime/utils/metrics.js';
import { containMetricInstrument, mirrorRegistry, readMetricMirror, resetMetricMirror } from '../../src/runtime/utils/metrics-mirror.js';
import { SIGNALS_BY_NAME } from '../../src/runtime/public-observability-manifest.js';

const absent = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
function wallFixture(engineLimit = 0) {
	let limit = 'max';
	const reader = createMemoryWallReader({
		heapStatistics: () => ({ heap_size_limit: engineLimit }),
		readFile(path) {
			if (path === '/proc/self/cgroup') return '0::/';
			if (path === '/sys/fs/cgroup/memory.max') return limit;
			return absent();
		}
	});
	return { reader, setLimit(value) { limit = value; } };
}
const readings = () => readMetricMirror().filter(s => s.name === 'heap_used_ratio');
beforeEach(() => resetMetricMirror());

test('memory walls distinguish unavailable, measured zero, and finite/unlimited/finite transitions', () => {
	const { reader, setLimit } = wallFixture();
	assert.equal(reader.measure({ heapUsed: 10, rss: 30 }), null);
	assert.equal(reader.ratio({ heapUsed: 10, rss: 30 }), 0);
	assert.equal(reader.hasEngineLimit(), false);
	setLimit('100');
	assert.equal(reader.measure({ heapUsed: 0, rss: 0 }), 0);
	assert.equal(reader.measure({ heapUsed: 10, rss: 30 }), 0.3);
	setLimit('max');
	assert.equal(reader.measure({ heapUsed: 10, rss: 30 }), null);
	setLimit('50');
	assert.equal(reader.measure({ heapUsed: 10, rss: 30 }), 0.6);
	assert.equal(SIGNALS_BY_NAME.get('heap_used_ratio').optional, true);
});

test('a latched engine ceiling survives a disappearing cgroup wall', () => {
	const { reader, setLimit } = wallFixture(100);
	setLimit('20');
	assert.equal(reader.measure({ heapUsed: 10, rss: 15 }), 0.75);
	assert.equal(reader.hasEngineLimit(), true);
	setLimit('max');
	assert.equal(reader.measure({ heapUsed: 10, rss: 15 }), 0.1);
});

test('optional gauges retract both the external value and worker mirror, then resume', () => {
	let external;
	const gauge = containMetricInstrument(mirrorRegistry({ gauge: () => ({
		set(value) { external = value; }, remove() { external = undefined; }
	}) }).gauge('heap_used_ratio', 'h'));
	gauge.setOptional(0.6, false);
	assert.equal(external, 0.6);
	assert.deepEqual(readings(), [{ name: 'heap_used_ratio', labels: {}, value: 0.6 }]);
	gauge.setOptional(null, false);
	assert.equal(external, undefined);
	assert.deepEqual(readings(), []);
	gauge.setOptional(0, false);
	assert.equal(external, 0);
	assert.equal(readings()[0].value, 0);
});

test('legacy registries see only permanently available memory samples while their mirror remains current', () => {
	const external = [];
	const gauge = containMetricInstrument(mirrorRegistry({ gauge: () => ({ set(value) { external.push(value); } }) }).gauge('heap_used_ratio', 'h'));
	for (const value of [0.5, null, 0.2]) gauge.setOptional(value, false);
	assert.deepEqual(external, []);
	assert.equal(readings()[0].value, 0.2);
	gauge.setOptional(null, false);
	assert.deepEqual(readings(), []);
	gauge.setOptional(0.1, true);
	assert.deepEqual(external, [0.1]);
});

test('a throwing external removal cannot retain the mirror or escape containment', () => {
	const original = console.error;
	let warnings = 0;
	console.error = () => { warnings++; };
	try {
		const gauge = containMetricInstrument(mirrorRegistry({ gauge: () => ({
			set() {}, remove() { throw new Error('unavailable'); }
		}) }).gauge('heap_used_ratio', 'h'));
		gauge.setOptional(0.5, false);
		assert.doesNotThrow(() => { gauge.setOptional(null, false); gauge.remove(); });
		assert.deepEqual(readings(), []);
		assert.equal(warnings, 1);
	} finally { console.error = original; }
});

test('built-in gauge removal emits no fabricated zero and existing handles can resume after removal or reset', () => {
	const registry = createMetricRegistry();
	const gauge = registry.gauge('heap_used_ratio');
	gauge.set(0.75);
	assert.match(registry.serialize(), /^heap_used_ratio 0.75$/m);
	gauge.remove();
	assert.doesNotMatch(registry.serialize(), /^heap_used_ratio /m);
	assert.deepEqual(registry.read(), []);
	gauge.set(0);
	assert.match(registry.serialize(), /^heap_used_ratio 0$/m);
	registry.reset();
	gauge.set(0.25);
	assert.match(registry.serialize(), /^heap_used_ratio 0.25$/m);
	gauge.remove();
	assert.doesNotMatch(registry.serialize(), /^heap_used_ratio /m);
});
