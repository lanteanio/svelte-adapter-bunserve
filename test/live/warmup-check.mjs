// Live regression test for the readiness-gated boot warmup.
//
// Two properties, and the second is why the first is safe to have at all.
//
// ORDERING: the warmup runs inside the `starting` window, so readiness answers
// 503 until it has finished. That is what makes it a gate rather than a race -
// a load balancer routes the first real client the moment readiness turns
// green, and the whole point is that the render path is warm by then.
//
// HANG SAFETY: this build's warmup points at a route whose body NEVER ends.
// Draining it would await forever, so the warmup has to cancel it instead -
// the headers and the first render already warmed the path. A warmup that
// cannot finish must never be able to hold readiness down: an instance that
// never reports ready is worse than one whose first render is cold.
//
// Run the whole live lane with: npm run test:live

import { assertPortFree, buildPath, serverEnv } from './harness.mjs';

const PORT = 8807;
const BUILD = buildPath('build-warmup-hang');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
	if (cond) {
		passed++;
		console.log(`  ok  ${name}`);
	} else {
		failed++;
		failures.push(`${name}${detail ? ' :: ' + detail : ''}`);
		console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
	}
}

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

/** Collected so the ordering assertion reads the real boot log. */
let stdout = '';
const reader = (async () => {
	for await (const chunk of proc.stdout) stdout += new TextDecoder().decode(chunk);
})();

try {
	// Poll readiness from the moment the listener answers ANYTHING, so the
	// 503-then-200 transition is observed rather than assumed. Liveness is up as
	// soon as the socket binds, which is exactly the window under test.
	const deadline = Date.now() + 30_000;
	let sawStarting = false;
	let ready = false;
	let livenessBeforeReady = false;
	while (Date.now() < deadline) {
		let readyRes;
		try {
			readyRes = await fetch(`http://127.0.0.1:${PORT}/readyz`);
		} catch {
			await Bun.sleep(10);
			continue;
		}
		if (readyRes.status === 503) {
			sawStarting = true;
			// Liveness must stay 200 throughout: the process IS up, it is only
			// not ready. A liveness probe that fails here restarts a booting pod.
			const live = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (live.status === 200) livenessBeforeReady = true;
			await Bun.sleep(10);
			continue;
		}
		if (readyRes.status === 200) { ready = true; break; }
		await Bun.sleep(10);
	}

	check(
		'readiness commits even though the warmup render never ends',
		ready,
		'readiness never returned 200 within 30s'
	);
	// The gate itself: readiness said NOT ready while the warmup was in flight.
	// This build's warmup render is deliberately slow enough to observe, because
	// a fast one cannot be distinguished from no gate at all.
	check(
		'readiness reports 503 while the warmup is still running',
		sawStarting,
		'readiness was 200 on the first poll, so nothing gated it'
	);
	check(
		'liveness stays 200 while readiness is still starting',
		livenessBeforeReady,
		'a liveness probe that fails here restarts a pod that is merely booting'
	);

	// The listen line is written when the SOCKET binds, which is before the
	// warmup runs - the init hook needs the listener. So the boot log's ordering
	// is listen, then warmup, then ready; the readiness transition above is what
	// proves the gate, and this only confirms the warmup announced itself.
	await Bun.sleep(200);
	check(
		'the warmup ran and said so',
		stdout.includes('Warmed'),
		`boot log had no warmup line: ${JSON.stringify(stdout.slice(0, 300))}`
	);

	// And the route itself still serves a real client afterwards: cancelling the
	// warmup's body must not have poisoned the render path it warmed.
	const res = await fetch(`http://127.0.0.1:${PORT}/`);
	check('the app serves normally after the warmup', res.status === 200, `status ${res.status}`);
} catch (err) {
	failed++;
	failures.push(`harness: ${err.message}`);
	console.log(`FAIL  harness :: ${err.message}`);
} finally {
	proc.kill();
	await reader.catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
	console.log('failures:');
	for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
