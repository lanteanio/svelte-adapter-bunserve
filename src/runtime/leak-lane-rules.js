import { detectGrowth, DEFAULT_MIN_SAMPLES as MIN_SAMPLES } from './leak-detect.js';

/** Fit quality below which a slope is not evidence of anything. */
export const MIN_R_SQUARED = 0.5;
/** Share of requests allowed to fail across a window. */
export const MAX_ERROR_RATE = 0.005;
/** How much the window's p95 may exceed the warmed baseline's. */
export const MAX_P95_CREEP = 0.5;
/** Bytes of resident growth across the window that count as flat. */
export const RSS_TOLERANCE_BYTES = 16 * 1024 * 1024;
/** Bytes per sample below which a slope is not worth escalating. */
export const RSS_MIN_SLOPE_BYTES = 256 * 1024;
/**
 * How much settled retention may grow across the run, as a share of the
 * baseline AND in bytes: both must be exceeded. The ratio is what makes a
 * retained megabyte count against a small settled heap; the byte floor is what
 * stops a bounded structure filling once from reading as a leak.
 */
export const MAX_RETAINED_GROWTH = 0.3;
export const RETAINED_TOLERANCE_BYTES = 2 * 1024 * 1024;
/** Load applied before anything is measured, so the working set is filled first. */
export const WARMUP_MS = 60000;
/** Worked but unsampled after the forced collection, before the settle probe begins. */
export const RESETTLE_MS = 20000;
/** Idle time after the window before the final reading, so every client has finished closing. */
export const COOLDOWN_MS = 3000;
/** Forced collections a settled reading may take before it is reported unsettled. */
export const SETTLED_PROBE_ROUNDS = 8;
/** Two consecutive settled readings agreeing within this share are one reading. */
export const SETTLED_PROBE_TOLERANCE = 0.02;

/**
 * @param {number[]} values
 * @param {number} p in [0,1]
 */
export function quantile(values, p) {
	if (values.length === 0) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * What the retention gate compares: heap PLUS external. A Buffer lives outside
 * the JS heap, and buffers are what a server retains.
 *
 * @param {{ heapUsed: number, external?: number }} p
 */
export const retainedBytes = (p) => p.heapUsed + (p.external || 0);

/**
 * Turn one scenario's measurements into a verdict.
 *
 * Every gate is reported whether or not it fired, because "no leak" is only
 * meaningful next to what else was true at the time: a window that lost 4% of
 * its requests has not proved the memory is flat, it has proved the server
 * stopped answering.
 *
 * Two gates read what the resident set cannot show. RETAINED compares heap
 * plus external after forced collections at both ends of the run: what
 * survives a settled collection is held by something, while the resident set
 * also carries allocator pages nothing holds. CONNECTIONS reads the live
 * WebSocket count after the cooldown, when every client the scenario opened
 * has closed: one still registered is one the close path did not release,
 * which memory hides when the allocator reuses its pages.
 *
 * @param {{
 *   rss: number[],
 *   errors: number,
 *   requests: number,
 *   baselineP95: number,
 *   windowP95: number,
 *   settled: boolean,
 *   retained?: { baseline: number, final: number, settled: boolean },
 *   connectionsAfter?: number
 * }} m
 * @param {{ minRSquared?: number, maxErrorRate?: number, maxP95Creep?: number, tolerance?: number, minSlope?: number, maxRetainedGrowth?: number, retainedTolerance?: number }} [opts]
 */
export function judge(m, opts = {}) {
	const minRSquared = opts.minRSquared ?? MIN_R_SQUARED;
	const maxErrorRate = opts.maxErrorRate ?? MAX_ERROR_RATE;
	const maxP95Creep = opts.maxP95Creep ?? MAX_P95_CREEP;
	const maxRetainedGrowth = opts.maxRetainedGrowth ?? MAX_RETAINED_GROWTH;
	const retainedTolerance = opts.retainedTolerance ?? RETAINED_TOLERANCE_BYTES;

	const growth = detectGrowth(m.rss, {
		warmup: 0,
		tolerance: opts.tolerance ?? RSS_TOLERANCE_BYTES,
		minSlope: opts.minSlope ?? RSS_MIN_SLOPE_BYTES,
		minRSquared,
		// The kernel's monotonic vote is switched OFF here, deliberately. It was
		// built for the simulator's structural sizes - a Map that leaks really
		// does only grow - and a resident set does not behave that way at all:
		// it wanders by several MiB between samples while V8 collects, so a
		// genuinely leaking server still steps backwards a third of the time.
		// Demanding 90% non-decreasing samples would make this gate unable to
		// fire, which is worse than no gate. The fit quality is what carries the
		// noise judgment here instead.
		minMonotonicFraction: LEAK_LANE_THRESHOLDS.minMonotonicFraction,
		minSamples: LEAK_LANE_THRESHOLDS.minSamples
	});

	const errorRate = m.requests > 0 ? m.errors / m.requests : 0;
	// A baseline of zero cannot be exceeded by any multiple of itself, so a
	// missing baseline is a health problem rather than a passing creep gate.
	const p95Creep = m.baselineP95 > 0 ? (m.windowP95 - m.baselineP95) / m.baselineP95 : null;

	/** @type {{ baseline: number, final: number, delta: number, ratio: number, leaking: boolean } | null} */
	let retained = null;
	if (m.retained) {
		const delta = m.retained.final - m.retained.baseline;
		const ratio = m.retained.baseline > 0 ? delta / m.retained.baseline : 0;
		retained = {
			baseline: m.retained.baseline, final: m.retained.final, delta, ratio,
			leaking: ratio > maxRetainedGrowth && delta > retainedTolerance
		};
	}

	/** @type {string[]} */
	const failures = [];
	/** @type {string[]} */
	const health = [];

	if (!m.settled) health.push('the resident set never settled before the window opened, so nothing measured here is a baseline');
	if (m.rss.length < LEAK_LANE_THRESHOLDS.minSamples) health.push(`only ${m.rss.length} resident-set sample(s): the growth fit needs ${LEAK_LANE_THRESHOLDS.minSamples}, so it could not judge`);
	if (p95Creep === null) health.push('no warmed baseline latency, so the creep gate could not run');
	// A settle loop that ran out of rounds returned whichever reading it stopped
	// on, so the comparison was made against a number that does not mean "still
	// retained".
	if (m.retained && !m.retained.settled) health.push('retention never settled at one end of the run, so the retained comparison is noise');
	// A count the probe could not read is not zero: reporting it as a pass is a
	// gate that cannot fail.
	if ('connectionsAfter' in m && !(Number.isInteger(m.connectionsAfter) && m.connectionsAfter >= 0)) {
		health.push('the probe could not read the live connection count, so the connections gate did not run');
	}

	if (growth.leaking) {
		failures.push(
			`resident set grew ${(growth.delta / 1048576).toFixed(1)} MiB over ${growth.n} samples ` +
			`(slope ${(growth.slope / 1024).toFixed(0)} KiB/sample, r-squared ${growth.rSquared.toFixed(2)}, ` +
			`monotonic ${(growth.monotonicFraction * 100).toFixed(0)}%)`
		);
	}
	if (retained && retained.leaking) {
		failures.push(
			`retained (heap+external) grew ${(retained.ratio * 100).toFixed(1)}% across the run ` +
			`(${(retained.baseline / 1048576).toFixed(1)} MiB settled to ${(retained.final / 1048576).toFixed(1)} MiB), ` +
			`over the ${(maxRetainedGrowth * 100).toFixed(0)}% and ${(retainedTolerance / 1048576).toFixed(0)} MiB ceilings`
		);
	}
	if (Number.isInteger(m.connectionsAfter) && m.connectionsAfter > 0) {
		failures.push(`${m.connectionsAfter} WebSocket connection(s) still registered after cooldown; every client had closed`);
	}
	if (errorRate > maxErrorRate) {
		failures.push(`${(errorRate * 100).toFixed(2)}% of ${m.requests} requests failed, over the ${(maxErrorRate * 100).toFixed(2)}% ceiling`);
	}
	if (p95Creep !== null && p95Creep > maxP95Creep) {
		failures.push(
			`p95 latency crept ${(p95Creep * 100).toFixed(0)}% (${m.baselineP95.toFixed(1)}ms warmed to ${m.windowP95.toFixed(1)}ms), ` +
			`over the ${(maxP95Creep * 100).toFixed(0)}% ceiling`
		);
	}

	return { growth, ...(retained ? { retained } : {}), errorRate, p95Creep, failures, health, failing: failures.length > 0 };
}

/**
 * The self-check's own verdict, TYPED on the gate under test.
 *
 * The planted defect is memory growth, so only the growth gate detecting it
 * proves the lane can see one. `record.failing` alone is not detection: a
 * deliberately leaking server can also shed requests or creep its p95, and a
 * self-check that accepted any failing verdict would pass while the growth
 * gate itself was blind - the exact quiet death the scenario exists to catch.
 *
 * The retention gate does not count either, although the planted buffers trip
 * it: a self-check it satisfied would certify a lane whose growth gate, the one
 * every runtime in the family shares, had gone blind.
 *
 * @param {{ growth?: { leaking?: boolean }, failing?: boolean, failures?: string[] }} record
 * @returns {{ pass: boolean, reason: string }}
 */
export function selfCheckVerdict(record) {
	if (record.growth && record.growth.leaking === true) {
		return { pass: true, reason: 'the planted leak was detected by the growth gate' };
	}
	if (record.failing) {
		return {
			pass: false,
			reason: 'the verdict failed (' + (record.failures || []).join('; ') +
				') but the planted memory growth itself went undetected, so the growth gate cannot be trusted'
		};
	}
	return { pass: false, reason: 'a deliberate leak went undetected, so no other verdict here can be trusted' };
}

export const LEAK_LANE_THRESHOLDS = Object.freeze({
	minWindowMinutes: 1,
	maxWindowMinutes: 60,
	minSamples: MIN_SAMPLES,
	minRSquared: MIN_R_SQUARED,
	minMonotonicFraction: 0,
	maxErrorRate: MAX_ERROR_RATE,
	maxP95Creep: MAX_P95_CREEP,
	rssToleranceBytes: RSS_TOLERANCE_BYTES,
	rssMinSlopeBytes: RSS_MIN_SLOPE_BYTES,
	maxRetainedGrowth: MAX_RETAINED_GROWTH,
	retainedToleranceBytes: RETAINED_TOLERANCE_BYTES,
	warmupMs: WARMUP_MS,
	resettleMs: RESETTLE_MS,
	cooldownMs: COOLDOWN_MS,
	settledProbeRounds: SETTLED_PROBE_ROUNDS,
	settledProbeTolerance: SETTLED_PROBE_TOLERANCE
});
