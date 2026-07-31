// The graceful-shutdown SIGNAL path, which nothing else exercises.
//
// The shutdown LOGIC is reachable through the fixture's /drain route, so
// ws-smoke covers the advisory frames and the 1012 close. What no other test
// touches is the path FROM the signal handler: whether SIGTERM reaches
// `graceful_shutdown` at all, whether the app's `shutdown` hook is called from
// it and in the right order relative to the drain, and whether the process
// exits 0 within its deadline instead of hanging or being killed.
//
// PLATFORM: this cannot run on Windows. A built server there exits 143 on
// SIGTERM without the handler running at all - verified by capturing child
// stdout, which shows the boot lines and nothing else - so every assertion
// below would fail for a reason that says nothing about the code. The suite
// skips rather than failing, and the CI workflow runs it on Linux.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8806;
const BUILD = buildPath();

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

if (process.platform === 'win32') {
	console.log('  skip  the shutdown signal path (SIGTERM does not reach the handler on Windows)');
	console.log('\n0 passed, 0 failed (skipped on win32)');
	process.exit(0);
}

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

/** Collect stdout as it arrives: the ORDERING of the lines is under test. */
const stdoutChunks = [];
const stdoutDone = (async () => {
	for await (const chunk of proc.stdout) stdoutChunks.push(Buffer.from(chunk).toString());
})();
const serverOut = () => stdoutChunks.join('');

try {
	await waitForServer(proc, PORT);

	// Several clients, so the drain is observed as a fleet rather than one socket.
	const CLIENTS = 3;
	const clients = [];
	for (let i = 0; i < CLIENTS; i++) {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?user=drain${i}`);
		const frames = [];
		const closed = new Promise((resolve) => {
			ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
		});
		ws.onmessage = (e) => {
			try { frames.push(JSON.parse(e.data)); } catch { /* binary, not under test */ }
		};
		await new Promise((resolve, reject) => {
			ws.onopen = resolve;
			ws.onerror = () => reject(new Error(`client ${i} failed to connect`));
		});
		clients.push({ ws, frames, closed });
	}
	// Let the welcome and the fixture's `opened` envelope land.
	await Bun.sleep(300);

	const startedAt = Date.now();
	proc.kill('SIGTERM');

	const closes = await Promise.all(
		clients.map((c) =>
			Promise.race([c.closed, Bun.sleep(15000).then(() => ({ code: 'timeout' }))])
		)
	);
	const exitCode = await Promise.race([
		proc.exited,
		Bun.sleep(15000).then(() => 'timeout')
	]);
	const elapsed = Date.now() - startedAt;
	await Promise.race([stdoutDone, Bun.sleep(2000)]);
	const out = serverOut();

	// (0) The signal reached the handler at all. Every other assertion is
	// meaningless without this, so it is reported first and named plainly.
	check(
		'SIGTERM reaches the graceful shutdown handler',
		/Received SIGTERM, shutting down gracefully/.test(out),
		JSON.stringify(out.slice(-400))
	);

	// (a) Clients are ADVISED before they are cut, so each rolls its own
	// reconnect delay instead of the fleet returning in one tick.
	const advised = clients.filter((c) => c.frames.some((f) => f && f.type === 'reconnect'));
	check(
		`every client is advised to reconnect (${advised.length}/${CLIENTS})`,
		advised.length === CLIENTS,
		JSON.stringify(clients.map((c) => c.frames.map((f) => f && f.type)))
	);
	const advisory = advised[0]?.frames.find((f) => f.type === 'reconnect');
	check(
		'the advisory carries a reconnect window',
		Boolean(advisory) && typeof advisory.windowMs === 'number',
		JSON.stringify(advisory)
	);

	// (b) A real close code, not the 1006 a bare stop(true) produces.
	check(
		'every client closes with 1012, not 1006',
		closes.every((c) => c.code === 1012),
		JSON.stringify(closes)
	);

	// (c) The app's shutdown hook runs, and BEFORE the sockets are gone - the
	// documented use is flushing a last frame through connections that must
	// still exist. The fixture logs its connection count, so a hook that ran
	// after the drain is visible as 0.
	const shutdownLine = out.match(/\[fixture\] shutdown connections=(\d+)/);
	check('the app shutdown hook runs from the signal path', Boolean(shutdownLine), JSON.stringify(out.slice(-400)));
	check(
		'the shutdown hook still sees its connections',
		Boolean(shutdownLine) && Number(shutdownLine[1]) === CLIENTS,
		shutdownLine ? `connections=${shutdownLine[1]}, expected ${CLIENTS}` : 'no shutdown line'
	);

	// The close hooks run too, and the drain waits for them rather than letting
	// process.exit cut them mid-flight.
	const closeLines = [...out.matchAll(/\[fixture\] close code=(\d+)/g)];
	check(
		`every connection's close hook completes (${closeLines.length}/${CLIENTS})`,
		closeLines.length === CLIENTS,
		JSON.stringify(out.slice(-600))
	);

	// (d) Exits cleanly, within the deadline, rather than hanging or being cut.
	check('the process exits 0', exitCode === 0, `exit=${exitCode}`);
	check(
		`shutdown completes well inside SHUTDOWN_TIMEOUT (took ${elapsed}ms)`,
		typeof exitCode === 'number' && elapsed < 30000,
		`elapsed=${elapsed}ms`
	);
	check('shutdown reports completion', /Shutdown complete\./.test(out), JSON.stringify(out.slice(-200)));

	// Ordering: the advisory has to precede the completion line, which is the
	// whole point of draining before stopping.
	const drainAt = out.indexOf('[fixture] shutdown');
	const doneAt = out.indexOf('Shutdown complete.');
	check(
		'the shutdown hook runs before the process finishes shutting down',
		drainAt !== -1 && doneAt !== -1 && drainAt < doneAt,
		`shutdownHook@${drainAt} complete@${doneAt}`
	);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	try { proc.kill(); } catch { /* already gone, which is the expected case */ }
	if (failed > 0) {
		console.log('\n--- server stdout ---\n' + serverOut().slice(-3000));
		console.log('\n--- server stderr ---\n' + (await new Response(proc.stderr).text()).slice(-1000));
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(failed === 0 ? 0 : 1);
