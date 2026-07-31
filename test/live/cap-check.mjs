// Live regression test for the per-connection subscription cap.
//
// The cap has to hold against pipelining. A limit read before the app's
// authorization gate and never re-checked after it is not a bound: an async
// gate lets a client pipeline subscribe frames that ALL pass the check at the
// pre-await size and ALL install - 500 installed against a cap of 20.
//
// This asserts the bound holds on the path that broke it, which requires a
// genuinely async hook - microtask-only awaits still serialize under Bun, so a
// synchronous fixture gate cannot reach the defect. The fixture's `subscribe`
// awaits 40ms for `slow:` topics and the fixture build sets the cap to 20.
//
// Run the whole live lane with: npm run test:live

import { fileURLToPath } from 'node:url';

const PORT = 8805;
const BUILD = fileURLToPath(new URL('../fixture/build/index.js', import.meta.url));
const CAP = 20;
const BLAST = 500;

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

const proc = Bun.spawn([process.execPath, BUILD], {
	env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
	stdout: 'pipe',
	stderr: 'pipe'
});

async function waitForServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (res.ok) return true;
		} catch {}
		await Bun.sleep(100);
	}
	return false;
}

try {
	if (!(await waitForServer())) throw new Error('server never came up');

	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	const acks = { subscribed: 0, denied: 0, rateLimited: 0 };
	ws.onmessage = (e) => {
		let msg;
		try { msg = JSON.parse(e.data); } catch { return; }
		if (msg.type === 'subscribed') acks.subscribed++;
		else if (msg.type === 'subscribe-denied') {
			acks.denied++;
			if (msg.reason === 'RATE_LIMITED') acks.rateLimited++;
		}
	};
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error('ws error'));
	});

	// Pipeline the whole blast without awaiting anything: every frame lands in
	// Bun's message handler before the first gate resolves. This is the exact
	// shape that defeated the old check.
	for (let i = 0; i < BLAST; i++) {
		ws.send(JSON.stringify({ type: 'subscribe', topic: `slow:room${i}`, ref: i }));
	}

	// Long enough for all 500 gates (40ms each, concurrent) to settle.
	await Bun.sleep(3000);

	const answered = acks.subscribed + acks.denied;
	check(
		`every one of the ${BLAST} pipelined subscribes is answered`,
		answered === BLAST,
		`subscribed=${acks.subscribed} denied=${acks.denied} total=${answered}`
	);
	check(
		`installed subscriptions never exceed the cap of ${CAP}`,
		acks.subscribed <= CAP,
		`installed ${acks.subscribed}, cap ${CAP}`
	);
	check(
		'the overflow is refused as RATE_LIMITED, not silently dropped',
		acks.rateLimited === BLAST - acks.subscribed,
		`rateLimited=${acks.rateLimited} expected=${BLAST - acks.subscribed}`
	);

	// The cap must not be a one-way latch: releasing subscriptions has to give
	// the headroom back, or a long-lived connection degrades permanently.
	for (let i = 0; i < acks.subscribed; i++) {
		ws.send(JSON.stringify({ type: 'unsubscribe', topic: `slow:room${i}` }));
	}
	await Bun.sleep(300);
	const before = acks.subscribed;
	ws.send(JSON.stringify({ type: 'subscribe', topic: 'slow:after-release', ref: 'r' }));
	await Bun.sleep(500);
	check(
		'headroom returns once subscriptions are released',
		acks.subscribed === before + 1,
		`installed went ${before} -> ${acks.subscribed}`
	);

	ws.close();
	await Bun.sleep(200);
} catch (err) {
	failed++;
	failures.push(`harness: ${err.message}`);
	console.log(`FAIL  harness :: ${err.message}`);
} finally {
	proc.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
	console.log('failures:');
	for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
