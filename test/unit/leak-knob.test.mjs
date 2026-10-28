import { test } from 'node:test';
import assert from 'node:assert/strict';

import { numberFlag, parseFlags, refuseUnknownFlags, stringFlag, TIMER_MAX_MS } from '../leak/knob.mjs';

// The leak lane's flag parser. It is covered here rather than left to the lane
// because the lane costs minutes to run and its own failure mode - a flag that
// parses to something silently wrong - is exactly what a fast test can pin.
// `Number('2m')` is NaN, and a NaN window is a loop that never runs: the lane
// would warm a server for a minute and then report that it measured nothing.

const minutes = (argv, range) => numberFlag(parseFlags(argv), 'minutes', 7, range);

const refuses = (fn) => {
	try { fn(); } catch (e) { return e; }
	return undefined;
};

test('an absent flag means the fallback', () => {
	assert.equal(minutes([]), 7);
	assert.equal(minutes(['--scenario', 'ws']), 7);
});

test('a plain value parses, whitespace and exponent forms included', () => {
	assert.equal(minutes(['--minutes', '42']), 42);
	assert.equal(minutes(['--minutes', '  42  ']), 42);
	assert.equal(minutes(['--minutes', '1e3']), 1000);
	assert.equal(minutes(['--scenario', 'ws', '--minutes', '2']), 2);
});

test('the --name=value spelling is the same flag', () => {
	assert.equal(minutes(['--minutes=2']), 2);
	assert.equal(stringFlag(parseFlags(['--scenario=ws']), 'scenario', 'all'), 'ws');
	// An `=` inside the value belongs to the value.
	assert.equal(stringFlag(parseFlags(['--out=a=b']), 'out', 'x'), 'a=b');
});

test('a value that is not a number is refused, naming the flag', () => {
	for (const raw of ['2m', 'abc', 'NaN', 'Infinity']) {
		const err = refuses(() => minutes(['--minutes', raw]));
		assert.ok(err, `${raw} parsed`);
		assert.match(err.message, /--minutes/);
		assert.match(err.message, /not a number/);
	}
});

test('a flag with no value is refused rather than reading the next flag', () => {
	// `--out --minutes 2` would otherwise write into a directory called
	// `--minutes` and measure for the default window: two surprises for one
	// typo.
	assert.throws(() => parseFlags(['--out']), /--out needs a value/);
	assert.throws(() => parseFlags(['--out', '--minutes', '2']), /--out needs a value/);
	assert.throws(() => parseFlags(['--minutes']), /--minutes needs a value/);
	assert.throws(() => stringFlag(parseFlags(['--out=']), 'out', 'x'), /--out needs a value/);
	// The number spelling too: an unset matrix variable is not a request for
	// the default window.
	assert.throws(() => minutes(['--minutes=']), /--minutes needs a value/);
	assert.throws(() => minutes(['--minutes', '  ']), /--minutes needs a value/);
});

test('the first occurrence supplies the value in either spelling', () => {
	assert.equal(minutes(['--minutes', '3', '--minutes', '1']), 3);
	assert.equal(minutes(['--minutes=3', '--minutes', '1']), 3);
	assert.equal(minutes(['--minutes', '3', '--minutes=1']), 3);
	assert.equal(minutes(['--minutes=3', '--minutes=1']), 3);
	assert.equal(minutes(['--minutes=3', '--minutes=']), 3);
	assert.equal(minutes(['--minutes=3', '--minutes']), 3);
	assert.throws(() => minutes(['--minutes=', '--minutes=3']), /--minutes needs a value/);
});

test('a flag the lane does not know is refused, and a bare argument too', () => {
	// A mistyped name would otherwise run the defaults in silence: three
	// scenarios for nine minutes instead of the one asked for.
	const known = ['minutes', 'scenario', 'out'];
	assert.throws(() => refuseUnknownFlags(parseFlags(['--scenarios', 'ws']), known), /unknown flag --scenarios/);
	assert.throws(() => refuseUnknownFlags(parseFlags(['--minute=2']), known), /unknown flag --minute/);
	assert.throws(() => parseFlags(['ws']), /unexpected argument "ws"/);
	assert.doesNotThrow(() => refuseUnknownFlags(parseFlags(['--minutes', '2', '--scenario=ws', '--out', 'd']), known));
});

test('a value below the floor is refused', () => {
	for (const value of ['0', '0.5', '-3']) {
		assert.throws(() => minutes(['--minutes', value]), /out of range/);
	}
	assert.equal(minutes(['--minutes', '0'], { min: 0 }), 0);
});

test('a value above the ceiling is refused', () => {
	const err = refuses(() => minutes(['--minutes', '10'], { max: 9 }));
	assert.ok(err);
	assert.match(err.message, /out of range/);
	assert.equal(minutes(['--minutes', '9'], { max: 9 }), 9);
});

test('a whole-number flag refuses a fraction', () => {
	const err = refuses(() => minutes(['--minutes', '1.5'], { integer: true }));
	assert.ok(err);
	assert.match(err.message, /whole number/);
	assert.equal(minutes(['--minutes', '2'], { integer: true }), 2);
});

test('a string flag reads its value trimmed, or the fallback', () => {
	assert.equal(stringFlag(parseFlags([]), 'scenario', 'all'), 'all');
	assert.equal(stringFlag(parseFlags(['--scenario', ' ws ']), 'scenario', 'all'), 'ws');
	assert.equal(stringFlag(parseFlags(['--minutes', '2', '--scenario', 'http']), 'scenario', 'all'), 'http');
});

test('the timer ceiling is the 32-bit delay limit', () => {
	// Past this a delay overflows and fires at once rather than late, which is
	// the same failure as a NaN delay reached through another door.
	assert.equal(TIMER_MAX_MS, 2 ** 31 - 1);
});
