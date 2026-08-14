// The leak lane. Builds the fixture the same way the live lane does, then runs
// the standing leak gate against it.
//
// SEPARATE FROM `npm run test:live` on purpose: this lane spends minutes by
// design, because a memory slope needs a window to be fitted over, and a gate
// that slow inside the dev loop is a gate people stop running. It has its own
// CI job for the same reason.
//
// Run with: npm run test:leak

import { fileURLToPath } from 'node:url';
// Both from the plan, which is also what the gate reads: a run given a longer
// window must not be killed by a timeout written for the default one, and the
// only way to keep that true is for the bound and the work to come from one
// description rather than two kept in step by hand. Importing it here is also
// what refuses a bad knob or an unknown scenario BEFORE the build.
import { LANE_TIMEOUT_MS } from './plan.mjs';

const fixtureDir = fileURLToPath(new URL('../fixture/', import.meta.url));
const suite = (name) => fileURLToPath(new URL(name, import.meta.url));

// The build has nothing to do with the measurement windows, so it does not
// inherit their bound: at the documented LEAK_DURATION_MS=240000 that would sit
// on a wedged build for twelve minutes before saying anything. It finishes in
// tens of seconds, and this only ever fires on a hang.
const BUILD_TIMEOUT_MS = 180_000;

const failures = [];

async function run(label, cmd, timeoutMs, opts = {}) {
	console.log(`\n== ${label}`);
	const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', ...opts });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try { proc.kill(); } catch {}
	}, timeoutMs);
	const code = await proc.exited;
	clearTimeout(timer);
	if (timedOut) {
		failures.push(`${label} (timed out after ${Math.round(timeoutMs / 1000)}s)`);
		return false;
	}
	if (code !== 0) failures.push(`${label} (exit ${code})`);
	return code === 0;
}

// Pinned for the reason the live lane pins them: any one left exported
// redirects the build, and the gitignored output of an earlier run then stands
// in for a build this lane never produced. WS_ADMISSION matters here more than
// most - it builds a server with a connection ceiling of two, and this lane
// churns connections at a fixed rate against what it believes is an ungated
// one.
const buildEnv = {
	...process.env,
	ADAPTER: 'bunserve',
	NO_WS: '',
	STATIC_DOTFILES: '',
	WS_ADMISSION: '',
	NODE_ENV: 'production'
};

const built = await run('build fixture', [process.execPath, 'run', 'build'], BUILD_TIMEOUT_MS, {
	cwd: fixtureDir,
	env: buildEnv
});
if (built) await run('leak-check', [process.execPath, suite('leak-check.mjs')], LANE_TIMEOUT_MS);

if (failures.length) {
	console.log(`\nleak lane FAILED:\n  ${failures.join('\n  ')}`);
	process.exit(1);
}
console.log('\nleak lane passed');
