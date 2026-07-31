// The live wire-contract lane. Builds the fixture, runs the three WebSocket
// suites against it, then builds the fixture's NO_WS variant and runs the
// no-handler regression. Every suite boots its own server from the built
// output, so this asserts the contract end to end: a change to the demux in
// handler/ws.js that the unit suite cannot see fails here.
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

// Both build-selecting variables are pinned, not just ADAPTER. Either one left
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
	NODE_ENV: 'production'
};

const built = await run('build fixture', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: buildEnv
});
if (built) {
	await run('ws-smoke', [process.execPath, suite('ws-smoke.mjs')]);
	await run('cap-check', [process.execPath, suite('cap-check.mjs')]);
	await run('origin-check', [process.execPath, suite('origin-check.mjs')]);
}

const builtNoWs = await run('build fixture (NO_WS)', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: { ...buildEnv, NO_WS: '1' }
});
if (builtNoWs) {
	await run('no-ws-check', [process.execPath, suite('no-ws-check.mjs')]);
}

if (failures.length) {
	console.log(`\nlive lane FAILED:\n  ${failures.join('\n  ')}`);
	process.exit(1);
}
console.log('\nlive lane passed');
