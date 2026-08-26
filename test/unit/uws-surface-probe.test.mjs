import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
	admissionBoundRanges,
	blankNonCode,
	callArgs,
	nestedOptionKeys,
	pinnedRef,
	protectiveNumberRanges
} from '../../probe/uws-surface.mjs';

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
	"if (ceiling > 0 && typeof value === 'number' && Number.isFinite(value) && value >= floor &&\n" +
	"\t\t(!Number.isSafeInteger(value) || value > ceiling)) {\n" +
	"\t\tthrow new Error('ceiling');\n" +
	'\t}\n\tif (typeof value ==='
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
	assert.equal(range.x.ceiling, null, 'an argument the guard never compares against bounds nothing');
	assert.equal(range.x.integerRequired, false, 'and nothing rides along behind it');
});

test('a safe-integer check elsewhere in the guard is refused, not read around', () => {
	// THE DIRECTION THAT MATTERS. A ceiling recorded but not enforced makes the
	// manifest STRICTER than uws, so the parity gate holds this adapter to a
	// bound uws does not have and this adapter refuses a config that builds
	// there. The never-looser test cannot see it, because it is not looser.
	//
	// `Number.isSafeInteger` is an ordinary thing for a validator to use on some
	// other option, so its presence was never evidence of anything. The guard
	// below drops the ceiling branch and keeps such a use - and because a branch
	// the extractor does not understand could be the one that decides what the
	// guard accepts, the whole guard is refused rather than the branch skipped.
	const unrelated = PINNED_GUARD.replace(
		'const floor = allowZero ? 0 : 1;',
		'const floor = allowZero ? 0 : 1;\n\tif (!Number.isSafeInteger(bag.retries)) throw new Error("retries");'
	);
	const index = "assertProtectiveNumber(websocket, 'x', 'websocket.x', { allowZero: false, ceiling: 0x7fffffff });";
	assert.throws(
		() => protectiveNumberRanges(index, unrelated),
		/condition this extractor does not read/,
		'an unfamiliar branch fails the extractor instead of being guessed about'
	);
});

test('a floor declaration the acceptance no longer compares against is not a floor', () => {
	// The declaration is a token, not a rule: `const floor = allowZero ? 0 : 1;`
	// can stand in a guard whose acceptance stopped reading it, and that guard
	// accepts zero for an option the manifest would claim refuses it - stricter
	// than uws, invisible to the never-looser test. The extractor reads the
	// acceptance CONDITION, so a guard that dropped the comparison is a shape it
	// refuses rather than a floor it records.
	const relaxed = PINNED_GUARD.replace(
		"if (typeof value === 'number' && Number.isFinite(value) && value >= floor) return;",
		"if (typeof value === 'number' && Number.isFinite(value)) return;"
	);
	assert.match(relaxed, /const floor = allowZero/, 'the declaration really is still there');
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";
	assert.throws(
		() => protectiveNumberRanges(index, relaxed),
		/condition this extractor does not read/,
		'the retained declaration does not become a recorded floor'
	);
});

test('ceiling tokens that govern no throw do not become a ceiling', () => {
	// Both spellings of "present but not load-bearing". As bare expressions the
	// tokens govern nothing and no ceiling is recorded; as a branch that does
	// something OTHER than refuse, the guard is a shape the extractor does not
	// understand and it fails rather than deciding which half to believe.
	const observedInConst = PINNED_GUARD.replace(
		'const floor = allowZero ? 0 : 1;',
		'const floor = allowZero ? 0 : 1;\n' +
		'\tconst audited = ceiling > 0 && (!Number.isSafeInteger(value) || value > ceiling);\n' +
		'\tconst alsoAudited = audited;'
	);
	const index = "assertProtectiveNumber(websocket, 'x', 'websocket.x', { allowZero: false, ceiling: 100 });";
	const range = protectiveNumberRanges(index, observedInConst).x;
	assert.equal(range.ceiling, null, 'expressions that refuse nothing bound nothing');
	assert.equal(range.integerRequired, false, 'and nothing rides along behind them');

	const observedInBranch = CEILING_GUARD.replace("throw new Error('ceiling');", 'overCeiling += 1;');
	assert.throws(
		() => protectiveNumberRanges(index, observedInBranch),
		/no longer governs a throw/,
		'a ceiling condition that stops refusing fails the extractor'
	);
});

test('only a const may be read past; anything that can rebind fails the walk', () => {
	// Not returning is not the same as being harmless. Each of these leaves the
	// branches the extractor verifies exactly where they were and changes what
	// those branches COMPARE, so the recorded range would go on describing a
	// rule the guard stopped enforcing - in the direction that matters, more
	// accepted than the manifest says.
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";

	// The one that survived the statement walk. The floor comparison is
	// untouched and now reads a coerced value, so the guard takes the string
	// '5' while the manifest says numbers at or above 1.
	const coerced = PINNED_GUARD.replace(
		'const value = bag?.[key];',
		'let value = bag?.[key];\n\tvalue = Number(value);'
	);
	assert.throws(() => protectiveNumberRanges(index, coerced), /will not treat as harmless/,
		'a value coerced before the branch');

	// A parameter is assignable, so an expression statement can rewrite the
	// bound the CALL SITE declared - which is the number the manifest reads.
	const rebound = PINNED_GUARD.replace(
		'const floor = allowZero ? 0 : 1;',
		'const floor = allowZero ? 0 : 1;\n\tceiling = 100;'
	);
	assert.throws(() => protectiveNumberRanges(index, rebound), /will not treat as harmless/,
		'a parameter reassigned mid-body');

	// The same rewrite smuggled into a declaration's initializer.
	const smuggled = PINNED_GUARD.replace(
		'const floor = allowZero ? 0 : 1;',
		'const floor = allowZero ? 0 : 1;\n\tconst x = (ceiling = 100);'
	);
	assert.throws(() => protectiveNumberRanges(index, smuggled), /initializer assigns/,
		'an assignment inside a const initializer');

	// A plain const still reads past, or the extractor could not read the real
	// guard - which opens with two of them.
	const plain = PINNED_GUARD.replace(
		'const floor = allowZero ? 0 : 1;',
		'const floor = allowZero ? 0 : 1;\n\tconst spare = floor + 1;'
	);
	assert.equal(protectiveNumberRanges(index, plain).w.floor, 1,
		'an ordinary const declaration is still harmless');
});

test('a ceiling branch behind the acceptance return enforces nothing', () => {
	// The comparison exists, governs a throw, and never runs: every accepted
	// value has already returned by the time control would reach it.
	const reordered = PINNED_GUARD.replace(
		"if (typeof value === 'number' && Number.isFinite(value) && value >= floor) return;",
		"if (typeof value === 'number' && Number.isFinite(value) && value >= floor) return;\n" +
		"\tif (ceiling > 0 && typeof value === 'number' && Number.isFinite(value) && value >= floor &&\n" +
		'\t\t(!Number.isSafeInteger(value) || value > ceiling)) {\n' +
		"\t\tthrow new Error('ceiling');\n" +
		'\t}'
	);
	const index = "assertProtectiveNumber(websocket, 'x', 'websocket.x', { ceiling: 100 });";
	assert.throws(
		() => protectiveNumberRanges(index, reordered),
		/only AFTER acceptance has returned/,
		'unreachable enforcement is refused, not recorded'
	);
});

test('a return no recognised branch governs fails the extractor', () => {
	// The plainest relaxation of all: a bare return BEFORE the branches makes
	// every one of them dead code while each stays letter-perfect, and the
	// guard accepts everything the recorded ranges say it refuses. An `else
	// return` on a refusing branch is the same hole spelled as a refactor.
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";
	const early = PINNED_GUARD.replace(
		'if (value === undefined || value === null) return;',
		'return;\n\tif (value === undefined || value === null) return;'
	);
	assert.throws(
		() => protectiveNumberRanges(index, early),
		/no recognised branch governs/,
		'an unconditional early return is refused, not walked past'
	);
	const elseReturn = PINNED_GUARD.replace(
		"if (typeof value === 'number'",
		"if (!allowZero && value === 0) { throw new Error('zero'); } else return;\n\tif (typeof value === 'number'"
	);
	assert.throws(
		() => protectiveNumberRanges(index, elseReturn),
		/construct this extractor does not walk \("else"\)/,
		'a refusing branch that accepts everything else is refused too'
	);
});

test('a guard that refuses before its branches run fails the extractor', () => {
	// Reachability, not token order. An unconditional throw ahead of the
	// branches refuses every value, while each branch stays letter-perfect and
	// the body still ends in a throw - so a walk that only checks the LAST
	// throw ends the body records ranges for branches nothing reaches.
	const dead = PINNED_GUARD.replace(
		'if (value === undefined || value === null) return;',
		"throw new Error('always');\n\tif (value === undefined || value === null) return;"
	);
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";
	assert.throws(
		() => protectiveNumberRanges(index, dead),
		/refuses unconditionally before its branches have run/,
		'an unconditional refusal is not walked past'
	);
});

test('a recognised branch nested inside another owns nothing', () => {
	// Lexical ownership. A recognised condition sitting INSIDE another branch's
	// block is not the guard's own branch: here the zero branch carries a
	// letter-perfect unset check after its throw, and a flat token scan
	// credited that nested return as sanctioned. The zero branch no longer
	// governs exactly one throw, and that is what fails.
	const nested = PINNED_GUARD.replace(
		"if (typeof value === 'number'",
		"if (!allowZero && value === 0) { throw new Error('zero'); if (value === undefined || value === null) return; }\n" +
		"\tif (typeof value === 'number'"
	);
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";
	assert.throws(
		() => protectiveNumberRanges(index, nested),
		/no longer governs a throw/,
		'a branch owns exactly its consequent, nothing beyond it'
	);
});

test('the same recognised condition stated twice is not the pinned shape', () => {
	const doubled = PINNED_GUARD.replace(
		'if (value === undefined || value === null) return;',
		'if (value === undefined || value === null) return;\n' +
		'\tif (value === undefined || value === null) return;'
	);
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";
	assert.throws(
		() => protectiveNumberRanges(index, doubled),
		/states the same recognised condition twice/,
		'a duplicated branch is a shape change, not a formality'
	);
});

test('a guard that can swallow its own refusal fails the extractor', () => {
	// The ceiling branch is verified to govern a throw - and a try around it
	// makes that throw refuse nothing while every check on the branch itself
	// still passes. Control-flow constructs the walker does not model are
	// refused before it starts, because any of them can reroute what the
	// recorded ranges depend on.
	const swallowed = CEILING_GUARD
		.replace('if (ceiling > 0', 'try { if (ceiling > 0')
		.replace("throw new Error('ceiling');\n\t}", "throw new Error('ceiling');\n\t} } catch {}");
	assert.match(swallowed, /catch \{\}/, 'the wrapper really is in place');
	const index = "assertProtectiveNumber(websocket, 'x', 'websocket.x', { ceiling: 100 });";
	assert.throws(
		() => protectiveNumberRanges(index, swallowed),
		/construct this extractor does not walk/,
		'a swallowed throw is not recorded as enforcement'
	);
});

test('whitespace inside a string literal is part of the condition', () => {
	// Flat whitespace-stripping would equate 'number' with 'number ', reading
	// an acceptance that is always false as the ordinary one - a manifest
	// LOOSER than the guard, which is the drift this probe exists to catch.
	const spaced = PINNED_GUARD.replace("typeof value === 'number'", "typeof value === 'number '");
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";
	assert.throws(
		() => protectiveNumberRanges(index, spaced),
		/condition this extractor does not read/,
		'the literal is compared by its exact content'
	);
});

test('a guard that stops ending in refusal fails rather than recording its floors', () => {
	// Every branch can be correct and the guard still accept everything: a value
	// no branch claims falls out of the bottom, and a function that returns
	// undefined reads to its caller exactly like one that accepted.
	const fallsThrough = PINNED_GUARD.replace("\tthrow new Error('nope');\n", '');
	assert.doesNotMatch(fallsThrough, /nope/, 'the final refusal really is gone');
	const index = "assertProtectiveNumber(websocket, 'w', 'websocket.w', { allowZero: false });";
	assert.throws(
		() => protectiveNumberRanges(index, fallsThrough),
		/no longer ends by throwing/,
		'floors are not recorded for a guard anything can fall through'
	);
});

test('the ceiling is read from the guard that implements it, not from the file around it', () => {
	// A module validating a dozen options has the words for every rule in it
	// somewhere. Only this function decides what a protective number accepts.
	const neighbour = PINNED_GUARD +
		'\nexport function assertSomethingElse(bag, key) {\n' +
		'\tif (ceiling > 0 && (!Number.isSafeInteger(value) || value > ceiling)) throw new Error("nope");\n' +
		'}\n';
	const index = "assertProtectiveNumber(websocket, 'x', 'websocket.x', { ceiling: 4096 });";
	assert.equal(
		protectiveNumberRanges(index, neighbour).x.ceiling,
		null,
		'the enforcement belongs to the other function'
	);
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

test('a nested key commented out inside the brackets is not still declared', () => {
	// A removal reads as a declaration if the keys are recovered from raw text:
	// the key uws deleted survives in the manifest as one it still accepts, and
	// the nested parity dimension then holds this adapter to it. Both comment
	// spellings, because only one of them is the obvious one to think of.
	const block =
		'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' +
		"\tupgradeAdmission: new Set(['real', /* was 'ghost' */ 'other'])\n" +
		'};';
	assert.deepEqual(nestedOptionKeys(block).upgradeAdmission, ['other', 'real']);

	const line =
		'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' +
		'\tupgradeAdmission: new Set([\n' +
		"\t\t'real',\n" +
		"\t\t// 'ghost',\n" +
		"\t\t'other'\n" +
		'\t])\n' +
		'};';
	assert.deepEqual(nestedOptionKeys(line).upgradeAdmission, ['other', 'real']);
});

test('a nested block whose name is quoted is still read from the original', () => {
	// The names come back out of the raw source at offsets found in the blanked
	// copy, so the dotted spelling has to survive that round trip intact.
	const source =
		'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' +
		"\t'upgradeAdmission.cursorLane': new Set(['fraction'])\n" +
		'};';
	assert.deepEqual(nestedOptionKeys(source), { 'upgradeAdmission.cursorLane': ['fraction'] });
});

test('a nested key keeps its contract whichever quote delimiter spells it', () => {
	// Which quote uws writes is a style choice, and a style-only edit upstream
	// must not be able to delete a key from this adapter's contract. A key seen
	// only under one delimiter FAILS OPEN: it is simply absent, the parity
	// candidates are derived from the thinned manifest, and every check stays
	// green while the contract shrinks.
	const doubled =
		'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' +
		'\t"upgradeAdmission.cursorLane": new Set(["fraction"])\n' +
		'};';
	assert.deepEqual(nestedOptionKeys(doubled), { 'upgradeAdmission.cursorLane': ['fraction'] });

	const mixed =
		'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' +
		'\tupgradeAdmission: new Set([\'maxConcurrent\', "maxDeferred"])\n' +
		'};';
	assert.deepEqual(
		nestedOptionKeys(mixed).upgradeAdmission,
		['maxConcurrent', 'maxDeferred'],
		'one Set may spell its keys both ways and loses neither'
	);

	const delimitersMatter =
		'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' +
		'\tupgradeAdmission: new Set(["it\'s"])\n' +
		'};';
	assert.deepEqual(
		nestedOptionKeys(delimitersMatter).upgradeAdmission,
		["it's"],
		'a delimiter only closes the quote it opened'
	);
});

test('a Set entry the extractor cannot read fails rather than thinning the list', () => {
	// The half that matters. Recognising more spellings shrinks the blind spot;
	// only refusing to publish past an unrecognised one removes it. Each shape
	// below is a key the old scan would have silently dropped while the keys
	// around it kept every count and every check green.
	const shapes = [
		["\tupgradeAdmission: new Set(['real', `ghost`])\n", 'a template-literal key'],
		["\tupgradeAdmission: new Set(['real', GHOST_KEY])\n", 'an identifier'],
		["\tupgradeAdmission: new Set([...SHARED, 'real'])\n", 'a spread']
	];
	for (const [entry, what] of shapes) {
		const block = 'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' + entry + '};';
		assert.throws(
			() => nestedOptionKeys(block),
			/entry this extractor cannot read/,
			`${what} is refused, not skipped`
		);
	}
});

test('the amount of whitespace inside a Set construction changes nothing', () => {
	// `new` and `Set` split across a line break is ordinary JavaScript, and a
	// spelling the entry shape misses while the Set count also misses it is a
	// block that vanishes with all its keys - the silent half of the failure
	// the count exists to make loud. So the entry shape tolerates the
	// whitespace, and the count is written broader than the entry, never
	// narrower.
	const wrapped =
		'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' +
		"\tupgradeAdmission: new Set(['maxConcurrent']),\n" +
		"\t'upgradeAdmission.cursorLane': new\n\t\tSet(['fraction']),\n" +
		"\tpressure: new Set (['sampleMs'])\n" +
		'};';
	assert.deepEqual(nestedOptionKeys(wrapped), {
		upgradeAdmission: ['maxConcurrent'],
		'upgradeAdmission.cursorLane': ['fraction'],
		pressure: ['sampleMs']
	});
});

test('a block spelled some way the extractor cannot read fails rather than vanishing', () => {
	// A whole block can disappear while its neighbours keep the result nonempty,
	// so the count of Sets is held against the count of entries that matched.
	const computed =
		'export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {\n' +
		"\tupgradeAdmission: new Set(['maxConcurrent']),\n" +
		"\t[NESTED_BLOCK]: new Set(['fraction'])\n" +
		'};';
	assert.throws(
		() => nestedOptionKeys(computed),
		/only 1 matched the entry shape/,
		'the unmatched Set is refused, not lost'
	);
});

test('the manifest names an immutable commit, so regenerating cannot re-pin it', () => {
	// A regeneration is a CHECK that the manifest still describes the commit it
	// names. Defaulting to HEAD made an ordinary `npm run probe:uws` adopt
	// whatever the sibling checkout had moved to - and a prerelease version does
	// not change on every commit, so the only trace could be one sha in a diff
	// whose version line says nothing moved.
	const manifest = JSON.parse(readFileSync(new URL('../../probe/uws-surface.json', import.meta.url), 'utf8'));
	assert.match(manifest.uwsCommit, /^[0-9a-f]{40}$/, 'the commit is a full sha');
	assert.equal(manifest.uwsRef, manifest.uwsCommit, 'and the ref it was taken at is that same commit');
	assert.equal(pinnedRef(), manifest.uwsCommit, 'which is what a regeneration reads by default');
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
