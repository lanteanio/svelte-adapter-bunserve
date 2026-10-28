// The pure trend kernel the leak lane's growth gate runs on. It is the
// svelte-adapter-uws kernel, byte for byte, and these are that package's cases
// for it: a kernel that drifted here would give the two lanes different
// verdicts on the same series, which is the one thing the shared rules exist
// to rule out.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	detectGrowth,
	createResourceTracker,
	assertNoResourceGrowth,
	LeakError
} from '../leak/leak-detect.js';

// Build a series with a linear ramp of `m` points starting at `start` with a
// per-step increment of `step`.
function ramp(m, start = 0, step = 1) {
	const out = [];
	for (let i = 0; i < m; i++) out.push(start + i * step);
	return out;
}

describe('detectGrowth - the pure trend kernel', () => {
	test('does not flag a flat series (delta and slope votes fail)', () => {
		const r = detectGrowth(new Array(20).fill(5));
		assert.equal(r.leaking, false);
		assert.equal(r.delta, 0);
		assert.equal(r.slope, 0);
		// A flat series is non-decreasing at every pair, but that gate alone must
		// not flag it - the delta gate is what saves the healthy steady state.
		assert.equal(r.monotonicFraction, 1);
		assert.equal(r.reason, 'delta-within-tolerance');
	});

	test('flags a linear ramp (all votes agree)', () => {
		const r = detectGrowth(ramp(20));
		assert.equal(r.leaking, true);
		assert.equal(r.reason, 'growth-detected');
		assert.ok(r.slope > 0);
		assert.equal(r.monotonicFraction, 1);
		assert.equal(r.delta, 19);
		assert.equal(r.first, 0);
		assert.equal(r.last, 19);
		assert.equal(r.min, 0);
		assert.equal(r.max, 19);
		assert.equal(r.n, 20);
	});

	test('does not flag a sawtooth / oscillating series (monotonic-fraction gate)', () => {
		// Rises then falls repeatedly around a flat baseline.
		const saw = [];
		for (let i = 0; i < 24; i++) saw.push(i % 2 === 0 ? 0 : 8);
		const r = detectGrowth(saw);
		assert.equal(r.leaking, false);
		assert.ok(r.monotonicFraction < 0.9);
		assert.equal(r.reason, 'non-monotonic');
	});

	test('warmup discards a pre-steady-state ramp so a settled series is not flagged', () => {
		// Rising fill transient (0..4) then a flat steady state at 5.
		const series = [1, 2, 3, 4, 5, ...new Array(12).fill(5)];
		// Without warmup the leading ramp makes the whole series read as growth.
		const withoutWarmup = detectGrowth(series);
		assert.equal(withoutWarmup.leaking, true);
		// Discarding the transient leaves a flat window - not leaking.
		const withWarmup = detectGrowth(series, { warmup: 5 });
		assert.equal(withWarmup.leaking, false);
		assert.equal(withWarmup.delta, 0);
		assert.equal(withWarmup.n, 12);
	});

	test('tolerance suppresses a sub-threshold total delta', () => {
		// A gentle ramp with a total delta of exactly 10 over the window.
		const series = ramp(11, 0, 1); // 0..10, delta 10
		assert.equal(detectGrowth(series, { tolerance: 5 }).leaking, true);
		const suppressed = detectGrowth(series, { tolerance: 20 });
		assert.equal(suppressed.leaking, false);
		assert.equal(suppressed.reason, 'delta-within-tolerance');
	});

	test('minSlope suppresses a monotonic-but-nearly-flat series', () => {
		// Monotone non-decreasing but almost no rise: two steps up over a long run.
		const series = [...new Array(10).fill(0), ...new Array(10).fill(1)];
		assert.equal(detectGrowth(series).leaking, true);
		const suppressed = detectGrowth(series, { minSlope: 1 });
		assert.equal(suppressed.leaking, false);
		assert.equal(suppressed.reason, 'slope-below-threshold');
	});

	test('minRSquared refuses a slope the samples do not lie on', () => {
		// The fourth vote, isolated. A series that alternates around a climbing
		// mean has a positive slope and a positive delta, but the line explains
		// little of its variance. The swing starts low so the delta vote passes
		// on its own and the fit vote is the only thing left to decide.
		const cloud = ramp(16, 0, 1).map((v, i) => v + (i % 2 === 0 ? -10 : 10));
		const ignored = detectGrowth(cloud, { minMonotonicFraction: 0 });
		assert.equal(ignored.leaking, true);
		assert.ok(ignored.rSquared < 0.5);
		const gated = detectGrowth(cloud, { minMonotonicFraction: 0, minRSquared: 0.5 });
		assert.equal(gated.leaking, false);
		assert.equal(gated.reason, 'fit-too-poor');
		// A true ramp lies on its line exactly.
		assert.equal(detectGrowth(ramp(16), { minRSquared: 0.99 }).rSquared, 1);
	});

	test('short-circuits below minSamples', () => {
		const r = detectGrowth(ramp(4), { minSamples: 8 });
		assert.equal(r.leaking, false);
		assert.equal(r.reason, 'insufficient-samples');
		assert.equal(r.n, 4);
	});

	test('is deterministic: identical inputs give a byte-identical report', () => {
		const a = detectGrowth(ramp(16, 3, 2));
		const b = detectGrowth(ramp(16, 3, 2));
		assert.equal(JSON.stringify(a), JSON.stringify(b));
	});
});

describe('createResourceTracker', () => {
	test('samples multiple series and analyzes each independently', () => {
		let flat = 5;
		let growing = 0;
		const tracker = createResourceTracker([
			{ name: 'flat', read: () => flat },
			{ name: 'growing', read: () => growing }
		]);
		for (let i = 0; i < 20; i++) { tracker.sample(); growing += 1; }
		assert.deepEqual(tracker.names(), ['flat', 'growing']);
		assert.deepEqual(tracker.series('flat'), new Array(20).fill(5));
		const { metrics, leaks, leaking } = tracker.analyze();
		assert.equal(leaking, true);
		assert.deepEqual(leaks.map((l) => l.name), ['growing']);
		const byName = Object.fromEntries(metrics.map((m) => [m.name, m.leaking]));
		assert.deepEqual(byName, { flat: false, growing: true });
	});

	test('accepts a Record<string, () => number> probe form', () => {
		let n = 0;
		const tracker = createResourceTracker({ n: () => n });
		for (let i = 0; i < 12; i++) { tracker.sample(); n++; }
		assert.equal(tracker.analyze().leaking, true);
	});

	test('reset clears every series', () => {
		const tracker = createResourceTracker({ x: () => 1 });
		tracker.sample();
		tracker.sample();
		assert.equal(tracker.series('x').length, 2);
		tracker.reset();
		assert.deepEqual(tracker.series('x'), []);
	});

	test('maxSamples bounds each series to a trailing window', () => {
		let n = 0;
		const tracker = createResourceTracker({ n: () => n }, { maxSamples: 5 });
		for (let i = 0; i < 20; i++) { tracker.sample(); n++; }
		const s = tracker.series('n');
		assert.equal(s.length, 5);
		// Only the most recent readings survive.
		assert.deepEqual(s, [15, 16, 17, 18, 19]);
	});
});

describe('assertNoResourceGrowth', () => {
	test('is a no-op when nothing leaks', () => {
		const tracker = createResourceTracker({ flat: () => 3 });
		for (let i = 0; i < 12; i++) tracker.sample();
		assert.doesNotThrow(() => assertNoResourceGrowth(tracker));
	});

	test('throws a LeakError carrying the offending reports on .leaks', () => {
		let n = 0;
		const tracker = createResourceTracker({ leaked: () => n });
		for (let i = 0; i < 16; i++) { tracker.sample(); n += 2; }
		let caught;
		try { assertNoResourceGrowth(tracker); } catch (err) { caught = err; }
		assert.ok(caught instanceof LeakError);
		assert.ok(Array.isArray(caught.leaks));
		assert.equal(caught.leaks.length, 1);
		assert.equal(caught.leaks[0].name, 'leaked');
		assert.equal(caught.leaks[0].leaking, true);
		assert.ok(caught.message.includes('leaked'));
	});

	test('accepts an analyze result, a report array, and a single report', () => {
		let n = 0;
		const tracker = createResourceTracker({ leaked: () => n });
		for (let i = 0; i < 16; i++) { tracker.sample(); n += 2; }
		const result = tracker.analyze();
		assert.throws(() => assertNoResourceGrowth(result), LeakError);
		assert.throws(() => assertNoResourceGrowth(result.metrics), LeakError);
		assert.throws(() => assertNoResourceGrowth(result.leaks[0]), LeakError);
		// A single not-leaking report is accepted without throwing.
		const flat = detectGrowth(new Array(12).fill(1));
		assert.doesNotThrow(() => assertNoResourceGrowth(flat));
	});
});
