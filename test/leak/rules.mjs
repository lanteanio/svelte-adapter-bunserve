// The leak lane's verdict rules. Pure, exported, and unit-tested in
// test/unit/leak-lane-rules.test.mjs so the rules can be driven in
// milliseconds while the lane itself spends minutes. A rule nobody can
// exercise cheaply is a rule that rots.
//
// This is the svelte-adapter-uws lane's verdict, gate for gate and constant
// for constant: the growth gate is its `detectGrowth` kernel with the same
// tolerance, slope floor and fit-quality vote, and the error-rate and p95
// ceilings are its numbers. `judge()` returns the same record shape and
// `selfCheckVerdict()` types the self-check on the same gate. What a record
// from either runtime says, it says in the same words.
//
// RETENTION AND CONNECTIONS complement RSS in both runtimes. They measure
// signals the resident set cannot give:
//
//   RETENTION. Heap plus external, read after forcing the collector until two
//   readings agree, at both ends of the run. What survives a settled collection
//   is held on purpose by something, and on this runtime the figure is
//   single-digit MB reproducible to a tenth of a percent - so a retained
//   megabyte is a large fraction of it. RSS cannot be read this way: Bun's
//   allocator keeps arenas it will never return, and climbs toward a
//   working-set plateau that reads exactly like a leak over a short window.
//   Measured: 64 KB retained per connection over a thousand connections moved
//   heapUsed by 3.8% and this by 498%, since a typed array lives outside the
//   JS heap and buffers are what a server retains.
//
//   CONNECTIONS. The live WebSocket count after every client has closed. A
//   close path that fails to release leaves connections registered while the
//   allocator quietly reuses their pages, so memory looks flat.
//
// Both gates are part of the family verdict. An unreadable connection count
// is an instrument failure, never evidence that all connections closed.

import { detectGrowth } from './leak-detect.js';

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
 * retained megabyte count on a runtime whose settled heap is single-digit
 * megabytes; the byte floor is what stops a bounded structure filling once
 * from reading as a leak on a small baseline. Measured on this runtime: the
 * ws churn retains the same 1.1 MiB whether the window is three minutes or
 * eight (9,000 or 24,000 connections), which is a structure reaching its
 * bound, not growth per connection - a per-connection leak would have
 * tripled. The http run retains 0.1 MiB. Against a 4.8 MiB baseline the ws
 * fill is 24%, so the ratio alone sat six points under its ceiling with a
 * denominator that shrinks on every Bun release that trims the idle heap.
 * See the README's calibration table.
 */
export const MAX_RETAINED_GROWTH = 0.3;
export const RETAINED_TOLERANCE_BYTES = 2 * 1024 * 1024;
/**
 * A slope through fewer samples than this is a cloud. The kernel refuses to
 * fit one and reports `insufficient-samples`, which is a not-leaking verdict;
 * the lane must not let that read as a pass, so the same floor is a health
 * failure here, matching the family lane's sample floor.
 */
export const MIN_SAMPLES = 8;

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
 * What the retention gate compares: heap PLUS external.
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
 * `failures` are the server's problem; `health` means this run did not
 * MEASURE anything - the instrument failed, so its silence proves nothing.
 * The distinction is what the exit codes rest on.
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
		// it wanders by several MiB between samples while the collector runs,
		// so a genuinely leaking server still steps backwards a third of the
		// time. Demanding 90% non-decreasing samples would make this gate
		// unable to fire, which is worse than no gate. The fit quality is what
		// carries the noise judgment here instead.
		minMonotonicFraction: 0
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
	if (m.rss.length < MIN_SAMPLES) health.push(`only ${m.rss.length} resident-set sample(s): too short a window to fit anything`);
	if (p95Creep === null) health.push('no warmed baseline latency, so the creep gate could not run');
	// A settle loop that exhausted its rounds returned whichever reading it
	// happened to stop on, so the retention comparison - the sensitive gate -
	// was made against a number that does not mean "still retained".
	if (m.retained && !m.retained.settled) health.push('retention never settled at one end of the run, so the retained comparison is noise');
	if ('connectionsAfter' in m && !(Number.isInteger(m.connectionsAfter) && m.connectionsAfter >= 0)) {
		health.push('the live WebSocket count after cooldown could not be read');
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
	if (errorRate > maxErrorRate) {
		failures.push(`${(errorRate * 100).toFixed(2)}% of ${m.requests} requests failed, over the ${(maxErrorRate * 100).toFixed(2)}% ceiling`);
	}
	if (p95Creep !== null && p95Creep > maxP95Creep) {
		failures.push(
			`p95 latency crept ${(p95Creep * 100).toFixed(0)}% (${m.baselineP95.toFixed(1)}ms warmed to ${m.windowP95.toFixed(1)}ms), ` +
			`over the ${(maxP95Creep * 100).toFixed(0)}% ceiling`
		);
	}
	// After the cooldown every client the scenario opened has closed, so a
	// connection still registered is one the close path did not release.
	if (Number.isInteger(m.connectionsAfter) && m.connectionsAfter > 0) {
		failures.push(`${m.connectionsAfter} WebSocket connection(s) still registered after cooldown; every client had closed`);
	}

	// `retained` is present only when it was measured, so a record judged
	// without it has exactly the uws record's keys.
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
 * The retention gate does not count either, and for the same reason from the
 * other side: it measures a different signal, and a self-check satisfied by it
 * would certify a lane whose FAMILY gate had gone blind.
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
