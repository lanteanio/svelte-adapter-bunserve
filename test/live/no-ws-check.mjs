// Regression: an app with NO WebSocket handler must build and serve with no
// upgrade lane, no websocket option on Bun.serve, and the HTTP surface
// untouched. Runs against the fixture's NO_WS build (build-no-ws), which sets
// no websocket options and points websocketHandler at a file the fixture does
// not have - the same no-handler state as an app that never opted in.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

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

	// The observability members are documented as being on EVERY instance, and
	// a scrape route is the most likely reason an app with no realtime tier
	// reaches for `platform` at all. The route is the fixture's own
	// `/metrics`, compiled into this build like any other: before the platform
	// carried these without a WebSocket handler it answered 500 with
	// `platform.metricsSnapshot is not a function`.
	const metrics = await fetch(`http://127.0.0.1:${PORT}/metrics`);
	const metricsBody = metrics.status === 200 ? await metrics.text() : '';
	check('the scrape route serves without a realtime tier', metrics.status === 200, `got ${metrics.status}`);
	check(
		'the document it serves is the Prometheus one',
		metricsBody.includes('# TYPE ') && metricsBody.includes('ws_connections'),
		JSON.stringify(metricsBody.slice(0, 120))
	);

	// With no handler configured the ws path is not special: it falls through
	// to the normal routing, which has no /ws route, so SvelteKit 404s.
	const wsPath = await fetch(`http://127.0.0.1:${PORT}/ws`);
	check('the ws path is NOT hijacked when no handler is configured', wsPath.status === 404, `got ${wsPath.status}`);

	// And a REAL handshake does not connect. `fetch` with upgrade headers never
	// surfaces a 101 to its caller, so asserting `status !== 101` on one passes
	// for every outcome including a successful upgrade - it proved nothing. A
	// genuine WebSocket client can tell the difference: with no handler the
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
