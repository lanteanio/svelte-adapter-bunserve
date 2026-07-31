// Regression: an app with NO WebSocket handler must build and serve with no
// upgrade lane, no websocket option on Bun.serve, and the HTTP surface
// untouched. Runs against the fixture's NO_WS build (build-no-ws), which sets
// no websocket options and points websocketHandler at a file the fixture does
// not have - the same no-handler state as an app that never opted in.

import { fileURLToPath } from 'node:url';

const PORT = 8803;
const BUILD = fileURLToPath(new URL('../fixture/build-no-ws/index.js', import.meta.url));

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

const proc = Bun.spawn([process.execPath, BUILD], {
	env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	let up = false;
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) { up = true; break; } } catch {}
		await Bun.sleep(100);
	}
	if (!up) throw new Error('server never came up');

	check('health probe still answers', true);

	const readyz = await fetch(`http://127.0.0.1:${PORT}/readyz`);
	check('readiness probe still answers', readyz.status === 200, `got ${readyz.status}`);

	const ssr = await fetch(`http://127.0.0.1:${PORT}/`);
	check('SSR still renders', ssr.status === 200 && (await ssr.text()).includes('<'), `got ${ssr.status}`);

	const staticFile = await fetch(`http://127.0.0.1:${PORT}/test.txt`);
	check('static assets still serve', staticFile.status === 200, `got ${staticFile.status}`);

	const prerendered = await fetch(`http://127.0.0.1:${PORT}/about/`);
	check('prerendered pages still serve', prerendered.status === 200, `got ${prerendered.status}`);

	// With no handler configured the ws path is not special: it falls through
	// to the normal routing, which has no /ws route, so SvelteKit 404s.
	const wsPath = await fetch(`http://127.0.0.1:${PORT}/ws`);
	check('the ws path is NOT hijacked when no handler is configured', wsPath.status === 404, `got ${wsPath.status}`);

	// And an actual upgrade attempt is refused rather than upgraded.
	const upgradeAttempt = await fetch(`http://127.0.0.1:${PORT}/ws`, {
		headers: { upgrade: 'websocket', connection: 'Upgrade' }
	});
	check('an upgrade attempt does not connect', upgradeAttempt.status !== 101, `got ${upgradeAttempt.status}`);
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
