// Admission control, proved against a real server rather than against the
// counters in isolation.
//
// The unit tests hold the controller to its contract, but the controller is
// not the risky part - the WIRING is. A connection permit is taken in the
// handshake and released in the close callback, which are two different files
// and two different moments, and the failure modes are silent in both
// directions: a permit that is never released ratchets the ceiling down to
// zero over the life of the process, and one released twice throws inside
// close. Neither shows up in a unit test of the counters.
//
// Runs against the fixture's WS_ADMISSION build (build-admission), whose
// ceiling is TWO. The default is unlimited, so a bound this low is the only
// way a test can actually reach it.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8805;
const BUILD = buildPath('build-admission');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/** Open a socket and resolve once it is actually open, or reject on refusal. */
function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error('socket never opened')), 5_000);
		ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
		ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('refused')); });
	});
}

/** Close a socket and resolve once the server has actually seen it go. */
function closeAndSettle(ws) {
	return new Promise((resolve) => {
		ws.addEventListener('close', () => resolve());
		ws.close();
	});
}

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

/** @type {WebSocket[]} */
const open = [];
try {
	await waitForServer(proc, PORT);

	// The ceiling is two, so two must be admitted.
	for (let i = 0; i < 2; i++) {
		open.push(await connect());
	}
	check('the ceiling admits up to its bound', open.length === 2);

	// A plain fetch rather than a WebSocket, so the STATUS is observable: a
	// refused upgrade surfaces to a WS client as an opaque error event, and
	// this lane's claim is specifically that a crossed ceiling answers 503 with
	// retry-after rather than hanging up or accepting a socket it cannot serve.
	const shed = await fetch(`${BASE}/ws`, {
		headers: { upgrade: 'websocket', connection: 'Upgrade' }
	});
	check('a crossed ceiling answers 503', shed.status === 503, `got ${shed.status}`);
	// Two, matching svelte-adapter-uws. A client that backs off half as long
	// against one adapter as the other is a difference an operator only finds
	// under load, which is the worst time to find one.
	check('and says how long to wait, as uws says it', shed.headers.get('retry-after') === '2', `got ${shed.headers.get('retry-after')}`);

	// THE PART THAT MATTERS. A permit is held for the socket's whole life, so
	// the ceiling only recovers if `close` actually gives one back. If the
	// release is missing this passes the two checks above and then fails here -
	// which is the regression worth catching, because a leaked permit is
	// invisible until the server has quietly stopped accepting connections.
	await closeAndSettle(open.pop());
	// The close callback runs on the server's own turn; give it one.
	await Bun.sleep(150);

	let readmitted = null;
	try { readmitted = await connect(); } catch { /* left null, checked below */ }
	check('closing a connection returns its permit', readmitted !== null);
	if (readmitted) open.push(readmitted);

	// And the ceiling is still a ceiling afterwards, rather than having been
	// released into a permanently open gate by the round trip above.
	const shedAgain = await fetch(`${BASE}/ws`, {
		headers: { upgrade: 'websocket', connection: 'Upgrade' }
	});
	check('the ceiling still holds after a release', shedAgain.status === 503, `got ${shedAgain.status}`);

	// A refused upgrade must not consume a permit of its own. Several refusals
	// in a row would otherwise walk the ceiling down, so the gate that sheds a
	// storm would be the thing that made it permanent.
	for (let i = 0; i < 5; i++) {
		await fetch(`${BASE}/ws`, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
	}
	await closeAndSettle(open.pop());
	await Bun.sleep(150);
	let afterStorm = null;
	try { afterStorm = await connect(); } catch { /* left null */ }
	check('refusals do not themselves consume permits', afterStorm !== null);
	if (afterStorm) open.push(afterStorm);

	// The HTTP surface is untouched by any of this.
	const ssr = await fetch(`${BASE}/`);
	check('SSR still renders under a crossed ceiling', ssr.status === 200, `got ${ssr.status}`);
} finally {
	for (const ws of open) { try { ws.close(); } catch { /* already gone */ } }
	try { proc.kill(); } catch { /* already gone */ }
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  ' + f).join('\n'));
	process.exit(1);
}
