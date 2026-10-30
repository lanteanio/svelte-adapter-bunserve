// The live wire-contract lane. Runs the send-result suite (which boots its own
// bare Bun.serve and needs no build), then builds the fixture, runs the
// WebSocket suites against it, then builds the fixture's NO_WS variant and runs
// the disabled-WebSocket regression. Every suite boots its own server, so this asserts
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
	WS_BACKPRESSURE: '',
	MOUNT_SPELLING: '',
	FIXTURE_ENV_PREFIX: '',
	FIXTURE_BASE_PATH: '',
	NODE_ENV: 'production'
};

// Independent of the fixture: it drives the real facade over its own server.
await run('send-result-check', [process.execPath, suite('send-result-check.mjs')]);
await run('coalesced-check', [process.execPath, suite('coalesced-check.mjs')]);
await run('delivery-authorization-check', [process.execPath, suite('delivery-authorization-check.mjs')]);
await run('unsubscribe-check', [process.execPath, suite('unsubscribe-check.mjs')]);
await run('request-body-rejection-check', [process.execPath, suite('request-body-rejection-check.mjs')]);
await run('response-stream-failure-check', [process.execPath, suite('response-stream-failure-check.mjs')]);

const built = await run('build fixture', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: buildEnv
});
if (built) {
	await run('ws-smoke', [process.execPath, suite('ws-smoke.mjs')]);
	await run('client-check', [process.execPath, suite('client-check.mjs')]);
	await run('runtime-control-check', [process.execPath, suite('runtime-control-check.mjs')]);
	await run('platform-contract-check', [process.execPath, suite('platform-contract-check.mjs')]);
	await run('cap-check', [process.execPath, suite('cap-check.mjs')]);
	await run('origin-check', [process.execPath, suite('origin-check.mjs')]);
	await run('wire-check', [process.execPath, suite('wire-check.mjs')]);
	await run('pressure-check', [process.execPath, suite('pressure-check.mjs')]);
	await run('response-framing-check', [process.execPath, suite('response-framing-check.mjs')]);
	await run('static-overflow-check', [process.execPath, suite('static-overflow-check.mjs')]);
	await run('head-check', [process.execPath, suite('head-check.mjs')]);
	await run('ssr-coding-check', [process.execPath, suite('ssr-coding-check.mjs')]);
	await run('response-contract-check', [process.execPath, suite('response-contract-check.mjs')]);
	await run('identity-headers-check', [process.execPath, suite('identity-headers-check.mjs')]);
	await run('admin-check', [process.execPath, suite('admin-check.mjs')]);
	await run('canonical-host-check', [process.execPath, suite('canonical-host-check.mjs')]);
	await run('http-pipelining-check', [process.execPath, suite('http-pipelining-check.mjs')]);
	await run('static-preconditions-check', [process.execPath, suite('static-preconditions-check.mjs')]);
	await run('static-cache-control-check', [process.execPath, suite('static-cache-control-check.mjs')]);
	await run('static-text-charset-check', [process.execPath, suite('static-text-charset-check.mjs')]);
	await run('static-date-check', [process.execPath, suite('static-date-check.mjs')]);
	await run('shared-handler-check', [process.execPath, suite('shared-handler-check.mjs')]);
	await run('auth-endpoint-check', [process.execPath, suite('auth-endpoint-check.mjs')]);
	await run('metrics-check', [process.execPath, suite('metrics-check.mjs')]);
	await run('handshake-check', [process.execPath, suite('handshake-check.mjs')]);
	await run('upgrade-response-check', [process.execPath, suite('upgrade-response-check.mjs')]);
	await run('request-signal-check', [process.execPath, suite('request-signal-check.mjs')]);
	await run('request-target-check', [process.execPath, suite('request-target-check.mjs')]);
	// The ./subscriptions entry, imported by the fixture as another package
	// would, moving the built runtime's state.
	await run('subscriptions-check', [process.execPath, suite('subscriptions-check.mjs')]);
	await run('subscription-release-check', [process.execPath, suite('subscription-release-check.mjs')]);
	// The __ entries a Vite plugin adds to the server build, found, bundled and
	// run at startup ahead of the WebSocket handler.
	await run('extra-entries-check', [process.execPath, suite('extra-entries-check.mjs')]);
	// The leak lane's probe route: unreachable on a server that was not armed
	// for it, which is every server this lane boots.
	await run('leak-probe-check', [process.execPath, suite('leak-probe-check.mjs')]);
	// Skips itself on Windows, where the signal never reaches the handler.
	await run('shutdown-check', [process.execPath, suite('shutdown-check.mjs')]);
	await run('shutdown-handler-check', [process.execPath, suite('shutdown-handler-check.mjs')]);
	await run('shutdown-repeat-signal-check', [process.execPath, suite('shutdown-repeat-signal-check.mjs')]);
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

// The request id across the upgrade, with a preload that puts an accessor on
// Object.prototype for the string key it used to ride.
await run('upgrade-carry-check', [process.execPath, suite('upgrade-carry-check.mjs')]);

// The close rule on the wire, read off a raw socket: codes, reasons cut at a
// character, byte reasons, the no-status close and the hard close.
await run('close-frame-check', [process.execPath, suite('close-frame-check.mjs')]);

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

// Its own build for the same shape of reason as the others: the resume flush
// can only be made to refuse a frame by filling the socket, and a backpressure
// limit low enough for a test to fill would change what every other suite's
// server does with a client that reads slowly.
const builtBackpressure = await run('build fixture (WS_BACKPRESSURE)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, WS_BACKPRESSURE: '1' }
});
if (builtBackpressure) {
	await run('resume-backpressure-check', [process.execPath, suite('resume-backpressure-check.mjs')]);
}

// Its own build because its warmup points at a route whose body never ends:
// every other suite's server would pay that render at boot, for a route none
// of them ask about.
const builtWarmupHang = await run('build fixture (WARMUP_HANG)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, WARMUP_HANG: '1' }
});
if (builtWarmupHang) {
	await run('warmup-check', [process.execPath, suite('warmup-check.mjs')]);
}

// Its own build: its probes are spelled with an escape and with router syntax,
// where every other suite probes the default paths.
const builtMountSpelling = await run('build fixture (MOUNT_SPELLING)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, MOUNT_SPELLING: '1' }
});
if (builtMountSpelling) {
	await run('mount-spelling-check', [process.execPath, suite('mount-spelling-check.mjs')]);
}

const builtPrefixed = await run('build fixture (envPrefix)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, FIXTURE_ENV_PREFIX: 'MY_APP_' }
});
if (builtPrefixed) {
	await run('env-prefix-check', [process.execPath, suite('env-prefix-check.mjs')]);
}

const builtBase = await run('build fixture (paths.base)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, FIXTURE_BASE_PATH: '/foo' }
});
if (builtBase) await run('static-base-cache-check', [process.execPath, suite('static-base-cache-check.mjs')]);

if (failures.length) {
	console.log(`\nlive lane FAILED:\n  ${failures.join('\n  ')}`);
	process.exit(1);
}
console.log('\nlive lane passed');
