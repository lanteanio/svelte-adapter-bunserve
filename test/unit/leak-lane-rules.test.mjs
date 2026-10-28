// The leak lane's verdict rules, driven in milliseconds.
//
// The lane itself spends minutes by design - a slope needs a window - so its
// rules are pure functions that can be exercised without one. This file is what
// keeps them honest: every rule is asserted from BOTH sides, because a gate
// that only ever sees the shape it is supposed to reject is indistinguishable
// from a gate that rejects everything.
//
// The series below are the two the lane exists to tell apart, and they are
// deliberately close: a flat-but-noisy resident set that a least-squares line
// still tilts through, and a real climb. Slope alone cannot separate them,
// which is why the fit quality is a vote.
//
// The cases and the series are the svelte-adapter-uws lane's, so a verdict
// rule that drifts from that lane's fails here before it can fail a nightly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	judge, selfCheckVerdict, quantile, retainedBytes,
	MIN_R_SQUARED, MAX_ERROR_RATE, MAX_P95_CREEP, MAX_RETAINED_GROWTH, MIN_SAMPLES, RETAINED_TOLERANCE_BYTES,
	RSS_TOLERANCE_BYTES
} from '../leak/rules.mjs';
import { detectGrowth } from '../leak/leak-detect.js';

const MiB = 1048576;

/** A resident set holding its working set, wandering a few MiB either way. */
const NOISY_FLAT = [220, 231, 218, 236, 222, 229, 217, 234, 226, 219, 233, 221, 228, 235, 223]
	.map((mb) => mb * MiB);

/** A real climb: the same noise riding a steady 8 MiB per sample. */
const CLIMBING = NOISY_FLAT.map((v, i) => v + i * 8 * MiB);

/** The healthy case, with a settled baseline and a clean window. */
const HEALTHY = {
	rss: NOISY_FLAT, errors: 2, requests: 6000,
	baselineP95: 12, windowP95: 13, settled: true
};

describe('the leak lane reaches a verdict the way it says it does', () => {
	test('calls a noisy but flat resident set clean', () => {
		const verdict = judge(HEALTHY);
		assert.equal(verdict.failing, false);
		assert.deepEqual(verdict.health, []);
		assert.equal(verdict.growth.leaking, false);
	});

	test('calls a real climb a leak, and says by how much', () => {
		const verdict = judge({ ...HEALTHY, rss: CLIMBING });
		assert.equal(verdict.failing, true);
		assert.equal(verdict.growth.leaking, true);
		assert.match(verdict.failures[0], /resident set grew/);
	});

	test('needs the fit to explain the samples, not merely to tilt', () => {
		// The discriminator, isolated: the flat series' least-squares line has a
		// slope, and taking the fit quality away is enough to make it a leak.
		// If this ever passes with the r-squared vote in place, the vote has
		// stopped voting.
		const withoutFit = detectGrowth(NOISY_FLAT, {
			warmup: 0, tolerance: 0, minSlope: 0, minMonotonicFraction: 0, minRSquared: 0
		});
		const withFit = detectGrowth(NOISY_FLAT, {
			warmup: 0, tolerance: 0, minSlope: 0, minMonotonicFraction: 0, minRSquared: MIN_R_SQUARED
		});
		assert.ok(withoutFit.rSquared < MIN_R_SQUARED);
		assert.equal(withFit.reason, 'fit-too-poor');
		assert.equal(withFit.leaking, false);
	});

	test('keeps the fit vote from swallowing a genuine climb', () => {
		const climb = detectGrowth(CLIMBING, {
			warmup: 0, tolerance: RSS_TOLERANCE_BYTES, minSlope: 0, minMonotonicFraction: 0, minRSquared: MIN_R_SQUARED
		});
		assert.ok(climb.rSquared > MIN_R_SQUARED);
		assert.equal(climb.leaking, true);
	});

	test('fails a window that lost more requests than the ceiling allows', () => {
		const belowCeiling = judge({ ...HEALTHY, errors: 29, requests: 6000 });
		const overCeiling = judge({ ...HEALTHY, errors: 31, requests: 6000 });
		assert.ok(29 / 6000 < MAX_ERROR_RATE);
		assert.equal(belowCeiling.failing, false);
		assert.equal(overCeiling.failing, true);
		assert.match(overCeiling.failures[0], /requests failed/);
	});

	test('fails a window whose p95 crept past the warmed baseline', () => {
		const under = judge({ ...HEALTHY, baselineP95: 10, windowP95: 14.9 });
		const over = judge({ ...HEALTHY, baselineP95: 10, windowP95: 15.1 });
		assert.equal(MAX_P95_CREEP, 0.5);
		assert.equal(under.failing, false);
		assert.equal(over.failing, true);
		assert.match(over.failures[0], /p95 latency crept/);
	});

	test('reports an unsettled baseline as a health problem, not as a pass', () => {
		// The distinction the exit codes rest on: the lane not knowing is not the
		// same as the server being clean, and a lane that conflates them reports
		// green on every run where the measurement fell apart.
		const verdict = judge({ ...HEALTHY, settled: false });
		assert.equal(verdict.failing, false);
		assert.match(verdict.health.join(' '), /never settled/);
	});

	test('reports a missing latency baseline rather than passing the creep gate on it', () => {
		const verdict = judge({ ...HEALTHY, baselineP95: 0, windowP95: 900 });
		assert.equal(verdict.p95Creep, null);
		assert.match(verdict.health.join(' '), /no warmed baseline/);
	});

	test('reports a window too short to fit anything', () => {
		const verdict = judge({ ...HEALTHY, rss: [220 * MiB] });
		assert.match(verdict.health.join(' '), /too short a window/);
	});

	test('holds the health floor at the samples the kernel refuses to fit', () => {
		// The kernel short-circuits below MIN_SAMPLES to a not-leaking verdict
		// tagged insufficient-samples. That is a verdict about the window, not
		// about the server, so it must read as health rather than as a pass:
		// seven climbing samples would otherwise certify a clean server.
		const seven = CLIMBING.slice(0, MIN_SAMPLES - 1);
		const verdict = judge({ ...HEALTHY, rss: seven });
		assert.equal(verdict.growth.reason, 'insufficient-samples');
		assert.equal(verdict.failing, false);
		assert.match(verdict.health.join(' '), /too short a window/);
		const eight = CLIMBING.slice(0, MIN_SAMPLES);
		assert.deepEqual(judge({ ...HEALTHY, rss: eight }).health, []);
	});

	test('does not ask a resident set to be monotonic, because one never is', () => {
		// The vote the lane switches off, and the reason it has to: even the
		// climbing series steps backwards often enough to fail a 90% rule, so
		// leaving the kernel's default in place would make this gate unable to
		// fire at all. If judge() ever stops overriding it, this fails.
		const withDefaultVote = detectGrowth(CLIMBING, {
			warmup: 0, tolerance: RSS_TOLERANCE_BYTES, minSlope: 0, minRSquared: MIN_R_SQUARED
		});
		assert.ok(withDefaultVote.monotonicFraction < 0.9);
		assert.equal(withDefaultVote.reason, 'non-monotonic');
		assert.equal(judge({ ...HEALTHY, rss: CLIMBING }).growth.leaking, true);
	});

	test('takes the quantile at the sample, not at an interpolation of it', () => {
		assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10);
		assert.equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
		assert.equal(quantile([], 0.95), 0);
	});
});

// The two gates this runtime runs on top of the family's three. Each is
// asserted from both sides, and each is asserted ABSENT: a record without the
// reading must judge exactly as the uws lane would, since that is the record
// shape its rules test drives.
describe('the family retention and connections gates', () => {
	test('reads retention as heap plus external', () => {
		assert.equal(retainedBytes({ heapUsed: 10, external: 5 }), 15);
		assert.equal(retainedBytes({ heapUsed: 10 }), 10);
	});

	test('fails settled retention that grew past the ceiling, and passes growth under it', () => {
		const base = 8 * MiB;
		// Past the byte floor either way, so the ratio alone decides here.
		assert.ok(base * MAX_RETAINED_GROWTH > RETAINED_TOLERANCE_BYTES, 'the premise: the ratio is the binding ceiling at this baseline');
		const under = judge({ ...HEALTHY, retained: { baseline: base, final: base * (1 + MAX_RETAINED_GROWTH) - 1, settled: true } });
		const over = judge({ ...HEALTHY, retained: { baseline: base, final: base * (1 + MAX_RETAINED_GROWTH) + 1, settled: true } });
		assert.equal(under.failing, false);
		assert.equal(under.retained.leaking, false);
		assert.equal(over.failing, true);
		assert.equal(over.retained.leaking, true);
		assert.match(over.failures[0], /retained \(heap\+external\) grew/);
	});

	test('does not fail a bounded fill on a small baseline: the byte floor must be crossed too', () => {
		// The measured shape: the ws churn retains 1.1 MiB whether the window
		// is three minutes or eight, which is a structure reaching its bound.
		// On a 4.8 MiB baseline that is 24%; on a 3 MiB one it would be 37%,
		// and a ratio alone would call the smaller idle heap a leak.
		const fill = 1.1 * MiB;
		const small = judge({ ...HEALTHY, retained: { baseline: 3 * MiB, final: 3 * MiB + fill, settled: true } });
		assert.ok(small.retained.ratio > MAX_RETAINED_GROWTH, 'the premise: the ratio alone would fail this');
		assert.equal(small.retained.leaking, false);
		assert.equal(small.failing, false);
		// The same ratio past the floor is a leak.
		const large = judge({ ...HEALTHY, retained: { baseline: 3 * MiB, final: 3 * MiB + RETAINED_TOLERANCE_BYTES + 1, settled: true } });
		assert.equal(large.retained.leaking, true);
		assert.match(large.failures[0], /2 MiB ceilings/);
	});

	test('reports retention that never settled as health, not as a verdict either way', () => {
		const verdict = judge({ ...HEALTHY, retained: { baseline: 8 * MiB, final: 80 * MiB, settled: false } });
		assert.match(verdict.health.join(' '), /retention never settled/);
		// The comparison is still REPORTED - the reading is evidence - but a
		// health entry is what stops it from being believed.
		assert.equal(verdict.retained.leaking, true);
	});

	test('fails a connection still registered after every client closed', () => {
		assert.equal(judge({ ...HEALTHY, connectionsAfter: 0 }).failing, false);
		const leaked = judge({ ...HEALTHY, connectionsAfter: 3 });
		assert.equal(leaked.failing, true);
		assert.match(leaked.failures[0], /3 WebSocket connection\(s\) still registered/);
		// A probe that could not count reports -1; that is not a leaked socket.
		assert.equal(judge({ ...HEALTHY, connectionsAfter: -1 }).failing, false);
	});

	test('an unreadable live count is a health failure', () => {
		for (const connectionsAfter of [-1, null, undefined, NaN, Infinity, 0.5, '0']) {
			const verdict = judge({ ...HEALTHY, connectionsAfter });
			assert.match(verdict.health.join(' '), /WebSocket count.*could not be read/);
			assert.equal(verdict.failing, false);
		}
		assert.deepEqual(judge({ ...HEALTHY, connectionsAfter: 0 }).health, []);
	});

	test('judges a record without either reading exactly as the family rules would, keys included', () => {
		const verdict = judge(HEALTHY);
		assert.equal('retained' in verdict, false);
		assert.deepEqual(Object.keys(verdict), ['growth', 'errorRate', 'p95Creep', 'failures', 'health', 'failing']);
		assert.deepEqual(verdict.failures, []);
		assert.deepEqual(verdict.health, []);
	});
});

// The self-check accepts only the gate it tests. The planted defect is memory
// growth, so a failing verdict is not detection: a deliberately leaking server
// can also shed requests or creep its p95, and a self-check that accepted any
// failure would pass while the growth gate itself was blind. Driven through
// the real judge() outputs rather than hand-built records, so the rule and the
// verdict shape cannot drift apart.
describe('the self-check counts only the growth gate as detection', () => {
	test('passes when the growth gate itself saw the planted leak', () => {
		const record = judge({ ...HEALTHY, rss: CLIMBING });
		assert.equal(record.growth.leaking, true, 'the premise: this record is a detected leak');
		const check = selfCheckVerdict(record);
		assert.equal(check.pass, true);
		assert.match(check.reason, /growth gate/);
	});

	test('still passes when the leak also degraded the server, as a real one does', () => {
		// Growth detected AND an error-rate failure beside it: the incidental
		// failure must not mask the detection that matters.
		const record = judge({ ...HEALTHY, rss: CLIMBING, errors: 600 });
		assert.ok(record.failures.length > 1);
		assert.equal(selfCheckVerdict(record).pass, true);
	});

	test('fails when the verdict failed for any reason but the growth gate stayed blind', () => {
		// The shape the typed check exists for: an error-rate failure makes the
		// verdict failing while the planted growth went undetected. Accepting
		// this record was the defect.
		const record = judge({ ...HEALTHY, errors: 600 });
		assert.equal(record.failing, true, 'the premise: a failing verdict without a detected leak');
		assert.equal(record.growth.leaking, false);
		const check = selfCheckVerdict(record);
		assert.equal(check.pass, false);
		assert.match(check.reason, /went undetected/);
	});

	test('is not satisfied by the retention gate alone', () => {
		// This runtime's own gate seeing the leak proves nothing about the
		// family's: a self-check that accepted it would certify a lane whose
		// growth gate had gone blind, on a runtime where retention happens to
		// be the more sensitive reading.
		const record = judge({ ...HEALTHY, retained: { baseline: 8 * MiB, final: 80 * MiB, settled: true } });
		assert.equal(record.retained.leaking, true);
		assert.equal(record.growth.leaking, false);
		assert.equal(selfCheckVerdict(record).pass, false);
	});

	test('fails on a clean verdict, which is the lane gone quietly blind', () => {
		const record = judge(HEALTHY);
		assert.equal(record.failing, false);
		assert.equal(selfCheckVerdict(record).pass, false);
	});
});
