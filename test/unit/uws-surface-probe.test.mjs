import { test } from 'node:test';
import assert from 'node:assert/strict';

import { admissionBoundRanges, blankNonCode, callArgs, protectiveNumberRanges } from '../../probe/uws-surface.mjs';

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

// PROSE IS NOT CODE, and the manifest is where that distinction is load-bearing.
//
// uws writes operator-facing sentences into the option values it validates and
// documents its guards at length in the comments above them. Both places are
// full of text that looks exactly like the thing being extracted - the phrase
// `allowZero: false`, a ceiling, the sentence a guard throws. A rule read out of
// one of them is not merely wrong: it is a contract the parity tests then agree
// with, so every one of them passes and nothing anywhere reports a problem.
//
// Each case below is a source that says something the code does not do.

test('prose inside an option value cannot flip allowZero', () => {
	// The call passes no allowZero at all, so the uws default governs it. Only
	// the sentence says otherwise, and a sentence guards nothing.
	const index =
		"assertProtectiveNumber(websocket, 'window', 'websocket.window', {\n" +
		"\tzeroMeans: 'pass allowZero: false to refuse zero outright, which this call does not do'\n" +
		'});';
	const range = protectiveNumberRanges(index, PINNED_GUARD).window;
	assert.equal(range.allowZero, true, 'the default applies; the prose is not the call');
	assert.equal(range.floor, 0, 'and the floor follows the default, not the sentence');
});

test('prose inside an option value cannot fabricate a ceiling', () => {
	// Read against the guard that HAS a ceiling mechanism, so a fabricated bound
	// would also drag the safe-integer requirement in behind it - one sentence
	// silently tightening the manifest twice.
	const index =
		"assertProtectiveNumber(websocket, 'maxBackpressure', 'websocket.maxBackpressure', {\n" +
		"\tallowZero: false,\n" +
		"\tzeroMeans: 'unlike maxPayloadLength, which carries ceiling: 2147483647, this one has none'\n" +
		'});';
	const range = protectiveNumberRanges(index, CEILING_GUARD).maxBackpressure;
	assert.equal(range.ceiling, null, 'no ceiling is passed, so none is recorded');
	assert.equal(range.integerRequired, false, 'and nothing arrives behind a bound that is not there');
});

test('a comment among the arguments cannot add a bound the call does not pass', () => {
	const index =
		"assertProtectiveNumber(websocket, 'window', 'websocket.window', {\n" +
		'\t// this used to be ceiling: 2147483647 with allowZero: false\n' +
		"\tzeroMeans: 'disabled'\n" +
		'});';
	const range = protectiveNumberRanges(index, CEILING_GUARD).window;
	assert.equal(range.allowZero, true, 'a note about the past is not the present rule');
	assert.equal(range.ceiling, null);
});

test('a call site written in a comment is not a call site', () => {
	const index = [
		"// assertProtectiveNumber(websocket, 'ghost', 'websocket.ghost', { allowZero: false });",
		"assertProtectiveNumber(websocket, 'real');"
	].join('\n');
	assert.deepEqual(Object.keys(protectiveNumberRanges(index, PINNED_GUARD)), ['real']);
});

test('a pattern is not read as a string, so the code after it survives', () => {
	// uws matches header names with patterns like /['"`]\s*set-cookie\s*['"`]/i.
	// Read that backtick as the start of a template literal and every line below
	// it is blanked - which costs the manifest call sites that nothing then
	// reports as missing, because what is gone was never counted.
	const index =
		'const rx = /[`\'"]\\s*set-cookie/i;\n' +
		"assertProtectiveNumber(websocket, 'window', 'websocket.window', { allowZero: false });";
	const ranges = protectiveNumberRanges(index, PINNED_GUARD);
	assert.deepEqual(Object.keys(ranges), ['window'], 'the call site below the pattern is still found');
	assert.equal(ranges.window.floor, 1);
});

test('a division is not read as the start of a pattern', () => {
	const src = 'const ratio = a / b + c / d;';
	assert.equal(blankNonCode(src), src, 'nothing here is prose, so nothing is blanked');
});

test('blanking preserves every offset and newline', () => {
	// The whole technique depends on it: a match found in the blanked copy is
	// sliced out of the original, so the two must line up character for character.
	const src = "const a = 'one';\n// two\nconst b = `three`;\n/* four\nfive */\nconst c = 6;\n";
	const blanked = blankNonCode(src);
	assert.equal(blanked.length, src.length);
	assert.deepEqual(
		blanked.split('\n').map((l) => l.length),
		src.split('\n').map((l) => l.length)
	);
	assert.match(blanked, /const c = 6;/);
	assert.doesNotMatch(blanked, /two|three|four|five/);
});

test('an escape at the very end of a source does not shift every offset', () => {
	// A truncated file ends mid-literal on a backslash. Blanking the character
	// it escapes then writes one past the end, which lengthens the copy - and a
	// copy one character longer than the original silently misaligns every slice
	// taken from it afterwards.
	const src = "const s = 'x\\";
	assert.equal(blankNonCode(src).length, src.length);
});

/** The gate as uws writes it at the pin: a binding, then the guard that governs it. */
const PINNED_GATE = `
	const configuredMaxConcurrent = opts && opts.maxConcurrent;
	if (
		configuredMaxConcurrent !== undefined &&
		(!Number.isSafeInteger(configuredMaxConcurrent) || configuredMaxConcurrent < 0)
	) {
		throw new TypeError('upgradeAdmission.maxConcurrent must be a non-negative safe integer.');
	}
	const maxConcurrent = configuredMaxConcurrent || 0;
`;

test('an admission bound is read from the comparison that enforces it', () => {
	assert.deepEqual(admissionBoundRanges(PINNED_GATE), {
		maxConcurrent: { allowZero: true, floor: 0, ceiling: null, integerRequired: true }
	});
});

test('the diagnostic sentence alone does not mint a bound', () => {
	// THE SHAPE THAT GOT PAST EVERYTHING. The guard is gone and only the sentence
	// describing it remains, which is the state a source reaches when a rule is
	// relaxed and its comment is not. Recording a rule from the leftover text
	// holds this adapter to something uws stopped enforcing, and every range
	// assertion keeps passing while it does.
	const relaxed = PINNED_GATE.replace(
		/\tif \([\s\S]*?\n\t}\n/,
		"\t// was: upgradeAdmission.maxConcurrent must be a non-negative safe integer.\n"
	);
	assert.match(relaxed, /was: upgradeAdmission/, 'the sentence really is still there');
	assert.throws(
		() => admissionBoundRanges(relaxed),
		/parsed no upgradeAdmission bound guards/,
		'an unenforced rule is not recorded as an enforced one'
	);
});

test('an option the gate stops guarding drops out rather than lingering', () => {
	const twoKeys =
		PINNED_GATE +
		'\tconst configuredMaxDeferred = opts && opts.maxDeferred;\n' +
		"\t// upgradeAdmission.maxDeferred must be a non-negative safe integer.\n";
	assert.deepEqual(
		Object.keys(admissionBoundRanges(twoKeys)),
		['maxConcurrent'],
		'nothing enforces maxDeferred, so the manifest claims nothing about it'
	);
});

test('a tightened comparison is recorded as tightened', () => {
	// `<= 0` refuses zero where `< 0` admits it. Reading the bound from the
	// comparison is what makes the difference visible at all.
	const tightened = PINNED_GATE
		.replace('configuredMaxConcurrent < 0', 'configuredMaxConcurrent <= 0')
		.replace('must be a non-negative safe integer', 'must be a positive safe integer');
	assert.deepEqual(admissionBoundRanges(tightened), {
		maxConcurrent: { allowZero: false, floor: 1, ceiling: null, integerRequired: true }
	});
});

test('a guard and a diagnostic that disagree fail rather than picking one', () => {
	// Which half is wrong cannot be decided from here, and guessing either way
	// writes a contract nobody checked.
	const drifted = PINNED_GATE.replace('configuredMaxConcurrent < 0', 'configuredMaxConcurrent <= 0');
	assert.throws(() => admissionBoundRanges(drifted), /guard and its diagnostic disagree/);
});

test('a diagnostic naming another option fails rather than being recorded under it', () => {
	const misnamed = PINNED_GATE.replace('upgradeAdmission.maxConcurrent must', 'upgradeAdmission.maxDeferred must');
	assert.throws(() => admissionBoundRanges(misnamed), /guard and its diagnostic disagree/);
});

test('a guard shaped differently fails rather than recording the old rule', () => {
	// The alternative is a manifest that keeps describing a bound uws has moved,
	// which is the one outcome worse than recording nothing.
	const reshaped = PINNED_GATE.replace(
		'!Number.isSafeInteger(configuredMaxConcurrent) || configuredMaxConcurrent < 0',
		'typeof configuredMaxConcurrent !== "number"'
	);
	assert.throws(() => admissionBoundRanges(reshaped), /no longer the shape this extractor reads/);
});

test('a gate that no longer asserts them fails rather than recording no rule', () => {
	// An empty contract would make the nested range test vacuous, which reads
	// exactly like a range test that passed.
	assert.throws(
		() => admissionBoundRanges('const maxConcurrent = (opts && opts.maxConcurrent) || 0;'),
		/parsed no upgradeAdmission bound guards/
	);
});
