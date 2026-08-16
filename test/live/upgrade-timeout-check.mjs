// `websocket.upgradeTimeout`, proved against a real server.
//
// The unit lane drives this on a VIRTUAL clock, which is what makes the
// ordering exact - and is also what it cannot prove. In production the timer
// comes from the runtime seam bound to a real `setTimeout`, so a seam that was
// mis-bound, or a bound resolved in the wrong unit, would pass every unit test
// and never fire on a deployed server. Only a real socket and a real clock can
// tell those apart.
//
// Runs against the fixture's WS_UPGRADE_TIMEOUT build (build-upgrade-timeout):
// a bound of 0.3s and a connection ceiling of TWO. The ceiling is there because
// the interesting half of a timeout is what it GIVES BACK - a bound that
// refused the client but kept its permit would narrow the ceiling by one for
// the life of the process, and the symptom is a server that stops admitting
// anyone long after the hook that hung has been forgotten.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8807;
const BUILD = buildPath('build-upgrade-timeout');
const BASE = `http://127.0.0.1:${PORT}`;
const BOUND_MS = 300;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/**
 * Ask for an upgrade over plain HTTP and read the refusal.
 *
 * A WebSocket client is the wrong instrument here: it reports "it did not
 * open" and nothing about WHY, so a 504 from the timeout and a 503 from the
 * ceiling are the same event to it. The handshake headers are sent by hand so
 * the status line itself is readable.
 *
 * @param {string} query
 */
async function requestUpgrade(query) {
	const started = Date.now();
	const res = await fetch(`${BASE}/ws${query}`, {
		headers: {
			upgrade: 'websocket',
			connection: 'Upgrade',
			'sec-websocket-version': '13',
			'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
			origin: BASE
		}
	});
	const body = await res.text();
	return { status: res.status, body, elapsed: Date.now() - started };
}

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), ORIGIN: BASE }),
	stdout: 'inherit',
	stderr: 'inherit'
});

try {
	await waitForServer(proc, PORT);

	// A hook that holds far longer than the bound. The fixture parks its
	// `upgrade` hook for the number of milliseconds asked for.
	const timedOut = await requestUpgrade('?hold=3000');
	check('a hook that outruns the bound is refused with 504', timedOut.status === 504,
		`got ${timedOut.status}`);
	check('and says so in the body', timedOut.body.includes('timed out'),
		JSON.stringify(timedOut.body.slice(0, 60)));
	// The bound is real rather than immediate: a refusal that arrived at once
	// would mean the hook was never awaited at all.
	check('after roughly the configured bound, not instantly',
		timedOut.elapsed >= BOUND_MS && timedOut.elapsed < 3000,
		`${timedOut.elapsed}ms, bound ${BOUND_MS}ms`);

	// Enough to exhaust a ceiling of two several times over, if a timeout kept
	// what it took. This is the assertion the whole suite is for.
	for (let i = 0; i < 4; i++) await requestUpgrade('?hold=3000');

	const admitted = await new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => resolve('never opened'), 5_000);
		ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); resolve('open'); });
		ws.addEventListener('error', () => { clearTimeout(timer); resolve('refused'); });
	});
	check('five timed-out handshakes later, the server still admits a client',
		admitted === 'open', admitted);

	// A hook that answers inside the bound is untouched by it.
	const inTime = await requestUpgrade('?hold=50&deny=1');
	check('a hook that answers within the bound is not timed out',
		inTime.status !== 504, `got ${inTime.status}`);

	// And SSR is unaffected: the bound is on the upgrade hook, not on requests.
	const page = await fetch(`${BASE}/`);
	check('ordinary requests are not bounded by it', page.status === 200, `got ${page.status}`);
} finally {
	proc.kill();
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}
