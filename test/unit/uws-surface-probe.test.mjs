import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callArgs, protectiveNumberRanges } from '../../probe/uws-surface.mjs';

// THE GENERATOR, DRIVEN.
//
// probe/uws-surface.json decides what the parity gate compares, so an extractor
// that reads uws wrongly does not fail - it produces a manifest the parity tests
// then agree with, and every one of them passes against the wrong contract. The
// probe already guards its list dimensions with floors for that reason; these
// are the same guard for the dimension the floors cannot see, which is whether
// the numbers mean what they say.
//
// The sources here are written out rather than read from the uws checkout on
// purpose: a fixture can hold shapes uws does not have today - a moved floor, a
// ceiling, a call the extractor must refuse - and those are exactly the cases
// that decide whether the extractor is reading or guessing.

/** The guard as uws writes it at the pinned commit: a floor, and no ceiling. */
const PINNED_GUARD = `
export function assertProtectiveNumber(bag, key, surface, { allowZero = true, ceiling = 0 } = {}) {
	const value = bag?.[key];
	if (value === undefined || value === null) return;
	const floor = allowZero ? 0 : 1;
	if (typeof value === 'number' && Number.isFinite(value) && value >= floor) return;
	throw new Error('nope');
}
`;

/** The same guard once it grew the fixed-width bound, which brings safe-integer with it. */
const CEILING_GUARD = PINNED_GUARD.replace(
	'if (typeof value ===',
	'if (ceiling > 0 && (!Number.isSafeInteger(value) || value > ceiling)) throw new Error("ceiling");\n\tif (typeof value ==='
);

test('the floor is READ from the guard, not assumed by the extractor', () => {
	// The whole manifest hangs off one line in uws's guard. If the extractor
	// carried its own copy of `allowZero ? 0 : 1`, a release that moved the floor
	// would be recorded here as though nothing had changed - and every range in
	// the manifest would be wrong in the same direction at once, silently.
	const moved = PINNED_GUARD.replace('allowZero ? 0 : 1', 'allowZero ? 0 : 5');
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";
	assert.equal(protectiveNumberRanges(index, PINNED_GUARD).w.floor, 1);
	assert.equal(protectiveNumberRanges(index, moved).w.floor, 5, 'the moved floor is followed');
});

test('a guard that stops deriving the floor from allowZero fails the extractor', () => {
	// The alternative is recording the old rule against a guard that no longer
	// implements it, which is the one outcome worse than not recording anything:
	// the parity tests would keep passing against a contract uws had abandoned.
	assert.throws(
		() => protectiveNumberRanges("assertProtectiveNumber(websocket, 'w');", 'export function assertProtectiveNumber() { return; }'),
		/no longer derives the protective-number floor from `allowZero`/
	);
});

test('allowZero decides which floor an option gets', () => {
	const index = [
		"assertProtectiveNumber(websocket, 'limit');",
		"assertProtectiveNumber(websocket, 'window', 'websocket.window', { allowZero: false });"
	].join('\n');
	const ranges = protectiveNumberRanges(index, PINNED_GUARD);
	assert.deepEqual(ranges.limit, { allowZero: true, floor: 0, ceiling: null, integerRequired: false });
	assert.deepEqual(ranges.window, { allowZero: false, floor: 1, ceiling: null, integerRequired: false });
});

test('a ceiling is recorded, and brings the safe-integer requirement with it', () => {
	// The bound uws grew after this repo's pin. Recording it is what turns it
	// from a difference nobody can see into a failing test here, so the extractor
	// has to read a shape the pinned commit does not contain.
	const index = "assertProtectiveNumber(websocket, 'maxPayloadLength', 'websocket.maxPayloadLength', {\n\tallowZero: false,\n\tceiling: 0x7fffffff,\n\tzeroMeans: 'raise it'\n});";
	assert.deepEqual(protectiveNumberRanges(index, CEILING_GUARD).maxPayloadLength, {
		allowZero: false,
		floor: 1,
		ceiling: 2147483647,
		integerRequired: true
	});
});

test('a ceiling the guard does not implement is not reported as one it enforces', () => {
	// A call passing an option the guard ignores is a key that does nothing, and
	// recording it as a bound would make the parity test refuse values uws
	// actually accepts - a failure invented here rather than found.
	const index = "assertProtectiveNumber(websocket, 'x', 'websocket.x', { allowZero: false, ceiling: 0x7fffffff });";
	const range = protectiveNumberRanges(index, PINNED_GUARD);
	assert.equal(range.x.ceiling, 2147483647, 'the value is still recorded');
	assert.equal(range.x.integerRequired, false, 'but the guard enforces nothing with it');
});

test('a call site that does not name its option as a literal is refused, not guessed', () => {
	assert.throws(
		() => protectiveNumberRanges('assertProtectiveNumber(websocket, keyFromAVariable);', PINNED_GUARD),
		/does not name its option as a string literal/
	);
});

test('a source with no call sites at all fails rather than yielding an empty contract', () => {
	// An empty `protectiveNumbers` makes every range assertion vacuously true,
	// which is the shape this repo keeps re-learning to distrust: a gate that
	// cannot fail reads exactly like a gate that passed.
	assert.throws(
		() => protectiveNumberRanges('const nothing = 1;', PINNED_GUARD),
		/parsed no protective-number call sites/
	);
});

test('a bracket inside a message string does not end the argument scan early', () => {
	// uws writes long operator-facing prose into `zeroMeans`, and that prose
	// contains parentheses and quotes. A naive scan stops at the first `)` inside
	// one, truncating the arguments and losing the options object - which would
	// silently downgrade `allowZero: false` to the default and record a floor of
	// 0 for an option whose floor is 1.
	const index =
		"assertProtectiveNumber(websocket, 'maxBackpressure', 'websocket.maxBackpressure', {\n" +
		"\tallowZero: false,\n" +
		"\tzeroMeans: 'uWS reads 0 as UNLIMITED (the opposite of what it looks like) - a slow reader grows the worker'\n" +
		'});';
	const range = protectiveNumberRanges(index, PINNED_GUARD).maxBackpressure;
	assert.equal(range.allowZero, false, 'the options object survived the prose');
	assert.equal(range.floor, 1);
});

test('callArgs stops at the matching bracket, not the first one', () => {
	const src = "f(a, 'b)c', /* ) */ { d: (1) })";
	assert.equal(callArgs(src, src.indexOf('(')), "a, 'b)c', /* ) */ { d: (1) }");
});

test('callArgs refuses an unbalanced argument list rather than returning a prefix', () => {
	assert.throws(() => callArgs('f(a, b', 1), /unbalanced argument list/);
});
