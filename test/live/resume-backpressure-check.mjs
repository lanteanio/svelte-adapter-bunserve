// The resume flush against a socket it cannot talk to, end to end.
//
// When a gap-fill frame is refused past the backpressure limit the lane sends
// a `__replay:<topic>` truncated marker, and when the socket refuses THAT too
// - which is the likely outcome, since a refusal means the socket is already
// full - the connection is closed instead of acked. Everything about that
// branch is decided by a real socket's send() return values, so the unit lane
// can only script it: it hands the flush a fake socket that answers "refused"
// on demand. This suite makes a real one refuse.
//
// WHAT IT ASSERTS is the guarantee a client can build on, which is not the
// close code. The close is asked for with 1013, but a socket saturated enough
// to refuse the marker is torn down before the close frame gets out and the
// client sees 1006 (measured on both generations, probe/bun-api-facts.report.md
// under close-under-backpressure). What must hold is that the client is never
// told it is caught up: no `subscribed` ack for the topic, and a connection
// that ends. A client that got the ack would go live over a hole in its
// history with nothing to make it notice, which is the whole defect the branch
// exists to prevent.
//
// Needs its own build: the default backpressure limit is a megabyte, and the
// flush can only be made to refuse by filling it (see WS_BACKPRESSURE in
// test/fixture/svelte.config.js).

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8816;
const BUILD = buildPath('build-backpressure');
const TOPIC = 'bp:resume';

// 24 frames of a quarter megabyte each against a 64 KiB limit. The margin is
// deliberate: the flush has to cross the limit and STAY over it while the
// marker and its retry are attempted, on a client that is draining the whole
// time.
const PAD_BYTES = 256 * 1024;
const FRAMES = 24;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

/** Wait (bounded) until the predicate holds, or throw naming what was awaited. */
async function until(fn, what) {
	if (await settles(fn)) return true;
	throw new Error(`timed out waiting for ${what}`);
}

/** Wait (bounded) until the predicate holds, and REPORT whether it did. */
async function settles(fn) {
	for (let i = 0; i < 200; i++) {
		if (fn()) return true;
		await Bun.sleep(50);
	}
	return false;
}

try {
	await waitForServer(proc, PORT);

	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?user=bp`);
	const texts = [];
	/** @type {{ code: number, reason: string } | null} */
	let closed = null;
	ws.onmessage = (e) => {
		if (typeof e.data !== 'string') return;
		try { texts.push(JSON.parse(e.data)); } catch { /* not JSON, not under test */ }
	};
	ws.onclose = (e) => { closed = { code: e.code, reason: e.reason }; };
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error('client failed to connect'));
	});
	const send = (obj) => ws.send(JSON.stringify(obj));

	// report 0, so every scripted seq is ABOVE the watermark and reaches the
	// client through the FLUSH rather than through the hook. The hook's own
	// sends are not the path under test - they are not checked for delivery.
	send({
		type: 'fixture-resume-script',
		topic: TOPIC,
		report: 0,
		publish: Array.from({ length: FRAMES }, (_, i) => i + 1),
		pad: PAD_BYTES
	});
	await until(() => texts.some((t) => t.event === 'resume-scripted'), 'resume script armed');

	send({ type: 'subscribe', topic: TOPIC, ref: 1, recover: { offset: 0 } });

	// The socket ends or the ack arrives; both are answers, and waiting for
	// only one of them would hang on the failure this exists to catch.
	// Bounded, and NOT thrown on: a window that is answered by neither an ack
	// nor a close is the outcome worth naming as its own failure. Removing the
	// close leaves exactly that - a client parked on a subscribe forever,
	// because the ack cannot reach a socket in this state either - and a thrown
	// timeout would report it as harness trouble rather than as the defect.
	const answered = await settles(
		() => closed !== null || texts.some((t) => t.type === 'subscribed' && t.topic === TOPIC)
	);
	check('the resume window is answered at all', answered,
		'neither an ack nor a close arrived');
	// Everything in flight has landed by now, so a late ack cannot slip in
	// after the assertions below have read the transcript.
	await Bun.sleep(200);

	const ack = texts.find((t) => t.type === 'subscribed' && t.topic === TOPIC);
	check('the client is never told it is caught up', ack === undefined, JSON.stringify(ack));
	check('the connection ends instead', closed !== null, 'still open');
	check('and no `resumed` ack either', !texts.some((t) => t.type === 'resumed'),
		JSON.stringify(texts.find((t) => t.type === 'resumed')));

	// Recorded, not asserted: which code arrives depends on whether the close
	// frame can still get out of a socket in this state, and that is the
	// platform's call rather than this adapter's. The line is here so a run
	// that behaves differently says so in the log.
	if (closed) console.log(`      (close observed: code ${closed.code} ${JSON.stringify(closed.reason)})`);

	// The flush must have got far enough to be refused rather than dying on
	// something else: the client should have received SOME of the gap-fill.
	const delivered = texts.filter((t) => t.event === 'said' && t.data?.inWindow !== undefined).length;
	check('the flush delivered part of the window before it was refused',
		delivered > 0 && delivered < FRAMES, `delivered ${delivered} of ${FRAMES}`);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	proc.kill();
	if (failed > 0) {
		console.log('\n--- stderr ---\n' + (await new Response(proc.stderr).text()).slice(-1500));
	}
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log('failures:\n  - ' + failures.join('\n  - '));
	process.exit(1);
}
