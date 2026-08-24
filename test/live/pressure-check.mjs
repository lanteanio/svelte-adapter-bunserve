// The pressure surface and the lease lane, END TO END against a real built
// server in a real Bun process. Everything else about them is proven at unit
// cost against the module graph; this is the only place that proves the
// sampler is actually WIRED - started at boot, ticking on its own timer, and
// reporting real process readings through platform.pressure - plus that the
// lease handshake survives a real socket and the control-egress budget.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8807;
const BUILD = buildPath();

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
	if (cond) {
		passed++;
		console.log(`  ok  ${name}`);
	} else {
		failed++;
		failures.push(`${name}${detail ? ' :: ' + detail : ''}`);
		console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
	}
}

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	// The fixture is built with `pressure: { sampleIntervalMs: 200 }`, so this
	// suite watches several real samples without sleeping for seconds AND
	// proves a non-default pressure block survives the whole build round trip.
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);

	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	/** @type {any[]} */
	const pressures = [];
	/** @type {any[]} */
	const lease = [];
	const order = [];
	ws.onmessage = (e) => {
		let msg;
		try { msg = JSON.parse(e.data); } catch { return; }
		if (msg.event === 'pressure') pressures.push(msg.data);
		if (msg.type === 'lease-ok' || msg.type === 'lease') {
			order.push(msg.type);
			if (msg.type === 'lease') lease.push(msg);
		}
	};
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error('ws connect failed'));
	});

	// - The surface exists and reports a real process ------------------------
	// Poll past the first sampler tick: before it, the snapshot is still its
	// initial zeros, which would let every assertion below pass vacuously.
	for (let i = 0; i < 8 && !pressures.some((p) => p.memoryMB > 0); i++) {
		ws.send(JSON.stringify({ type: 'fixture-pressure' }));
		await new Promise((r) => setTimeout(r, 300));
	}
	const first = pressures.find((p) => p.memoryMB > 0);
	check('platform.pressure is readable from an app hook', !!first);
	if (first) {
		check('the sampler ran and reported this process, not zeros',
			first.memoryMB > 1, `memoryMB=${first.memoryMB}`);
		// The reason this adapter ships memoryHeapUsedRatio disabled. The
		// engine keeps heapTotal fitted close to heapUsed, so the ratio idles
		// high on every generation measured - 0.90 to 0.94 on Bun 1.3.14,
		// 0.81 on 1.4.0 - and a threshold like the family's 0.85 either fires
		// permanently or flaps on ordinary churn. If this ever reads genuinely
		// low, the heap accounting changed and the divergence should be
		// revisited rather than kept out of habit.
		check('this engine really does sit with its heap mostly full when idle',
			first.heapRatio > 0.75, `heapRatio=${first.heapRatio}`);
		check('and a healthy idle server therefore reports NO pressure',
			first.active === false && first.reason === 'NONE', `reason=${first.reason}`);
		check('platform.protection reads the zero-config posture',
			first.protection === 'normal', String(first.protection));
		check('onPressure and onPublishRate are bound',
			first.hasOnPressure === true && first.hasOnPublishRate === true);
		check('the backpressure aggregates are live numbers',
			typeof first.maxBufferedBytes === 'number' && typeof first.backpressuredConnections === 'number');
		// On Linux this must actually POPULATE, and populate the right field:
		// the two readings are assigned adjacently, so a swap would put a
		// throttle object into `psi` and nothing else would notice.
		check(process.platform === 'linux'
			? 'PSI readings are populated with the psi shape on Linux'
			: 'kernel readings are null on a host without PSI',
			process.platform === 'linux'
				? (first.psiShape === 'psi' || first.psiNull === true)
				: (first.psiNull === true && first.cpuThrottleNull === true),
			`psiNull=${first.psiNull} psiShape=${first.psiShape} cpuThrottleNull=${first.cpuThrottleNull}`);
		check('a populated psi reading carries PSI fields, never the throttle shape',
			first.psiShape === null || first.psiShape === 'psi', String(first.psiShape));
		check('a populated cpuThrottle reading carries throttle fields, never the PSI shape',
			first.cpuThrottleShape === null || first.cpuThrottleShape === 'throttle',
			String(first.cpuThrottleShape));
	}

	// - The sampler keeps sampling, and publishes move the rate --------------
	ws.send(JSON.stringify({ type: 'subscribe', topic: 'pressure-lane', ref: 'p1' }));
	await new Promise((r) => setTimeout(r, 100));
	for (let i = 0; i < 40; i++) {
		ws.send(JSON.stringify({ type: 'fixture-publish', topic: 'pressure-lane', event: 'tick', data: { i } }));
	}
	// The rate lives for exactly ONE window - the next tick drains it - so
	// poll several times per window rather than betting on landing inside the
	// right one. The fixture samples every 200ms, so 60ms polls see each
	// window roughly three times.
	const before = pressures.length;
	for (let i = 0; i < 25; i++) {
		await new Promise((r) => setTimeout(r, 60));
		ws.send(JSON.stringify({ type: 'fixture-pressure' }));
	}
	await new Promise((r) => setTimeout(r, 300));
	const after = pressures.slice(before);
	check('samples kept arriving, so the timer is still ticking', after.length >= 2,
		`samples=${after.length}`);
	check('the publish burst was measured as a per-second rate',
		after.some((p) => p.publishRate > 0),
		`rates=${JSON.stringify(after.map((p) => p.publishRate))}`);
	check('the burst topic surfaced in topPublishers',
		after.some((p) => p.topPublishers.some((t) => t.topic === 'pressure-lane' && t.messagesPerSec > 0)),
		JSON.stringify(after.map((p) => p.topPublishers.length)));
	// Publishing stopped long before the last poll, so the final windows must
	// read zero: a rate that keeps reporting is a window that never drained.
	await new Promise((r) => setTimeout(r, 600));
	ws.send(JSON.stringify({ type: 'fixture-pressure' }));
	await new Promise((r) => setTimeout(r, 300));
	check('the window is drained again afterwards, not left compounding',
		pressures[pressures.length - 1].publishRate === 0,
		`last=${pressures[pressures.length - 1].publishRate}`);
	check('the subscription registered in the subscriber ratio',
		after.some((p) => p.subscriberRatio > 0),
		`ratios=${JSON.stringify(after.map((p) => p.subscriberRatio))}`);

	// - The lease lane over a real socket ------------------------------------
	ws.send(JSON.stringify({ type: 'hello', caps: ['lease'] }));
	await new Promise((r) => setTimeout(r, 200));
	ws.send(JSON.stringify({ type: 'hello', caps: ['lease'] }));
	ws.send(JSON.stringify({ type: 'request-n', n: 9 }));
	await new Promise((r) => setTimeout(r, 300));
	check('the first hello is answered with lease-ok then a window, in that order',
		order[0] === 'lease-ok' && order[1] === 'lease', order.join(','));
	check('a re-sent hello repeats neither the ack nor a window',
		order.filter((t) => t === 'lease-ok').length === 1, order.join(','));
	check('request-n re-grants exactly one window',
		lease.length === 2, `grants=${lease.length}`);
	check('every granted window is sized and carries the fixed ttl',
		lease.every((g) => Number.isInteger(g.count) && g.count >= 8 && g.count <= 256 && g.ttlMs === 10000),
		JSON.stringify(lease));
	// One connection with one subscription is nowhere near the fan-out knee,
	// so a healthy server must hand out the FULL window. This is what the
	// engine's idle heap ratio silently broke before grantSizeFor stopped
	// feeding it into the sizing math.
	check('an unloaded server grants the full base window, not a collapsed one',
		lease.every((g) => g.count === 256), JSON.stringify(lease.map((g) => g.count)));

	ws.close();
} catch (err) {
	failed++;
	failures.push(`harness: ${err.message}`);
	console.log(`FAIL  harness :: ${err.message}`);
} finally {
	proc.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
