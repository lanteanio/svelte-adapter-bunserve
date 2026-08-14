import { test } from 'node:test';
import assert from 'node:assert/strict';

import { knob, TIMER_MAX_MS } from '../leak/knob.mjs';

// The leak lane's env parser. It is covered here rather than left to the lane
// because the lane costs minutes to run and its own failure mode - a knob that
// parses to something silently wrong - is exactly what a fast test can pin.
// The value it replaced, `Number(process.env.X || fallback)`, turned `60s` into
// NaN and then meant something different on each side that read it: an
// unfittable window in the gate, a one-millisecond step timeout in the runner.

const NAME = 'LEAK_TEST_KNOB';

/**
 * Runs `fn` with the variable set to `raw`, or unset when `raw` is undefined,
 * and puts the environment back afterwards.
 *
 * @param {string | undefined} raw
 * @param {() => void} fn
 */
function withEnv(raw, fn) {
	const had = Object.hasOwn(process.env, NAME);
	const before = process.env[NAME];
	if (raw === undefined) delete process.env[NAME];
	else process.env[NAME] = raw;
	try {
		fn();
	} finally {
		if (had) process.env[NAME] = before;
		else delete process.env[NAME];
	}
}

const parse = (raw, range) => {
	let out;
	withEnv(raw, () => { out = knob(NAME, 7, range); });
	return out;
};

const refuses = (raw, range) => {
	let err;
	withEnv(raw, () => {
		try { knob(NAME, 7, range); } catch (e) { err = e; }
	});
	return err;
};

test('unset and empty both mean the fallback', () => {
	// Empty-as-unset is the behaviour the `||` spelling had, and it is what the
	// lane's own build env means when it passes a variable as ''.
	assert.equal(parse(undefined), 7);
	assert.equal(parse(''), 7);
});

test('a plain value parses, whitespace and exponent forms included', () => {
	assert.equal(parse('42'), 42);
	assert.equal(parse('  42  '), 42);
	assert.equal(parse('1e3'), 1000);
});

test('a blank value is unset, not zero', () => {
	// `Number('   ')` is 0, not NaN, so an untrimmed blank would pass validation
	// on the knobs that allow zero and switch that phase off - a trailing space
	// in a CI env file silently disabling the resettle window, which is how the
	// lane fabricates the very artifact that window exists to avoid.
	assert.equal(parse('   '), 7);
	assert.equal(parse('   ', { min: 0 }), 7);
});

test('a value that is not a number is refused rather than becoming NaN', () => {
	// The whole reason this function exists: `Number('60s')` is NaN, and a NaN
	// window is not a short run, it is a run that measures nothing.
	for (const raw of ['60s', '42abc', '1_000', 'abc']) {
		assert.match(refuses(raw)?.message ?? '', /is not a number/, `${raw} is refused`);
	}
	// Infinity is finite-checked, not merely NaN-checked.
	assert.match(refuses('1e999')?.message ?? '', /is not a number/);
});

test('zero is refused by default and allowed where a phase may be switched off', () => {
	// `LEAK_RESETTLE_MS=0` is a documented thing to do - it reproduces the
	// collect-then-look artifact the resettle window exists to avoid - so the
	// phase knobs opt into it while a rate or a window still refuses it.
	assert.match(refuses('0')?.message ?? '', /out of range/);
	assert.equal(parse('0', { min: 0 }), 0);
	// Opting into zero does not open the floor below it.
	assert.match(refuses('-1', { min: 0 })?.message ?? '', /out of range/);
});

test('the range is named in the message, so a deliberate 0 does not read as a typo', () => {
	const message = refuses('0')?.message ?? '';
	assert.match(message, /expected 1 to /);
	assert.match(message, /LEAK_TEST_KNOB="0"/);
});

test('an over-large delay is refused instead of wrapping to one millisecond', () => {
	// setTimeout's delay is a 32-bit field: past TIMER_MAX_MS it does not
	// saturate, it wraps and fires immediately, so an over-long window would
	// become an instant timeout rather than a generous one.
	assert.equal(parse(String(TIMER_MAX_MS), { max: TIMER_MAX_MS }), TIMER_MAX_MS);
	assert.match(refuses(String(TIMER_MAX_MS + 1), { max: TIMER_MAX_MS })?.message ?? '', /out of range/);
});

test('the default ceiling is a real one, not an absent one', () => {
	// Pinned because an absent `max` still compares false against every value,
	// so dropping the default would silently uncap every knob that relies on it
	// and no other assertion here would notice.
	assert.equal(parse(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
	assert.match(refuses(String(Number.MAX_SAFE_INTEGER + 2))?.message ?? '', /out of range/);
});

test('a port is held to whole numbers in range, not merely to being positive', () => {
	const range = { integer: true, max: 65_535 };
	assert.equal(parse('3799', range), 3799);
	assert.match(refuses('3799.5', range)?.message ?? '', /whole number/);
	assert.match(refuses('70000', range)?.message ?? '', /out of range/);
});
