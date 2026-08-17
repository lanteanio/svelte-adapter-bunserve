// `websocket.upgradeRateLimit`, proved against a real server.
//
// The unit lane drives this through the real dispatch, but over an in-memory
// transport whose client addresses are the double's invention. What only a real
// server can answer is whether the adapter reads a real client address at all:
// the key comes from `server.requestIP(request)`, and a resolver that returned
// null, or the listener's own address, would meter every client as one and
// still pass every unit test.
//
// Runs against the fixture's WS_RATE_LIMIT build (build-rate-limit): three
// upgrades per ten seconds. The main build has the limiter OFF, because every
// other suite - and the leak lane at 50 rps - drives it from this same address.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8808;
const BUILD = buildPath('build-rate-limit');
const BASE = `http://127.0.0.1:${PORT}`;
const LIMIT = 3;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/**
 * Open a real socket, and resolve with whether it got through.
 *
 * The admitted handshakes have to be driven by a real client rather than by
 * `fetch`: a successful upgrade hijacks the connection, so `fetch` is left
 * holding one that never produces an HTTP response and reports it as a
 * connection failure. Only the REFUSALS are ordinary HTTP, which is why the
 * two halves of this suite use different instruments.
 */
function openSocket() {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => resolve({ ok: false, ws: null }), 5_000);
		ws.addEventListener('open', () => { clearTimeout(timer); resolve({ ok: true, ws }); });
		ws.addEventListener('error', () => { clearTimeout(timer); resolve({ ok: false, ws: null }); });
	});
}

/** Ask for an upgrade over plain HTTP, so the refusal's status line is readable. */
async function requestUpgrade() {
	const res = await fetch(`${BASE}/ws`, {
		headers: {
			upgrade: 'websocket',
			connection: 'Upgrade',
			'sec-websocket-version': '13',
			'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
			origin: BASE
		}
	});
	const body = await res.text();
	return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), ORIGIN: BASE }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);

	// The allowance: real connections, each one spending a slot.
	const opened = [];
	for (let i = 0; i < LIMIT; i++) opened.push(await openSocket());
	check(`the first ${LIMIT} handshakes are admitted`,
		opened.every((o) => o.ok),
		JSON.stringify(opened.map((o) => o.ok)));

	// Past it, every further handshake is refused - and a refusal IS an ordinary
	// HTTP response, so its status line can be read directly.
	const refused = [await requestUpgrade(), await requestUpgrade()];
	check('everything past the limit is 429',
		refused.every((r) => r.status === 429),
		JSON.stringify(refused.map((r) => r.status)));
	check('the refusal says how long to wait', refused[0].retryAfter === '10',
		String(refused[0].retryAfter));
	check('and says what happened', refused[0].body.includes('Too many'),
		JSON.stringify(refused[0].body.slice(0, 50)));

	for (const o of opened) if (o.ws) o.ws.close();

	// SSR is not metered: the limit is on the upgrade door, not on requests.
	const page = await fetch(`${BASE}/`);
	check('ordinary requests are not metered', page.status === 200, `got ${page.status}`);

} finally {
	proc.kill();
	await proc.exited;
}

// The operator-facing half, read after the server is down rather than streamed
// alongside it: a live reader on a stream that mostly stays silent is one more
// thing that can hang a suite, and nothing here needs the warning before the
// end. This suite connects over loopback with no ADDRESS_HEADER set, which is
// exactly the shape that means "every client may be sharing one bucket" - so
// the advisory must fire here, or it would never fire where it is needed.
const stderr = await new Response(proc.stderr).text();
check('a loopback-keyed refusal warns that the limit may be global',
	/refused a WebSocket upgrade \(429\), and the client address is loopback/.test(stderr),
	JSON.stringify(stderr.slice(-400)));
check('and names the way out',
	/ADDRESS_HEADER/.test(stderr) && /upgradeRateLimit: 0/.test(stderr));
// Once for this door, not once per refusal: it describes the deployment, and
// two refusals happened above.
check('once, not once per refusal',
	(stderr.match(/and the client address is loopback/g) || []).length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}
