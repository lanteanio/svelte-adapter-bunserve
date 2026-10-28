import { test as it } from 'node:test';
import assert from 'node:assert/strict';
import { METRIC_SOURCE_GROUPS, NATIVE_METRIC_PROFILE, createMetricProfile, SIGNALS, SIGNALS_BY_NAME } from '../../src/observability.js';
import { mergeSamples } from '../../src/runtime/utils/metrics-merge.js';
import { METRIC_REGISTRATIONS_SAMPLE } from '../../src/runtime/utils/metrics-mirror.js';


const expect = value => ({
 toEqual: expected => assert.deepEqual(value, expected),
 toBe: expected => assert.equal(value, expected),
 toContain: expected => assert.ok(value.includes(expected), `Missing ${expected} in ${value}`),
 toThrow: expected => assert.throws(value, expected ? error => error.message.includes(expected) : undefined),
 not: { toContain: expected => assert.ok(!value.includes(expected), `Unexpected ${expected} in ${value}`) }
});
it.each = rows => (_title, callback) => rows.forEach(row => it(`rejects invalid metric source inventory ${JSON.stringify(row)}`, () => callback(row)));

const transportFamilies = ['http_requests_total', 'ws_connections', 'ws_messages_total'];
const transportReport = () => ({ worker: 0, samples: [
	{ name: METRIC_REGISTRATIONS_SAMPLE, families: transportFamilies },
	{ name: 'ws_connections', value: 2, labels: {} }
] });
const transportContext = { expected: 1, metricSources: ['http', 'websocket'] };

it('keeps native requirements complete while an explicit transport inventory selects only measured sources', () => {
	expect(NATIVE_METRIC_PROFILE.signals).toEqual(SIGNALS);
	const profile = createMetricProfile({ sources: ['http', 'websocket'] });
	expect(profile.requiredWorkerSignals.map(signal => signal.name)).toEqual(transportFamilies);
	for (const signal of profile.signals) expect(signal).toBe(SIGNALS_BY_NAME.get(signal.name));
	expect(profile.droppedFrameCoverage).toBe('unavailable');
	expect(Object.isFrozen(profile.sources)).toBe(true);
	expect(Object.isFrozen(METRIC_SOURCE_GROUPS.relay)).toBe(true);
});

it('omits unsupported measurements without inventing zero or marking an otherwise complete profile incomplete', () => {
	const report = transportReport();
	report.samples.push({ name: 'relay_gap_frames_total', value: 999, labels: {} });
	const text = mergeSamples([report], transportContext);
	expect(text).toContain('metrics_snapshot_workers_reporting 1\n');
	expect(text).toContain('# TYPE http_requests_total counter\n');
	expect(text).toContain('ws_connections 2\n');
	for (const absent of ['relay_gap_frames_total', 'state_divergence_total', 'waiting_room_queue_depth', 'protection_posture_state', 'upgrade_inflight', 'upgrade_deferred_depth', 'ws_message_admission_rejected_total', 'ws_dropped_frames_total']) {
		expect(text).not.toContain(absent);
	}
	expect(mergeSamples([report], { expected: 1 })).toContain('metrics_snapshot_workers_reporting 0\n');
});

it('keeps a declared source incomplete when its real gauge or factory is missing', () => {
	const missingGauge = transportReport();
	missingGauge.samples.pop();
	expect(mergeSamples([missingGauge], transportContext)).toContain('metrics_snapshot_workers_reporting 0\n');
	const missingFactory = transportReport();
	missingFactory.samples[0] = { name: METRIC_REGISTRATIONS_SAMPLE, families: ['ws_connections', 'ws_messages_total'] };
	expect(mergeSamples([missingFactory], transportContext)).toContain('metrics_snapshot_workers_reporting 0\n');
	expect(mergeSamples([transportReport()], { ...transportContext, expected: 2 })).toContain('metrics_snapshot_workers_reporting 1\n');
});

it('declares direct-send drop coverage without implying publish recipient measurements', () => {
	const sources = ['http', 'websocket', 'drops'];
	expect(() => createMetricProfile({ sources })).toThrow('explicit');
	const report = transportReport();
	report.samples[0] = { name: METRIC_REGISTRATIONS_SAMPLE, families: [...transportFamilies, 'ws_dropped_frames_total', 'ws_dropped_bytes_total'] };
	const empty = mergeSamples([report], { expected: 1, metricSources: sources, droppedFrameCoverage: 'direct-sends' });
	expect(empty).toContain('ws_dropped_frames_total 0\n');
	report.samples.push({ name: 'ws_dropped_frames_total', value: 3, labels: {} }, { name: 'ws_dropped_bytes_total', value: 240, labels: {} });
	const text = mergeSamples([report], { expected: 1, metricSources: sources, droppedFrameCoverage: 'direct-sends' });
	expect(text).toContain('# ws_dropped_coverage direct-sends\n');
	expect(text).toContain('ws_dropped_frames_total 3\n');
	expect(text).toContain('ws_dropped_bytes_total 240\n');
	expect(text).toContain('metrics_snapshot_workers_reporting 1\n');
});

it.each([{ sources: ['unknown'] }, { sources: ['http', 'http'] }, { sources: [new String('http')] }, { sources: ['http\ninjected'] }])('rejects an invalid source inventory %j', ({ sources }) => {
	expect(() => createMetricProfile({ sources })).toThrow();
});
it('refuses drop coverage without a measurement source', () => {
	expect(() => createMetricProfile({ sources: ['http'], droppedFrameCoverage: 'direct-sends' })).toThrow('requires');
});

it('refuses a coverage override without an explicit source inventory', () => {
	expect(() => mergeSamples([transportReport()], { expected: 1, droppedFrameCoverage: 'direct-sends' })).toThrow('explicit');
});
