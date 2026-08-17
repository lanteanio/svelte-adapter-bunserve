// `websocket.authPathRateLimit`, proved against a real server.
//
// The unit lane drives the same door with a fake server object, so the address
// it meters on is the test's own invention. What only a real server can answer
// is whether the adapter reads a real client address here at all - the key
// comes from `server.requestIP(request)`, and a resolver that returned null, or
// the listener's own address, would meter every client as one and still pass
// every unit test.
//
// The other half is the one a single-door test cannot state: spending this
// budget must not spend the upgrade budget. Both are three per ten seconds in
// this build, so a shared map would refuse the first handshake after three
// preflights - which is exactly what this suite watches for.
//
// Runs against the fixture's WS_RATE_LIMIT build.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8810;
const BUILD = buildPath('build-rate-limit');
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `${BASE}/__ws/auth`;
const LIMIT = 3;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/** The preflight as the family client sends it. */
function preflight() {
	return fetch(AUTH, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' } });
}

/**
 * Open a real socket. The admitted handshakes cannot be driven by `fetch`: a
 * successful upgrade hijacks the connection, so fetch is left holding one that
 * never produces an HTTP response and reports a connection failure.
 */
function openSocket() {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => resolve({ ok: false, ws: null }), 5_000);
		ws.addEventListener('open', () => { clearTimeout(timer); resolve({ ok: true, ws }); });
		ws.addEventListener('error', () => { clearTimeout(timer); resolve({ ok: false, ws: null }); });
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

	const allowed = [];
	for (let i = 0; i < LIMIT; i++) allowed.push((await preflight()).status);
	check(`the first ${LIMIT} preflights are admitted`,
		allowed.every((s) => s === 204), JSON.stringify(allowed));

	const refused = await preflight();
	check('everything past the limit is 429', refused.status === 429, `got ${refused.status}`);
	check('the refusal says how long to wait', refused.headers.get('retry-after') === '10',
		String(refused.headers.get('retry-after')));
	check('and says what happened', (await refused.text()).includes('Too many authentication'),
		'body');

	// The separate-budget property: this address has spent its whole preflight
	// allowance, and its upgrade allowance is untouched.
	const opened = [];
	for (let i = 0; i < LIMIT; i++) opened.push(await openSocket());
	check('the upgrade budget is untouched by preflights',
		opened.every((o) => o.ok), JSON.stringify(opened.map((o) => o.ok)));
	for (const o of opened) if (o.ws) o.ws.close();

	// And now spend the upgrade budget too, so ONE process has refused at both
	// doors. That is what makes the advisory assertions below say something: a
	// single latch for the whole process would leave the second door silent, and
	// the operator chasing its 429s reading the first door's knob.
	const overLimit = await openSocket();
	check('the upgrade door refuses once its own budget is spent',
		!overLimit.ok, JSON.stringify(overLimit.ok));
	if (overLimit.ws) overLimit.ws.close();

	// SSR is not metered by either door.
	const page = await fetch(`${BASE}/`);
	check('ordinary requests are not metered', page.status === 200, `got ${page.status}`);

} finally {
	proc.kill();
	await proc.exited;
}

// Read after the server is down, for the reason the sibling suite gives. This
// suite connects over loopback with no ADDRESS_HEADER, which is the shape that
// means every client may share one bucket - so the advisory must fire here or
// it would never fire where it is needed.
const stderr = await new Response(proc.stderr).text();
check('a loopback-keyed refusal warns that the limit may be global',
	/refused an auth preflight \(429\), and the client address is loopback/.test(stderr),
	JSON.stringify(stderr.slice(-400)));
check('and names this door\'s knob, not the other one\'s',
	/The limit is `websocket\.authPathRateLimit`/.test(stderr) && /ADDRESS_HEADER/.test(stderr));

// BOTH doors refused in this one process, so both must have said so. The
// advisory names a door, the limit it refused at, and the knob that changes it,
// so one message for the process would leave the second door's operator
// changing a knob that governs a different door.
check('the other door in the same process gets its own advisory',
	/refused a WebSocket upgrade \(429\), and the client address is loopback/.test(stderr),
	JSON.stringify(stderr.slice(-400)));
check('and that one names ITS knob',
	/The limit is `websocket\.upgradeRateLimit`/.test(stderr));
check('once per door, not once per refusal',
	(stderr.match(/and the client address is loopback/g) || []).length === 2,
	String((stderr.match(/and the client address is loopback/g) || []).length));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}
