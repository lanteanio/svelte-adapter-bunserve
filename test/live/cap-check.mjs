// Live regression for the shared 4096 pending-subscribe attempt bound.
// A fixture barrier holds every admitted hook until an ordered application
// message releases it. The bound therefore does not depend on machine speed.
// The separate 65536 landed cap is covered by subscribe-gate.test.mjs.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8805;
const BUILD = buildPath();
// Literal contract value: a compiled runtime must not agree with its own typo.
const CAP = 4096;
const BLAST = CAP + 1;

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
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});



try {
	await waitForServer(proc, PORT);

	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	const acks = { subscribed: 0, denied: 0, rateLimited: 0 };
	const installed = [];
	const released = [];
	ws.onmessage = (e) => {
		let msg;
		try { msg = JSON.parse(e.data); } catch { return; }
		if (msg.event === 'subscribe-gates-released') released.push(msg.data.count);
		if (msg.type === 'subscribed') {
			acks.subscribed++;
			if (typeof msg.topic === 'string') installed.push(msg.topic);
		}
		else if (msg.type === 'subscribe-denied') {
			acks.denied++;
			if (msg.reason === 'RATE_LIMITED') acks.rateLimited++;
		}
	};
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error('ws error'));
	});

	async function until(predicate, label) {
		const deadline = Date.now() + 15000;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
			await Bun.sleep(10);
		}
	}
	for (let i = 0; i < BLAST; i++) {
		ws.send(JSON.stringify({ type: 'subscribe', topic: `held:room${i}`, ref: i }));
	}
	await until(() => acks.denied > 0, 'pending overflow reply');
	check('overflow is refused before the held hooks are released',
		acks.subscribed === 0 && acks.denied === 1 && acks.rateLimited === 1,
		JSON.stringify(acks));
	ws.send(JSON.stringify({ type: 'fixture-release-subscribes' }));
	await until(() => acks.subscribed + acks.denied === BLAST, 'all pending replies');
	check(`exactly ${CAP} concurrent attempts reach the application hook`,
		released.length === 1 && released[0] === CAP, JSON.stringify(released));
	check(`exactly ${CAP} held attempts install after authorization`,
		acks.subscribed === CAP && acks.denied === 1, JSON.stringify(acks));
	check('every installed topic is unique and within the admitted prefix',
		new Set(installed).size === CAP && installed.every(topic => /^held:room\d+$/.test(topic) && Number(topic.slice(9)) < CAP));

	// Pending capacity returns when authorization settles, even while all
	// existing memberships remain landed on the connection.
	ws.send(JSON.stringify({ type: 'subscribe', topic: 'held:after-settlement', ref: 'next' }));
	ws.send(JSON.stringify({ type: 'fixture-release-subscribes' }));
	await until(() => acks.subscribed === CAP + 1, 'returned pending capacity');
	check('settled attempts return pending capacity without unsubscribing',
		released.length === 2 && released[1] === 1 && acks.denied === 1,
		JSON.stringify({ released, acks }));

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
