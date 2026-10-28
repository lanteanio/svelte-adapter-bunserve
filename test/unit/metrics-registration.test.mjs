import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../../', import.meta.url));

for (const [kind, name] of [
	['counter', 'upgrade_admitted_total'],
	['counter', 'framework_assertion_violations_total'],
	['gauge', 'resident_memory_bytes'],
	['gauge', 'ws_connections']
]) {
	test(`a throwing ${name} factory fails during module initialization`, () => {
		const child = spawnSync(process.execPath, ['--conditions=bunserve-test', '--input-type=module', '-e', `
			globalThis.ENV_PREFIX = '';
			globalThis.WS_PATH = '/ws';
			globalThis.WS_OPTIONS = {};
			const failKind = ${JSON.stringify(kind)}, failName = ${JSON.stringify(name)};
			globalThis.__bunserveExternalMetrics = Object.fromEntries(['counter', 'gauge', 'histogram'].map(kind => [kind, name => {
				if (kind === failKind && name === failName) throw new Error('registration refused: ' + name);
				return { inc() {}, set() {}, observe() {}, remove() {} };
			}]));
			await import('./src/runtime/handler/metrics.js');
			console.log('initialized');
		`], { cwd, encoding: 'utf8', timeout: 10000 });
		assert.notEqual(child.status, 0, child.stdout);
		assert.match(child.stderr, new RegExp('registration refused: ' + name));
		assert.doesNotMatch(child.stdout, /initialized/);
	});
}

test('a zero-initializing legacy registry receives no unsampled gauges', () => {
	const child = spawnSync(process.execPath, ['--conditions=bunserve-test', '--input-type=module', '-e', `
		import assert from 'node:assert/strict';
		globalThis.ENV_PREFIX = '';
		globalThis.WS_PATH = '/ws';
		globalThis.WS_OPTIONS = {};
		const values = new Map();
		globalThis.__bunserveExternalMetrics = {
			counter() { return { inc() {} }; },
			gauge(name) { values.set(name, 0); return { set(value) { values.set(name, value); } }; }
		};
		const { metricsSnapshot } = await import('./src/runtime/handler/metrics.js');
		const unavailable = ['heap_used_ratio', 'pressure_saturation', 'pressure_reason',
			'pressure_sample_timestamp_seconds', 'ws_backpressure_max_bytes',
			'ws_backpressure_connections', 'psi_cpu_some_avg10', 'psi_memory_full_avg10',
			'psi_io_full_avg10', 'cpu_throttled_ratio'];
		for (let i = 0; i < 2; i++) {
			for (const name of unavailable) assert.equal(values.has(name), false, name);
			assert.ok(values.get('resident_memory_bytes') > 0);
			assert.equal(values.get('ws_connections'), 0);
			await metricsSnapshot();
		}
	`], { cwd, encoding: 'utf8', timeout: 10000 });
	assert.equal(child.status, 0, child.stderr);
});

test('a sampled gauge registers once its first measurement arrives', () => {
	const child = spawnSync(process.execPath, ['--conditions=bunserve-test', '--input-type=module', '-e', `
		import assert from 'node:assert/strict';
		globalThis.ENV_PREFIX = '';
		globalThis.WS_PATH = '/ws';
		globalThis.WS_OPTIONS = {};
		globalThis.__bunserveExternalMetrics = {
			counter() { return { inc() {} }; },
			gauge(name) {
				if (name === 'pressure_saturation') throw new Error('registration refused');
				return { set() {}, remove() {} };
			}
		};
		const { metricsSnapshot } = await import('./src/runtime/handler/metrics.js');
		const { wsCounters } = await import('./src/runtime/handler/ws-state.js');
		await metricsSnapshot();
		wsCounters.lastSampleWallMs = 1700000000000;
		await assert.rejects(metricsSnapshot(), /registration refused/);
	`], { cwd, encoding: 'utf8', timeout: 10000 });
	assert.equal(child.status, 0, child.stderr);
});
