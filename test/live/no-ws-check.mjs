// Regression: an app with WebSockets disabled must build and serve with no
// upgrade lane, no websocket option on Bun.serve, and the HTTP surface
// untouched. The fixture's NO_WS build sets websocket:false while retaining
// src/hooks.ws.js and the Vite plugin, so neither may enable the endpoint.

import { assertPortFree, buildPath, rawExchange, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8803;
const BUILD = buildPath('build-no-ws');

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

try {
	await waitForServer(proc, PORT);

	// Re-fetched rather than asserting the retry loop's own success: `true` was
	// a check that could not fail, and a check that cannot fail is not one.
	const healthz = await fetch(`http://127.0.0.1:${PORT}/healthz`);
	check('health probe still answers', healthz.status === 200, `got ${healthz.status}`);

	const readyz = await fetch(`http://127.0.0.1:${PORT}/readyz`);
	check('readiness probe still answers', readyz.status === 200, `got ${readyz.status}`);

	const ssr = await fetch(`http://127.0.0.1:${PORT}/`);
	check('SSR still renders', ssr.status === 200 && (await ssr.text()).includes('<'), `got ${ssr.status}`);

	const staticFile = await fetch(`http://127.0.0.1:${PORT}/test.txt`);
	check('static assets still serve', staticFile.status === 200, `got ${staticFile.status}`);

	const prerendered = await fetch(`http://127.0.0.1:${PORT}/about/`);
	check('prerendered pages still serve', prerendered.status === 200, `got ${prerendered.status}`);

	// websocket:false has no configured registry. The members remain callable.
	const metrics = await fetch(`http://127.0.0.1:${PORT}/metrics`);
	const metricsBody = await metrics.text();
	check('an unconfigured snapshot is handled without a server error', metrics.status === 503, `got ${metrics.status}`);
	check('the route reports an absent registry', metricsBody === 'metrics not configured', metricsBody);

	// With WebSockets disabled the ws path is not special: it falls through
	// to the normal routing, where the fixture's /ws route answers it. Asked with
	// `Upgrade: websocket`, because a plain GET goes to the app with or without
	// an endpoint, and a request the endpoint would keep is the one that shows
	// whether there is one.
	const wsPath = await fetch(`http://127.0.0.1:${PORT}/ws`, {
		headers: { upgrade: 'websocket', connection: 'Upgrade' }
	});
	check('the ws path is NOT hijacked when WebSockets are disabled', (await wsPath.text()) === 'app GET', `got ${wsPath.status}`);

	// And a REAL handshake does not connect. `fetch` with upgrade headers never
	// surfaces a 101 to its caller, so asserting `status !== 101` on one passes
	// for every outcome including a successful upgrade - it proved nothing. A
	// genuine WebSocket client can tell the difference: with WebSockets disabled the
	// endpoint does not exist, so the connection must fail rather than open.
	const upgradeOutcome = await new Promise((resolve) => {
		const probe = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const settle = (what) => {
			clearTimeout(timer);
			try { probe.close(); } catch {}
			resolve(what);
		};
		const timer = setTimeout(() => settle('timeout'), 3000);
		probe.onopen = () => settle('opened');
		probe.onerror = () => settle('refused');
		probe.onclose = () => settle('refused');
	});
	check('a real handshake does not connect', upgradeOutcome === 'refused', `got ${upgradeOutcome}`);

	// The request-target rule does not depend on a realtime tier.
	const fragment = await rawExchange(PORT, [], { path: '/healthz#x' });
	check('a target carrying a # is refused 400 here too', fragment.status === 400, `got ${fragment.status}`);
	// Disabling WebSockets also disables the auth endpoint, so its path and its spellings are the
	// app's: SvelteKit answers the data request 404, where a mounted path is
	// refused 400.
	const authData = await fetch(`http://127.0.0.1:${PORT}/__ws/auth/__data.json`);
	check('the auth path\'s data request is the app\'s when nothing is mounted there', authData.status === 404,
		`got ${authData.status}`);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	proc.kill();
	if (failed > 0) {
		console.log('\n--- stdout ---\n' + (await new Response(proc.stdout).text()).slice(-2000));
		console.log('\n--- stderr ---\n' + (await new Response(proc.stderr).text()).slice(-2000));
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(failed === 0 ? 0 : 1);
