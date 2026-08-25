// The live wire-contract lane. Runs the send-result suite (which boots its own
// bare Bun.serve and needs no build), then builds the fixture, runs the
// WebSocket suites against it, then builds the fixture's NO_WS variant and runs
// the no-handler regression. Every suite boots its own server, so this asserts
// the contract end to end: a change to the demux in handler/ws.js that the unit
// suite cannot see fails here.
//
// Needs Bun and the fixture's dependencies (`npm install` in test/fixture
// once). Run with: npm run test:live

import { fileURLToPath } from 'node:url';

const fixtureDir = fileURLToPath(new URL('../fixture/', import.meta.url));
const suite = (name) => fileURLToPath(new URL(name, import.meta.url));

const failures = [];

// A step that wedges must not wedge the lane with no diagnostic, so every one
// of them is bounded. The builds and the suites all finish in seconds; this
// only ever fires on a hang.
const STEP_TIMEOUT_MS = 180_000;

async function run(label, cmd, opts = {}) {
	console.log(`\n== ${label}`);
	const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', ...opts });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try { proc.kill(); } catch {}
	}, STEP_TIMEOUT_MS);
	const code = await proc.exited;
	clearTimeout(timer);
	if (timedOut) {
		failures.push(`${label} (timed out after ${STEP_TIMEOUT_MS / 1000}s)`);
		return false;
	}
	if (code !== 0) failures.push(`${label} (exit ${code})`);
	return code === 0;
}

// Every build-selecting variable is pinned, not just ADAPTER. Any one left
// exported in the shell silently redirects the build somewhere else and leaves
// the output the suites assert against untouched - and since those directories
// are gitignored, a stale one from an earlier run persists indefinitely and the
// suites pass against a build this lane never produced.
// NODE_ENV too: vite derives its production mode from it, so an exported
// development value builds a different bundle than the one this lane claims to
// be asserting against.
const buildEnv = {
	...process.env,
	ADAPTER: 'bunserve',
	NO_WS: '',
	STATIC_DOTFILES: '',
	WS_ADMISSION: '',
	WS_UPGRADE_TIMEOUT: '',
	WS_RATE_LIMIT: '',
	NODE_ENV: 'production'
};

// Independent of the fixture: it drives the real facade over its own server.
await run('send-result-check', [process.execPath, suite('send-result-check.mjs')]);

const built = await run('build fixture', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: buildEnv
});
if (built) {
	await run('ws-smoke', [process.execPath, suite('ws-smoke.mjs')]);
	await run('cap-check', [process.execPath, suite('cap-check.mjs')]);
	await run('origin-check', [process.execPath, suite('origin-check.mjs')]);
	await run('wire-check', [process.execPath, suite('wire-check.mjs')]);
	await run('pressure-check', [process.execPath, suite('pressure-check.mjs')]);
	await run('head-check', [process.execPath, suite('head-check.mjs')]);
	await run('auth-endpoint-check', [process.execPath, suite('auth-endpoint-check.mjs')]);
	await run('metrics-check', [process.execPath, suite('metrics-check.mjs')]);
	// Skips itself on Windows, where the signal never reaches the handler.
	await run('shutdown-check', [process.execPath, suite('shutdown-check.mjs')]);
}

// Runs its own builds rather than borrowing the one above: it needs BOTH
// builds of the same static/ tree (default and opted-in), and it asserts what
// the build PRINTED, which only a captured build gives it.
await run('static-dotfiles-check', [process.execPath, suite('static-dotfiles-check.mjs')]);

// Raw-socket requests carrying literally duplicated forwarded headers - the
// case fetch() cannot construct and the one where the Bun generations differ.
await run('xff-duplicate-check', [process.execPath, suite('xff-duplicate-check.mjs')]);

// The boot banner against the built server: version and protocol revision
// read from the deployed meta files, sibling resolution answered honestly.
await run('version-banner-check', [process.execPath, suite('version-banner-check.mjs')]);

const builtNoWs = await run('build fixture (NO_WS)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, NO_WS: '1' }
});
if (builtNoWs) {
	await run('no-ws-check', [process.execPath, suite('no-ws-check.mjs')]);
}

// Its own build for the reason the NO_WS one has its own: the ceiling has to be
// low enough for a test to reach, and a ceiling that low in the main build
// would shed most of what the other suites and the leak lane open.
const builtAdmission = await run('build fixture (WS_ADMISSION)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, WS_ADMISSION: '1' }
});
if (builtAdmission) {
	await run('admission-check', [process.execPath, suite('admission-check.mjs')]);
}

// Its own build again, and for the same shape of reason: the admission suite
// above hangs a handshake open for four seconds deliberately, so a bound short
// enough for a test to reach would answer that handshake before it could be
// abandoned. The bound only fires on a REAL clock, which is the whole reason
// this is a live suite - the unit lane drives it on a virtual one.
const builtUpgradeTimeout = await run('build fixture (WS_UPGRADE_TIMEOUT)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, WS_UPGRADE_TIMEOUT: '1' }
});
if (builtUpgradeTimeout) {
	await run('upgrade-timeout-check', [process.execPath, suite('upgrade-timeout-check.mjs')]);
}

// Its own build for a blunter reason than the others: the limiter is OFF in the
// main build, because every suite there - and the leak lane at 50 rps for
// minutes - drives it from this one address, which is exactly the traffic a
// per-address limit exists to refuse.
const builtRateLimit = await run('build fixture (WS_RATE_LIMIT)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, WS_RATE_LIMIT: '1' }
});
if (builtRateLimit) {
	await run('upgrade-rate-limit-check', [process.execPath, suite('upgrade-rate-limit-check.mjs')]);
	// The same build's other metered door, in its own suite so each door's
	// budget is proved on a server where nothing else has spent it. That suite
	// also drives BOTH doors in one process at the end, which is the only place
	// the per-door advisory latch can be observed: one latch for the process
	// would leave the second door silent there and nowhere else.
	await run('auth-rate-limit-check', [process.execPath, suite('auth-rate-limit-check.mjs')]);
}

if (failures.length) {
	console.log(`\nlive lane FAILED:\n  ${failures.join('\n  ')}`);
	process.exit(1);
}
console.log('\nlive lane passed');
