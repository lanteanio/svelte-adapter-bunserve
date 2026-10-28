// Real HTTP snapshots contain adapter metrics; the shared registry also carries app instruments.

import { createMetricProfile } from '../../src/observability.js';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8811;
const BUILD = buildPath('build');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/** The value of one rendered series, as a number. */
function series(text, prefix) {
	const line = text.split('\n').find((l) => l.startsWith(prefix + ' ') || l.startsWith(prefix + '{'));
	return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

function openSocket() {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => resolve(null), 5_000);
		ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
		ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
	});
}

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), ORIGIN: BASE }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);

	const first = await fetch(`${BASE}/metrics`);
	check('the scrape route answers', first.status === 200, `got ${first.status}`);
	check('the route and runtime share one configured registry', first.headers.get('x-fixture-metrics-shared') === 'true');
	check('with the exposition content type',
		(first.headers.get('content-type') || '').startsWith('text/plain'),
		String(first.headers.get('content-type')));
	const before = await first.text();

	check('the document declares its families', /^# TYPE upgrade_admitted_total counter$/m.test(before));
	check('and carries its own completeness', series(before, 'metrics_snapshot_degraded') === 0,
		String(series(before, 'metrics_snapshot_degraded')));

 const expectedProfile = createMetricProfile({ sources: [
  'http', 'upgrade', 'upgrade-rate-limit', 'upgrade-admission', 'upgrade-pacing',
  'websocket', 'subscriptions', 'publish', 'backpressure', 'drops', 'egress',
  'pressure', 'process-memory', 'os-pressure', 'framework-assertions'
 ], droppedFrameCoverage: 'direct-sends' });
 let sampled = before;
 const deadline = Date.now() + 5000;
 while (!/^pressure_sample_timestamp_seconds /m.test(sampled) && Date.now() < deadline) {
  await Bun.sleep(20);
  sampled = await (await fetch(`${BASE}/metrics`)).text();
 }
 check('snapshot declares the exact implemented source inventory', sampled.includes('# metric_sources ' + expectedProfile.sources.join(',') + '\n'));
 check('snapshot declares direct-send-only drop coverage', sampled.includes('# ws_dropped_coverage direct-sends\n'));
 const missing = expectedProfile.requiredWorkerSignals.filter(signal => !sampled.includes(`# TYPE ${signal.name} ${signal.type}\n`));
 check('all supported required families are present after a real sampler tick', missing.length === 0, missing.map(signal => signal.name).join(','));
 check('the sampled worker reports complete', series(sampled, 'metrics_snapshot_workers_expected') === 1 && series(sampled, 'metrics_snapshot_workers_reporting') === 1);
 check('unsupported relay, audit and waiting-room sources stay absent', !/relay_gap_frames_total|state_divergence_total|waiting_room_queue_depth/.test(sampled));
	// Every refusal reason is a series from the first scrape, so a dashboard
	// shows a flat zero rather than a gap that reads like a missing exporter.
	check('every refusal reason is present from the first scrape',
		before.split('\n').filter((l) => l.startsWith('upgrade_rejected_total{')).length === 12,
		String(before.split('\n').filter((l) => l.startsWith('upgrade_rejected_total{')).length));

	// Open real sockets, then scrape again: the counters have to have moved,
	// which is what proves the projection reads live runtime state rather than a
	// snapshot taken at boot.
	const sockets = [await openSocket(), await openSocket()];
	check('two sockets opened', sockets.every(Boolean));
	// The gauges are read at scrape time, so no sampler tick is needed for these.
	const during = await (await fetch(`${BASE}/metrics`)).text();
	check('the admitted counter moved',
		series(during, 'upgrade_admitted_total') >= (series(before, 'upgrade_admitted_total') ?? 0) + 2,
		`${series(before, 'upgrade_admitted_total')} -> ${series(during, 'upgrade_admitted_total')}`);
	check('live connections are visible', series(during, 'ws_connections') === 2,
		String(series(during, 'ws_connections')));
 const echoed = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('metrics echo timed out')), 5000);
  const listener = event => {
   const frame = JSON.parse(event.data);
   if (frame.topic === '__client-test' && frame.event === 'echo') {
    clearTimeout(timeout); sockets[0].removeEventListener('message', listener); resolve();
   }
  };
  sockets[0].addEventListener('message', listener);
 });
 sockets[0].send(JSON.stringify({ type: 'fixture-publish', topic: 'metric-empty-room', data: 'measured' }));
 sockets[0].send(JSON.stringify({ type: 'fixture-client-echo', payload: 'measured' }));
 await echoed;
 const traffic = await (await fetch(`${BASE}/metrics`)).text();
 check('real inbound messages move the completed-message counter', series(traffic, 'ws_messages_total{kind="text",outcome="ok"}') >= 2);
 check('real publish calls record aggregate no-subscriber outcomes', series(traffic, 'ws_publish_outcomes_total{outcome="no_subscribers"}') >= 1);
	const appMetricsResponse = await fetch(`${BASE}/metrics?registry`);
	const appMetrics = await appMetricsResponse.text();
	check('the app instrument is available through its own imported registry',
		series(appMetrics, 'fixture_opens_total') === 2,
		String(series(appMetrics, 'fixture_opens_total')));
	check('the adapter snapshot excludes app instruments', !during.includes('fixture_opens_total'));
	check('the shared app registry also contains adapter measurements',
		series(appMetrics, 'upgrade_admitted_total') === series(during, 'upgrade_admitted_total'));

	for (const ws of sockets) if (ws) ws.close();
	await Bun.sleep(200);
	const after = await (await fetch(`${BASE}/metrics`)).text();
	check('the connection gauge came back down', series(after, 'ws_connections') === 0,
		String(series(after, 'ws_connections')));
	check('while the counter did not', series(after, 'upgrade_admitted_total') === series(during, 'upgrade_admitted_total'),
		`${series(during, 'upgrade_admitted_total')} -> ${series(after, 'upgrade_admitted_total')}`);

	// A refusal has to show up under its own reason.
	await fetch(`${BASE}/ws`, {
		headers: {
			upgrade: 'websocket', connection: 'Upgrade',
			'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
			origin: 'https://evil.example'
		}
	});
	const refused = await (await fetch(`${BASE}/metrics`)).text();
	check('a refusal is counted under its reason',
		series(refused, 'upgrade_rejected_total{reason="bad_origin"}') === 1,
		String(series(refused, 'upgrade_rejected_total{reason="bad_origin"}')));

	// Two scrapes of an unchanged server are byte-identical apart from the
	// gauges the sampler moves - so a diff between them is readable at all.
	const a = await (await fetch(`${BASE}/metrics`)).text();
	const b = await (await fetch(`${BASE}/metrics`)).text();
	const families = (text) => text.split('\n').filter((l) => l.startsWith('# TYPE')).join('\n');
	check('the family order is stable across scrapes', families(a) === families(b));

} finally {
	proc.kill();
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}
