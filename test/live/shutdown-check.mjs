// The graceful-shutdown SIGNAL path, which nothing else exercises.
//
// The shutdown LOGIC is reachable through the fixture's /drain route, so
// ws-smoke covers the advisory frames and the 1012 close. What no other test
// touches is the path FROM the signal handler: whether SIGTERM reaches
// `graceful_shutdown` at all, whether the app's `shutdown` hook is called from
// it and in the right order relative to the drain, whether a close hook's
// ASYNC work survives to completion instead of being cut by process.exit, and
// whether the process exits 0 within its deadline instead of hanging or being
// killed. A second server is then spawned with the fixture's shutdown hook
// armed to hang, proving the deadline - not the hook - releases the shutdown.
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

	// A HALF-SENT REQUEST, parked for the whole shutdown. `server.stop()`
	// resolves only when the last connection closes, and a connection that sent
	// part of a request and then stopped never closes on its own - so a
	// shutdown gated on stop()'s settlement hangs on one stalled client, which
	// on a rolling deploy is a pod that eats its whole grace period and dies by
	// SIGKILL. The sequence under test never awaits that promise, and the
	// stop(true) at its end is what closes this socket; the exit-0-in-time
	// checks below are only proof of that while this socket is being held open.
	let halfSentClosed = false;
	const halfSent = await Bun.connect({
		hostname: '127.0.0.1',
		port: PORT,
		socket: {
			data() { /* no response is expected for half a request */ },
			close() { halfSentClosed = true; },
			error() { /* a reset at hard-close still counts as closed */ halfSentClosed = true; }
		}
	});
	// Headers deliberately unterminated: the request is never dispatched, so no
	// drain counter sees it - only the connection accounting stop() waits on.
	halfSent.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n');

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

	// The close hooks run too. Bun runs them synchronously inside the drain's
	// own close loop, so this line proves they RUN during a signal shutdown -
	// the guard against a bare stop(true) guillotine - but not that async work
	// survives; the completion marker below is what proves that.
	const closeLines = [...out.matchAll(/\[fixture\] close code=(\d+)/g)];
	check(
		`every connection's close hook runs (${closeLines.length}/${CLIENTS})`,
		closeLines.length === CLIENTS,
		JSON.stringify(out.slice(-600))
	);

	// (e) The close hook's ASYNC work completes. The fixture's hook parks its
	// completion marker behind a 150ms timer, so the marker can only appear if
	// the drain's settle wait actually holds the process open for the tracked
	// hook promises - an exit that no longer waits shows up here as missing
	// lines, not as a slower pass.
	const closeAsyncLines = [...out.matchAll(/\[fixture\] close-async done/g)];
	check(
		`every close hook's async work completes (${closeAsyncLines.length}/${CLIENTS})`,
		closeAsyncLines.length === CLIENTS,
		JSON.stringify(out.slice(-600))
	);

	// (d) Exits cleanly, within the deadline, rather than hanging or being cut.
	check('the process exits 0', exitCode === 0, `exit=${exitCode}`);
	check(
		`shutdown completes well inside SHUTDOWN_TIMEOUT (took ${elapsed}ms)`,
		typeof exitCode === 'number' && elapsed < 30000,
		`elapsed=${elapsed}ms`
	);
	// The half-sent request neither held the shutdown open (the two checks
	// above passed with it parked) nor survived it: the hard-close is what
	// ends a connection that will never finish its request.
	await Bun.sleep(100);
	check(
		'the half-sent request is closed by the hard-close, not waited on',
		halfSentClosed,
		'socket still open after the process exited'
	);
	check('shutdown reports completion', /Shutdown complete\./.test(out), JSON.stringify(out.slice(-200)));

	// Ordering: the shutdown hook's line has to precede the completion line -
	// the hook runs at the top of the shutdown sequence, not as an afterthought
	// racing process.exit.
	const hookAt = out.indexOf('[fixture] shutdown');
	const doneAt = out.indexOf('Shutdown complete.');
	check(
		'the shutdown hook runs before the process finishes shutting down',
		hookAt !== -1 && doneAt !== -1 && hookAt < doneAt,
		`shutdownHook@${hookAt} complete@${doneAt}`
	);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	// SIGKILL, not the default SIGTERM: a server whose shutdown path is broken
	// is exactly what this suite exists to catch, and such a server survives a
	// SIGTERM indefinitely - cleanup must not depend on the path under test.
	try { proc.kill('SIGKILL'); } catch { /* already gone, which is the expected case */ }
	// Wait for the port to actually be released before the second server binds it.
	await Promise.race([proc.exited, Bun.sleep(2000)]);
	if (failed > 0) {
		console.log('\n--- server stdout ---\n' + serverOut().slice(-3000));
		console.log('\n--- server stderr ---\n' + (await new Response(proc.stderr).text()).slice(-1000));
	}
}

// A shutdown hook that never settles must not hold the process open. The
// deadline is the guarantee under test here, so this server gets a short
// SHUTDOWN_TIMEOUT and the fixture's hook armed to hang: the shutdown must
// still run to completion and exit 0 - later than a well-behaved one (the
// deadline is what releases it), but bounded.
await assertPortFree(PORT);
const hangProc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({
		HOST: '127.0.0.1',
		PORT: String(PORT),
		SHUTDOWN_TIMEOUT: '4',
		FIXTURE_HANG_SHUTDOWN: '1'
	}),
	stdout: 'pipe',
	stderr: 'pipe'
});
const hangChunks = [];
const hangStdoutDone = (async () => {
	for await (const chunk of hangProc.stdout) hangChunks.push(Buffer.from(chunk).toString());
})();

try {
	await waitForServer(hangProc, PORT);
	const hangStartedAt = Date.now();
	hangProc.kill('SIGTERM');
	const hangExit = await Promise.race([
		hangProc.exited,
		Bun.sleep(15000).then(() => 'timeout')
	]);
	const hangElapsed = Date.now() - hangStartedAt;
	await Promise.race([hangStdoutDone, Bun.sleep(2000)]);
	const hangOut = hangChunks.join('');

	check(
		'the hanging shutdown hook is reached from the signal path',
		/\[fixture\] shutdown connections=/.test(hangOut),
		JSON.stringify(hangOut.slice(-400))
	);
	// SHUTDOWN_TIMEOUT=4 puts the hook's share of the budget at 3s (a quarter
	// is reserved for the SSR drain), so a run released by the deadline lands
	// near that mark: well past an instant exit that never awaited the hook,
	// and well short of the 15s race that catches a process the hook holds
	// open.
	check(
		`the deadline, not the hook, releases the shutdown (exit=${hangExit} after ${hangElapsed}ms)`,
		hangExit === 0 && hangElapsed >= 2500 && hangElapsed < 10000,
		`exit=${hangExit} elapsed=${hangElapsed}ms`
	);
	check(
		'shutdown still reports completion with the hook hung',
		/Shutdown complete\./.test(hangOut),
		JSON.stringify(hangOut.slice(-200))
	);
} catch (err) {
	failed++;
	failures.push('THREW (hanging-hook server): ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	// SIGKILL for the same reason as above - this server's shutdown hook is
	// armed to hang, so a graceful signal is the one thing guaranteed not to
	// end it when the deadline under test is the broken part.
	try { hangProc.kill('SIGKILL'); } catch { /* already gone, which is the expected case */ }
	await Promise.race([hangProc.exited, Bun.sleep(2000)]);
	if (failed > 0) {
		console.log('\n--- hanging-hook server stdout ---\n' + hangChunks.join('').slice(-1500));
		console.log('\n--- hanging-hook server stderr ---\n' + (await new Response(hangProc.stderr).text()).slice(-1000));
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(failed === 0 ? 0 : 1);
