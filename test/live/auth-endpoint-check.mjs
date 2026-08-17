// The auth preflight endpoint, proved against a real server.
//
// The unit lane drives the same entry point with a hand-built Request, which
// covers every branch. What only a real server can answer is whether the
// endpoint is REACHED: it is mounted ahead of the static index and the SSR
// catch-all, and a routing mistake would leave the POST rendering the app shell
// or 404ing while every unit test still passed. The Set-Cookie round trip is
// the other half - the whole reason this endpoint exists is that the same
// header on a 101 is dropped by strict edge proxies, so it has to arrive on an
// ordinary HTTP response.
//
// Runs against the fixture's MAIN build: the handler exports `authenticate`, so
// the endpoint is mounted with its defaults.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8809;
const BUILD = buildPath('build');
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `${BASE}/__ws/auth`;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/** The preflight as the family client sends it. */
function preflight(url = AUTH, headers = {}) {
	return fetch(url, {
		method: 'POST',
		headers: { 'x-requested-with': 'XMLHttpRequest', ...headers }
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

	// The ordinary path: 204, and the refreshed cookie on the response.
	const ok = await preflight();
	check('a preflight is answered 204', ok.status === 204, `got ${ok.status}`);
	const setCookie = ok.headers.getSetCookie();
	check('the refreshed session cookie is on the response',
		setCookie.some((c) => c.startsWith('fixture_session=refreshed')),
		JSON.stringify(setCookie));
	check('and it carries the attributes the hook asked for',
		setCookie.some((c) => /Path=\/;/.test(c) && /Max-Age=600/.test(c) && /HttpOnly/.test(c)),
		JSON.stringify(setCookie));

	// The hook's own inputs, echoed back through a Response it built itself.
	const echoed = await preflight(`${AUTH}?mode=response`);
	check('a Response from the hook is used verbatim', echoed.status === 200, `got ${echoed.status}`);
	const body = await echoed.json();
	check('the hook sees a per-request platform identity',
		typeof body.requestId === 'string' && body.requestId.length > 0,
		JSON.stringify(body));
	// This is the half no unit test can vouch for: the address comes from
	// `server.requestIP(request)`, and a resolver that answered null - or the
	// listener's own address - would still pass every unit test.
	check('and a real client address', body.address === '127.0.0.1', JSON.stringify(body.address));
	check('a cookie set alongside a returned Response still goes out',
		echoed.headers.getSetCookie().some((c) => c.startsWith('fixture_session=from-jar')),
		JSON.stringify(echoed.headers.getSetCookie()));

	// A refusal, with the stale session cleared on the way out.
	const denied = await preflight(`${AUTH}?mode=deny`, { cookie: 'fixture_session=stale' });
	check('a refusing hook is 401', denied.status === 401, `got ${denied.status}`);
	check('and its cookie deletion survives the refusal',
		denied.headers.getSetCookie().some((c) => c.startsWith('fixture_session=;')),
		JSON.stringify(denied.headers.getSetCookie()));

	// A throwing hook is 500 and nothing else: the server stays up.
	const threw = await preflight(`${AUTH}?mode=throw`);
	check('a throwing hook is 500', threw.status === 500, `got ${threw.status}`);

	// The CSRF guard, over the wire.
	const foreign = await fetch(AUTH, { method: 'POST', headers: { origin: 'https://evil.example' } });
	check('a foreign origin is refused', foreign.status === 403, `got ${foreign.status}`);
	const bare = await fetch(AUTH, { method: 'POST' });
	check('a request with no evidence at all is refused', bare.status === 403, `got ${bare.status}`);
	const sameSite = await fetch(AUTH, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
	check('the browser-stamped header is accepted', sameSite.status === 204, `got ${sameSite.status}`);

	// Routing: the endpoint sits ahead of the SSR catch-all, and answers the
	// wrong verb itself rather than letting it render a page.
	const get = await fetch(AUTH);
	check('GET is 405, not a rendered page', get.status === 405, `got ${get.status}`);
	check('and says what is allowed', get.headers.get('allow') === 'POST', String(get.headers.get('allow')));
	const getBody = await get.text();
	check('with no HTML in it', !getBody.includes('<html'), JSON.stringify(getBody.slice(0, 60)));

	// Nothing else moved: the WS endpoint and the page lane still answer.
	const page = await fetch(`${BASE}/`);
	check('the app still renders', page.status === 200, `got ${page.status}`);
	const notFound = await fetch(`${BASE}/__ws/nothing`, { method: 'POST' });
	check('a neighbouring path is not the endpoint', notFound.status !== 204 && notFound.status !== 405,
		`got ${notFound.status}`);

} finally {
	proc.kill();
	await proc.exited;
}

// Read after the server is down, for the reason the rate-limit suite gives: a
// live reader on a stream that mostly stays silent is one more thing that can
// hang a suite.
const stdout = await new Response(proc.stdout).text();
check('the boot banner names the endpoint',
	/WebSocket auth endpoint registered at \/__ws\/auth/.test(stdout),
	JSON.stringify(stdout.slice(-200)));

const stderr = await new Response(proc.stderr).text();
check('a refused origin says why', /refused an auth preflight POST/.test(stderr),
	JSON.stringify(stderr.slice(-300)));
check('and names both ways out',
	/authPathRequireOrigin/.test(stderr) && /allowedOrigins/.test(stderr));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}
