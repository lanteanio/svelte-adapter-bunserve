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

import { connect as tcpConnect } from 'node:net';

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

/**
 * Start a handshake over a raw socket and leave it in flight, so this suite can
 * hang up at a moment of its choosing. A WebSocket client cannot express that:
 * it either completes the handshake or errors, and the window this needs is the
 * one in between, while the app's upgrade hook is still awaiting.
 *
 * @param {string} query
 */
function beginHandshake(query) {
	const sock = tcpConnect(PORT, '127.0.0.1', () => {
		sock.write(
			`GET /ws${query} HTTP/1.1\r\n` +
			`Host: 127.0.0.1:${PORT}\r\n` +
			'Upgrade: websocket\r\n' +
			'Connection: Upgrade\r\n' +
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
			'Sec-WebSocket-Version: 13\r\n' +
			'\r\n'
		);
	});
	// The point of these sockets is to be destroyed mid-handshake; the resulting
	// reset is the test, not a failure.
	sock.on('error', () => {});
	return sock;
}

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

// Collected as it arrives rather than read at the end: the checks below assert
// that a shed upgrade SAYS SO, and the stream ends when the process does.
let serverErr = '';
const errCollected = (async () => {
	const decoder = new TextDecoder();
	for await (const chunk of proc.stderr) serverErr += decoder.decode(chunk, { stream: true });
})().catch(() => { /* the pipe closing with the process is the normal ending */ });

/** @type {WebSocket[]} */
const open = [];
try {
	await waitForServer(proc, PORT);

	// THE HANG-UP WINDOW, first, while the gate is still empty.
	//
	// Two handshakes held inside the app's upgrade hook hold both permits. The
	// clients then leave without waiting for an answer, and the hook is still
	// awaiting when they do - which is the window where a permit used to stay
	// spent. Bounded by hook latency rather than permanent, which is exactly why
	// no test caught it: everything here reads correct again the moment the hook
	// returns, so a suite that waits for the handshake to finish sees nothing.
	const abandoned = [beginHandshake('?hold=1000'), beginHandshake('?hold=1000')];
	await Bun.sleep(250);
	const whileHeld = await fetch(`${BASE}/ws`, {
		headers: { upgrade: 'websocket', connection: 'Upgrade' }
	});
	check(
		'two handshakes inside the hook hold the whole ceiling',
		whileHeld.status === 503,
		`got ${whileHeld.status}`
	);

	for (const sock of abandoned) sock.destroy();
	// The runtime reports the hang-up on its own turn, within tens of
	// milliseconds of the socket going (probe/bun-api-facts.report.md,
	// upgrade-abort); this is that with room to spare.
	await Bun.sleep(250);
	let afterHangup = null;
	try { afterHangup = await connect(); } catch { /* left null, checked below */ }
	check('a client that hangs up mid-hook gives its permit back', afterHangup !== null);
	if (afterHangup) await closeAndSettle(afterHangup);

	// Let the abandoned hooks run out before anything else is measured, so their
	// unwinding cannot land in the middle of a later check. They resolve into a
	// handshake whose client is long gone, which must produce no socket and
	// release nothing a second time - the checks below would report either.
	await Bun.sleep(900);

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
	// A RANGE, not a value, because the expression is uws's and the range is
	// what the two adapters have to agree on. The spread does not actually
	// widen it today: `base + floor(rand * base * 0.5)` at base 2 is
	// `floor(rand * 1)`, zero for every draw, so both adapters answer exactly 2
	// and a refused fleet does return in the same second. Pinning the range
	// rather than the constant is what keeps this passing when uws widens
	// either number, which is the moment the two must move together.
	const retryAfter = Number(shed.headers.get('retry-after'));
	check(
		'and says how long to wait, jittered as uws jitters it',
		retryAfter >= 2 && retryAfter <= 3,
		`got ${shed.headers.get('retry-after')}`
	);

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

await errCollected;

// A shed upgrade that says nothing is the operational trap this adapter already
// names on the origin refusal: the page loads, the socket gets a 503, and the
// server logs nothing - so a ceiling working as configured looks like an outage,
// and the fastest thing that makes it stop is to turn the ceiling off. Asserted
// against the real process's stderr, because a counter nobody can reach is not
// observability.
check(
	'a shed upgrade says so on the server',
	serverErr.includes('[ws] shed a WebSocket upgrade'),
	serverErr ? serverErr.slice(0, 300) : '(nothing on stderr)'
);
check(
	'and names the ceiling that refused it, with both sides of the comparison',
	/connection ceiling is full \(2 of 2 reserved or live\)/.test(serverErr),
	serverErr ? serverErr.slice(0, 300) : '(nothing on stderr)'
);
check(
	'and the knob that raises it',
	serverErr.includes('websocket.upgradeAdmission.maxConnections'),
	serverErr ? serverErr.slice(0, 300) : '(nothing on stderr)'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  ' + f).join('\n'));
	process.exit(1);
}
