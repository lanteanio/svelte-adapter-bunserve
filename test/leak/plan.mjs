// What the leak lane is going to do, in one place, because two files need to
// agree about it: `leak-check.mjs` RUNS the scenarios and `run.mjs` has to
// bound how long they may take. Those are the same facts read for different
// reasons, and keeping them apart is what let the runner budget for two
// scenarios while three were running.
//
// Adding a scenario means adding it HERE. The runner's timeout then moves with
// it and cannot silently under-count.

import { knob, TIMER_MAX_MS } from './knob.mjs';

export const PORT = knob('LEAK_PORT', 3799, { integer: true, max: 65_535 });

/** Discarded. The first seconds are JIT, lazy imports and pool growth. */
export const WARMUP_MS = knob('LEAK_WARMUP_MS', 5_000, { max: TIMER_MAX_MS });
/** The measured window. Long enough that a slope has samples to be fitted to. */
export const DURATION_MS = knob('LEAK_DURATION_MS', 60_000, { max: TIMER_MAX_MS });
export const SAMPLE_MS = knob('LEAK_SAMPLE_MS', 2_000, { max: TIMER_MAX_MS });
/**
 * Requests per second, held FIXED: a leak per unit of work needs work at a
 * known rate. Capped because this number also scales the drive loop's in-flight
 * ceiling (`RPS * 4`), which is the guard that stops a server which has stopped
 * answering from OOMing the harness instead of itself - so an absurd rate would
 * both flood the subject and disable the valve that contains the flood.
 */
export const RPS = knob('LEAK_RPS', 50, { max: 100_000 });
/** Lets the collector run and the pools drain before the final reading. */
export const COOLDOWN_MS = knob('LEAK_COOLDOWN_MS', 3_000, { min: 0, max: TIMER_MAX_MS });
/**
 * Worked but UNSAMPLED, between the baseline collection and the measured
 * window. The baseline is taken after forcing the collector to settle, which
 * leaves RSS below where this workload actually runs - and the climb back to
 * that level is steep, linear and completely reproducible. Measured here at
 * 303 KB/s with r-squared 0.996 across three runs: a textbook leak signature
 * produced entirely by having collected just before starting to look.
 *
 * So the window starts once the process has climbed back to its own working
 * set. Nothing about the baseline HEAP reading is affected - that comparison
 * wants the settled value, and gets it. Set it to 0 to watch the artifact.
 */
export const RESETTLE_MS = knob('LEAK_RESETTLE_MS', 8_000, { min: 0, max: TIMER_MAX_MS });
/** The self-check's own window; see that scenario for why it is shorter. */
export const SELFCHECK_MS = knob('LEAK_SELFCHECK_MS', 30_000, { max: TIMER_MAX_MS });

/**
 * A slope through fewer points than this is a cloud, so the verdict refuses a
 * run that collected them rather than believing it.
 */
export const MIN_SAMPLES = 8;

/**
 * How many samples a window of `ms` actually yields, which is NOT
 * `ms / SAMPLE_MS`. The first interval fires at `SAMPLE_MS` rather than at
 * zero, and the firing due at exactly the window's end loses its race with the
 * drive loop's exit. Measured at the defaults: a 30s window at a 2s cadence
 * gives FOURTEEN, and a 20s window gives nine.
 *
 * @param {number} ms
 */
export const samplesFor = (ms) => Math.ceil(ms / SAMPLE_MS) - 1;

/**
 * Every scenario the lane runs, with the window each measures over. The keys
 * are what `LEAK_SCENARIO` selects and what `leak-check.mjs` attaches its
 * workloads to; a key here with no workload there is refused rather than
 * skipped, so the two lists cannot drift apart in silence.
 */
export const SCENARIOS = [
	{ key: 'http', durationMs: DURATION_MS },
	{ key: 'ws', durationMs: DURATION_MS },
	{ key: 'selfcheck', durationMs: SELFCHECK_MS }
];

/**
 * Which scenarios `LEAK_SCENARIO` selects. ONE rule, exported, because the
 * runner budgets for a set and the gate runs a set: two copies of this is how
 * the runner ends up bounding something other than what runs, and the symptom
 * is a lane killed mid-measurement rather than an error anyone can read.
 *
 * @param {string} [only] a single scenario key, or empty for all of them
 */
export function selectScenarios(only = '') {
	if (!only) return SCENARIOS;
	const picked = SCENARIOS.filter((s) => s.key === only);
	if (!picked.length) {
		throw new Error(`LEAK_SCENARIO=${only} matches nothing; known: ${SCENARIOS.map((s) => s.key).join(', ')}`);
	}
	return picked;
}

/**
 * What this process will run. Read once, here, so the runner and the gate
 * cannot disagree - and read BEFORE the fixture is built, so a mistyped
 * scenario name costs a message rather than a build.
 */
export const SELECTED = selectScenarios(process.env.LEAK_SCENARIO || '');

/** Paid once per scenario, whatever its window: see `scenario()`. */
const FIXED_PER_SCENARIO_MS = WARMUP_MS + RESETTLE_MS + COOLDOWN_MS;

/**
 * The measured time the selected scenarios account for. It is not the whole
 * wall clock: server spawn, the settle loops and the port-release sleep are
 * real and uncounted, which is part of what the runner's margin is for.
 */
export const plannedMs = () => SELECTED.reduce((total, s) => total + FIXED_PER_SCENARIO_MS + s.durationMs, 0);

/**
 * Slack over the planned windows, covering the per-scenario overhead above plus
 * a slow runner. It does NOT cover the build, which the runner bounds
 * separately: a build has nothing to do with how long a window was set to.
 */
const LANE_MARGIN_MS = 180_000;

/** What the runner allows the gate before killing it. */
export const LANE_TIMEOUT_MS = plannedMs() + LANE_MARGIN_MS;

// Refused up front rather than after minutes of work, and only for the
// scenarios that will actually run: too few samples is a health failure, a
// health failure refuses the self-check outright, and a cadence that cannot
// fill a window would otherwise turn a documented knob into a lane that builds
// the fixture, runs its scenarios and only then reports that it measured
// nothing.
for (const { key, durationMs } of SELECTED) {
	const got = samplesFor(durationMs);
	if (got < MIN_SAMPLES) {
		throw new Error(
			`the ${key} window of ${durationMs}ms at LEAK_SAMPLE_MS=${SAMPLE_MS} yields ${got} samples, `
			+ `and the verdict refuses fewer than ${MIN_SAMPLES}; widen it to at least `
			+ `${(MIN_SAMPLES + 1) * SAMPLE_MS}ms or shorten the cadence.`
		);
	}
}

// Refused rather than clamped. Silently capping at the timer's ceiling would
// bound the lane BELOW the work it was asked to do - killing a run it knows
// cannot finish in time, and reporting it as a timeout rather than as the
// impossible request it was.
if (LANE_TIMEOUT_MS > TIMER_MAX_MS) {
	throw new Error(
		`the selected windows need ${LANE_TIMEOUT_MS}ms, past the ${TIMER_MAX_MS}ms a timer can express; `
		+ 'shorten a window or run one scenario at a time.'
	);
}
