// The leak lane. Builds the fixture the same way the live lane does, then runs
// the standing leak gate against it.
//
// SEPARATE FROM `npm run test:live` on purpose: this lane spends minutes by
// design, because a memory slope needs a window to be fitted over, and a gate
// that slow inside the dev loop is a gate people stop running. It has its own
// CI job for the same reason.
//
// Run with: npm run test:leak
//   npm run test:leak -- --scenario ws       one scenario
//   npm run test:leak -- --minutes 2         shorter window (1..60 minutes)
//   npm run test:leak -- --out <dir>         where the record is written
//
// EXIT CODES are the gate's: 0 clean, 1 the server's problem, 2 the lane's.
// A build that fails or a gate that has to be killed is the lane's problem.

import { fileURLToPath } from 'node:url';
// From the plan, which is also what the gate reads: a run given a longer
// window must not be killed by a timeout written for the default one, and the
// only way to keep that true is for the bound and the work to come from one
// description rather than two kept in step by hand. Importing it here is also
// what refuses a bad flag or an unknown scenario BEFORE the build.
import { FIXTURE_DIR, LANE_TIMEOUT_MS } from './plan.mjs';

const suite = (name) => fileURLToPath(new URL(name, import.meta.url));

// The build has nothing to do with the measurement windows, so it does not
// inherit their bound: at `--minutes 8` that would sit on a wedged build for
// most of an hour before saying anything. It finishes in tens of seconds, and
// this only ever fires on a hang.
const BUILD_TIMEOUT_MS = 180_000;

const failures = [];

/**
 * @returns {Promise<number>} the step's exit code, or -1 when it was killed
 */
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
		return -1;
	}
	if (code !== 0) failures.push(`${label} (exit ${code})`);
	return code;
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
	cwd: FIXTURE_DIR,
	env: buildEnv
});

// The gate's own exit code passes through, since 1 and 2 mean different
// things to CI. Everything that stops the gate from reaching a verdict at all
// - a build that failed or hung, a gate that had to be killed - is 2. The
// flags pass through unchanged, so the gate parses the same plan this runner
// just bounded.
let code = 2;
if (built === 0) {
	const gate = await run('leak-check', [process.execPath, suite('leak-check.mjs'), ...process.argv.slice(2)], LANE_TIMEOUT_MS);
	code = gate === 1 ? 1 : gate === 0 ? 0 : 2;
}

if (failures.length) {
	console.log(`\nleak lane FAILED:\n  ${failures.join('\n  ')}`);
	process.exit(code);
}
console.log('\nleak lane passed');
