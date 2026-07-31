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

async function run(label, cmd, opts = {}) {
	console.log(`\n== ${label}`);
	const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', ...opts });
	const code = await proc.exited;
	if (code !== 0) failures.push(`${label} (exit ${code})`);
	return code === 0;
}

// ADAPTER is pinned so an exported ADAPTER=node in the shell cannot make the
// lane assert some other adapter's build.
const buildEnv = { ...process.env, ADAPTER: 'bunserve' };

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
