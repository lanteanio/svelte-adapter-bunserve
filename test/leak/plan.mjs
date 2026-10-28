// What the leak lane is going to do, in one place, because two files need to
// agree about it: `leak-check.mjs` RUNS the scenarios and `run.mjs` has to
// bound how long they may take. Those are the same facts read for different
// reasons, and keeping them apart is what let the runner budget for two
// scenarios while three were running.
//
// The flags and the scenario keys are the svelte-adapter-uws lane's, spelled
// its way, so one command drives either lane:
//
//   npm run test:leak                        all scenarios, default window
//   npm run test:leak -- --scenario ws       one scenario
//   npm run test:leak -- --minutes 2         shorter window (1..60 minutes)
//   npm run test:leak -- --out <dir>         where the record is written
//
// The timings below are this runtime's calibration and are NOT flags. What
// the family agrees on is the shape of the measurement - warm, collect,
// resettle unsampled, settle until steady, then a window - and the verdict
// rules in `rules.mjs`; how long each phase needs is a property of the
// allocator under it, and JavaScriptCore's is not V8's. Each constant says
// what it was set from.
//
// A bad flag is refused HERE, at import, with the lane's exit code for "the
// lane could not run" (2) rather than a stack trace and a 1: the runner
// imports this before the build, so a typo costs a message rather than a
// build, and CI reads the failure as the lane's rather than the server's.

import { fileURLToPath } from 'node:url';
import { numberFlag, parseFlags, refuseUnknownFlags, stringFlag, TIMER_MAX_MS } from './knob.mjs';
import { websocketOptions } from '../fixture/websocket-options.mjs';

/**
 * @template T
 * @param {() => T} read
 * @returns {T}
 */
function refusing(read) {
	try {
		return read();
	} catch (err) {
		console.error(`[leak-lane] ${err.message}`);
		process.exit(2);
	}
}

const FLAGS = refusing(() => {
	const flags = parseFlags(process.argv.slice(2));
	refuseUnknownFlags(flags, ['minutes', 'scenario', 'out']);
	return flags;
});

export const PORT = 3799;

/**
 * Load applied before anything is measured, so the working set is filled
 * first. Sixty seconds, the uws lane's figure. Its V8 process reaches the
 * working set in steps - a plateau held for half a minute, then a jump - and
 * a window opened after twenty seconds read that staircase as a climb. Bun's
 * allocator climbs steeply and decelerates rather than stepping, but the same
 * minute costs nothing the settle loop below does not already spend, and one
 * figure across the family keeps the records comparable.
 */
export const WARMUP_MS = 60_000;

/**
 * Worked but UNSAMPLED after the baseline collection, before the settle loop
 * begins. The baseline is taken after forcing the collector, which leaves RSS
 * below where this workload actually runs - and the climb back is steep,
 * linear and completely reproducible. Measured on this runtime at 303 KB/s
 * with r-squared 0.996 across three runs: a textbook leak signature produced
 * entirely by having collected just before starting to look. Twenty seconds,
 * the uws lane's figure.
 */
export const RESETTLE_MS = 20_000;

/**
 * The settle loop: rounds of this length, each ending in an unforced memory
 * reading, until the reading has held inside a band for this many rounds in a
 * row. The band is relative with an absolute floor, because a 400 MiB working
 * set wobbling by 3 MiB is as settled as a 100 MiB one wobbling by 1.
 *
 * EIGHT consecutive rounds - half a minute of not moving - is the uws lane's
 * rule, set against V8's plateaus: two or three rounds inside the band were
 * satisfied by the middle of a plateau and opened the window just before the
 * next step. Kept here as spelled, so the two lanes open their windows on the
 * same definition of steady. Measured here: http settles in 19 rounds, ws in
 * 9 or 10, a clean server under the self-check's warm traffic in 9 to 14.
 */
export const SETTLE_ROUND_MS = 4_000;
export const SETTLE_STABLE_ROUNDS = 8;
export const SETTLE_MAX_ROUNDS = 30;
export const SETTLE_BAND_BYTES = 2 * 1024 * 1024;
export const SETTLE_BAND_RATIO = 0.01;

/** Window sample cadence. One reading per slice of this length. */
export const SAMPLE_MS = 2_000;

/**
 * Requests per second, held FIXED: a leak per unit of work needs work at a
 * known rate. This number also scales the drive loop's in-flight ceiling
 * (`RPS * 4`), the guard that stops a server which has stopped answering from
 * OOMing the harness instead of itself.
 */
export const RPS = 50;
export const WS_RPS = 200;
export const WS_CLIENTS = 4;
const { upgradeRateLimit = 10, upgradeRateLimitWindow = 10 } = websocketOptions;
export const CHURN_RPS = upgradeRateLimit === 0
	? 50 : Math.max(1, Math.floor(0.8 * upgradeRateLimit / upgradeRateLimitWindow));

/**
 * HTTP connections the lane holds at once. Keepalive, always: a fresh
 * connection per request grows sockets and buffers in step with the request
 * count, which reads as a leak and is not one. Four is the uws lane's figure
 * (four agents of one socket each); Bun's fetch has no per-agent socket cap,
 * so the lane holds the count with a semaphore instead, and a unit that has
 * to wait for a slot pays that wait in its latency the way a queued request
 * on a capped agent does.
 */
export const HTTP_CLIENTS = 4;

/** Lets the pools drain before the final reading, for the connections gate. */
export const COOLDOWN_MS = 3_000;

/**
 * Bounds on one probe read. The forced collection gets the longer bound
 * because it is a synchronous full GC and is genuinely slower than a read; on
 * this runtime it has never needed more than a fraction of a second, so the
 * ceiling is a hang detector rather than a budget.
 */
export const PROBE_TIMEOUT_MS = 5_000;
export const GC_PROBE_TIMEOUT_MS = 15_000;
/** Forced collections a settled reading may take before it gives up. */
export const SETTLED_PROBE_ROUNDS = 8;

/** Measurement window per scenario. `--minutes`, finite number from 1 to 60, default 3. */
export const MINUTES = refusing(() => numberFlag(FLAGS, 'minutes', 3, { max: 60 }));
export const WINDOW_MS = MINUTES * 60_000;

/**
 * Where a run leaves its record. A gitignored directory inside the lane by
 * default, so a run on any machine writes somewhere it is allowed to and a
 * record is never committed by accident; `--out` puts it wherever the
 * records of the other runtime's lane are kept.
 */
export const OUT_DIR = refusing(() => stringFlag(FLAGS, 'out', fileURLToPath(new URL('./records/', import.meta.url))));

/**
 * Every scenario the lane runs. The keys are what `--scenario` selects and
 * what `leak-check.mjs` attaches its workloads to; a key here with no
 * workload there is refused rather than skipped, so the two lists cannot
 * drift apart in silence.
 */
export const SCENARIOS = ['http', 'ws', 'churn', 'selfcheck'];

/**
 * Which scenarios `--scenario` selects. ONE rule, exported, because the runner
 * budgets for a set and the gate runs a set: two copies of this is how the
 * runner ends up bounding something other than what runs, and the symptom is
 * a lane killed mid-measurement rather than an error anyone can read.
 *
 * @param {string} only a scenario key, or `all`
 */
export function selectScenarios(only) {
	if (only === 'all') return SCENARIOS;
	if (!SCENARIOS.includes(only)) {
		throw new Error(`unknown scenario "${only}" - one of: ${SCENARIOS.join(', ')}, or all`);
	}
	return [only];
}

/**
 * What this process will run. Read once, here, so the runner and the gate
 * cannot disagree - and read BEFORE the fixture is built, so a mistyped
 * scenario name costs a message rather than a build.
 */
export const SELECTED = refusing(() => selectScenarios(stringFlag(FLAGS, 'scenario', 'all')));

/** The fixture the lane drives. */
export const FIXTURE_DIR = fileURLToPath(new URL('../fixture/', import.meta.url));

/**
 * Paid once per scenario, whatever its window. The settle loop is budgeted at
 * its maximum, and so are the settled probes at both ends - every forced
 * collection at its own ceiling - because a scenario that needed all of that
 * is precisely the one the runner must not kill before it can say so.
 */
const SETTLED_PROBES_WORST_MS = 2 * SETTLED_PROBE_ROUNDS * (GC_PROBE_TIMEOUT_MS + PROBE_TIMEOUT_MS + 200);
const FIXED_PER_SCENARIO_MS =
	WARMUP_MS + RESETTLE_MS + SETTLE_MAX_ROUNDS * SETTLE_ROUND_MS + COOLDOWN_MS + SETTLED_PROBES_WORST_MS;

/**
 * The measured time the selected scenarios account for. It is not the whole
 * wall clock: server spawn and the port-release sleep are real and uncounted,
 * which is part of what the runner's margin is for.
 */
export const plannedMs = () => SELECTED.length * (FIXED_PER_SCENARIO_MS + WINDOW_MS);

/**
 * Slack over the planned windows, covering the per-scenario overhead above plus
 * a slow runner. It does NOT cover the build, which the runner bounds
 * separately: a build has nothing to do with how long a window was set to.
 */
const LANE_MARGIN_MS = 180_000;

/** What the runner allows the gate before killing it. */
export const LANE_TIMEOUT_MS = plannedMs() + LANE_MARGIN_MS;

// Refused rather than clamped. Silently capping at the timer's ceiling would
// bound the lane BELOW the work it was asked to do - killing a run it knows
// cannot finish in time, and reporting it as a timeout rather than as the
// impossible request it was.
if (LANE_TIMEOUT_MS > TIMER_MAX_MS) {
	console.error(
		`[leak-lane] the selected windows need ${LANE_TIMEOUT_MS}ms, past the ${TIMER_MAX_MS}ms a timer can express; `
		+ 'shorten --minutes or run one scenario at a time.'
	);
	process.exit(2);
}
