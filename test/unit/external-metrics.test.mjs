import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetricRegistry } from '../../src/runtime/utils/metrics.js';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';
const external = Object.freeze(createMetricRegistry());
globalThis.__bunserveExternalMetrics = external;
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({ metrics: './metrics.js' }).options;
const { metricsRegistry, metricsSnapshot, projectMetrics, metricsInstrument } = await import('../../src/runtime/handler/metrics.js');
const { pressureSnapshot, wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const { readMetricMirror } = await import('../../src/runtime/utils/metrics-mirror.js');

test('external registry retains identity and projection increments only new counter values', async () => {
 assert.equal(metricsRegistry, external);
 wsCounters.upgradeAdmittedTotal = 7;
 projectMetrics(); projectMetrics();
 assert.match(external.serialize(), /^upgrade_admitted_total 7$/m);
 wsCounters.upgradeAdmittedTotal = 9;
 projectMetrics();
 assert.match(external.serialize(), /^upgrade_admitted_total 9$/m);
 assert.match(await metricsSnapshot(), /^upgrade_admitted_total 9$/m);
});

test('external optional gauges withdraw both samples and mirrors', () => {
 pressureSnapshot.psi = { cpuSome10: 2, memoryFull10: 3, ioFull10: 4 };
 projectMetrics();
 assert.match(external.serialize(), /^psi_cpu_some_avg10 2$/m);
 pressureSnapshot.psi = null;
 projectMetrics();
 assert.doesNotMatch(external.serialize(), /^psi_cpu_some_avg10 /m);
 assert.equal(readMetricMirror().some(s => s.name === 'psi_cpu_some_avg10' && 'value' in s), false);
});

test('transport instruments use the same external registry and canonical snapshot', async () => {
 metricsInstrument('counter', 'http_requests_total').inc({ method: 'get', outcome: 'ok' });
 metricsInstrument('histogram', 'http_request_duration_seconds').observe({ method: 'get', outcome: 'ok' }, 0.025);
 assert.match(external.serialize(), /http_requests_total\{method="get",outcome="ok"\} 1/);
 assert.match(await metricsSnapshot(), /http_request_duration_seconds_count\{method="get",outcome="ok"\} 1/);
});
