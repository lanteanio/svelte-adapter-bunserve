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
import { knob } from './knob.mjs';

const fixtureDir = fileURLToPath(new URL('../fixture/', import.meta.url));
const suite = (name) => fileURLToPath(new URL(name, import.meta.url));

// The measured windows are configurable, so the bound has to be derived rather
// than fixed: a run given a longer window must not be killed by a timeout that
// was written for the default one. Two scenarios, plus warmup and cooldown
// each, plus a wide margin for the build and a slow runner.
const fixedMs = knob('LEAK_WARMUP_MS', 5_000)
	+ knob('LEAK_RESETTLE_MS', 8_000)
	+ knob('LEAK_COOLDOWN_MS', 3_000);
// Two measured scenarios plus the self-check, each carrying that fixed
// overhead, plus a wide margin for the build and a slow runner. The
// self-check's window is its own knob and has to be counted: budgeting for
// two scenarios when three run is how a documented setting becomes a
// guaranteed timeout.
const STEP_TIMEOUT_MS = 3 * fixedMs
	+ 2 * knob('LEAK_DURATION_MS', 60_000)
	+ knob('LEAK_SELFCHECK_MS', 30_000)
	+ 180_000;

const failures = [];

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
		failures.push(`${label} (timed out after ${Math.round(STEP_TIMEOUT_MS / 1000)}s)`);
		return false;
	}
	if (code !== 0) failures.push(`${label} (exit ${code})`);
	return code === 0;
}

// Pinned for the reason the live lane pins them: either variable left exported
// redirects the build, and the gitignored output of an earlier run then stands
// in for a build this lane never produced.
const buildEnv = {
	...process.env,
	ADAPTER: 'bunserve',
	NO_WS: '',
	STATIC_DOTFILES: '',
	NODE_ENV: 'production'
};

const built = await run('build fixture', [process.execPath, 'run', 'build'], {
	cwd: fixtureDir,
	env: buildEnv
});
if (built) await run('leak-check', [process.execPath, suite('leak-check.mjs')]);

if (failures.length) {
	console.log(`\nleak lane FAILED:\n  ${failures.join('\n  ')}`);
	process.exit(1);
}
console.log('\nleak lane passed');
