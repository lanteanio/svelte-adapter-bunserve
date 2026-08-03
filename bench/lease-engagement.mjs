// Flow-control engagement proof against the REAL built server: a slow
// consumer opts into the lease capability, paces its sends the way the
// family client does (a local window, one request-n per low-water window),
// and the trace shows LEASE/REQUEST_N actually engaging on Bun - lease-ok,
// sized grants, re-grants on replenish, and the client-side queue draining
// on each new window. No estimates: every number below is a frame that
// crossed a real socket.
//
// Precondition: the live fixture is built (`npm run test:live` builds it).
// Run under Bun: bun bench/lease-engagement.mjs [sends] [windowLowWater]

import { assertPortFree, buildPath, serverEnv, waitForServer } from '../test/live/harness.mjs';

const PORT = 8891;
const SENDS = parseInt(process.argv[2] || '2000');
const LOW_WATER = parseInt(process.argv[3] || '64');

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

	// The client-side mirror of the window, the family client's pacing rules:
	// consume a permit per send, queue past the window, one request-n per
	// window once available drops to the low-water mark, drain on re-grant.
	let available = 0;
	let granted = 0;
	let replenishSent = false;
	const queue = [];
	const trace = { leaseOk: 0, grants: [], requestN: 0, queuedPeak: 0, sent: 0, acks: 0 };

	function pump() {
		while (available > 0 && queue.length > 0) {
			ws.send(queue.shift());
			available--;
			trace.sent++;
		}
		// Replenish only while there is pending work: once per window, when
		// the window is low or already spent. An idle client sends nothing.
		if (!replenishSent && granted > 0 && queue.length > 0 && available <= LOW_WATER) {
			ws.send('{"type":"request-n","n":256}');
			trace.requestN++;
			replenishSent = true;
		}
	}

	ws.onmessage = (e) => {
		let msg;
		try { msg = JSON.parse(e.data); } catch { return; }
		if (msg.type === 'lease-ok') trace.leaseOk++;
		else if (msg.type === 'lease') {
			trace.grants.push({ count: msg.count, ttlMs: msg.ttlMs });
			available = msg.count;
			granted = msg.count;
			replenishSent = false;
			pump();
		} else if (msg.type === 'subscribed') trace.acks++;
	};

	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error('ws connect failed'));
	});
	ws.send('{"type":"hello","caps":["lease"]}');
	ws.send('{"type":"subscribe","topic":"bench","ref":"bench"}');

	// Wait for the arm, then offer a burst far past one window so pacing
	// has to engage: everything runs through the local gate.
	await new Promise((r) => setTimeout(r, 300));
	const payload = JSON.stringify({ topic: 'bench', event: 'noop', data: { x: 1 } });
	for (let i = 0; i < SENDS; i++) {
		queue.push(payload);
		if (queue.length > trace.queuedPeak) trace.queuedPeak = queue.length;
	}
	pump();

	// Drain: keep replenishing until the queue empties or a deadline passes.
	const deadline = Date.now() + 30_000;
	while (queue.length > 0 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
		pump();
	}

	console.log('\n  lease engagement against the real server:');
	console.log(`  lease-ok frames:   ${trace.leaseOk} (exactly one expected)`);
	console.log(`  grants received:   ${trace.grants.length}  windows: ${JSON.stringify(trace.grants.slice(0, 5))}${trace.grants.length > 5 ? ' ...' : ''}`);
	console.log(`  request-n sent:    ${trace.requestN}`);
	console.log(`  offered sends:     ${SENDS}  paced through the gate: ${trace.sent}  peak queued: ${trace.queuedPeak}`);
	console.log(`  undelivered at deadline: ${queue.length}`);
	const engaged = trace.leaseOk === 1 && trace.grants.length >= 2 && trace.requestN >= 1 && queue.length === 0;
	console.log(`  VERDICT: flow control ${engaged ? 'ENGAGED' : 'DID NOT ENGAGE'}\n`);
	ws.close();
	if (!engaged) process.exit(1);
} finally {
	proc.kill();
}
