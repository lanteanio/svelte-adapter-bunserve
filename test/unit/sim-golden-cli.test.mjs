import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The argv guards on scripts/sim-golden.js, driven as a PROCESS because that
// script is a top-level side-effecting entry with no import seam - importing it
// would run the gate.
//
// Most of these refuse BEFORE the swarm runs, which is what keeps the file
// quick. One does not: a 40-seed verify measures about 0.15s here, so the one
// assertion that needs the real comparison can afford it, and the success line
// is worth an end-to-end check because naming the wrong corpus reads exactly
// like naming the right one.
//
// What is pinned here is the class of bug this flag keeps producing - a
// spelling the parser cannot see, which does not fail but VANISHES, so the gate
// runs without the cross-adapter comparison and still reports success.
//
// NOTHING HERE MAY PASS `--update`. It is the script's only destructive path
// and it writes the committed corpus, which is resolved against the repo root,
// so a child process's working directory is no protection. A guard regressing
// into the vanishing-flag shape would then bless a new corpus as a side effect
// of this file failing.

const SCRIPT = fileURLToPath(new URL('../../scripts/sim-golden.js', import.meta.url));

/** @param {string[]} args */
function run(args) {
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 30_000
		});
		return { status: 0, stdout, stderr: '' };
	} catch (err) {
		return {
			status: /** @type {any} */ (err).status,
			stdout: String(/** @type {any} */ (err).stdout || ''),
			stderr: String(/** @type {any} */ (err).stderr || '')
		};
	}
}

test('--against with no value refuses instead of quietly skipping the comparison', () => {
	const { status, stderr } = run(['--against']);
	assert.equal(status, 1);
	assert.match(stderr, /--against needs a path/);
});

test('--against followed by another flag refuses, and names what it was given', () => {
	// Otherwise the next flag is read as a filename, which fails only after the
	// whole 40-seed swarm has been re-run.
	//
	// Deliberately NOT `--update` here, though that is the realistic typo: any
	// `--xxx` proves the same property, and `--update` is the one value that
	// also arms the script's only destructive path against the committed
	// corpus. Should this guard ever regress, a test written that way blesses
	// a new corpus as a side effect of failing.
	const { status, stderr } = run(['--against', '--verbose']);
	assert.equal(status, 1);
	assert.match(stderr, /--against needs a path/);
	assert.match(stderr, /"--verbose"/, 'the offending value is echoed, not just the rule');
});

test('the --against=path spelling is seen at all', () => {
	// The regression this file exists for. `indexOf('--against')` cannot match
	// `--against=...`, so the flag used to disappear: exit 0, gate green, no
	// comparison made, nothing said. An empty value proves the parser SAW the
	// argument rather than passing it over.
	const { status, stderr } = run(['--against=']);
	assert.equal(status, 1, 'an empty inline value is refused, not ignored');
	assert.match(stderr, /--against needs a path/);
});

test('an inline value that is another flag is refused too', () => {
	const { status, stderr } = run(['--against=--verbose']);
	assert.equal(status, 1);
	assert.match(stderr, /"--verbose"/);
});

// Every way of naming two sibling corpora. Whichever one the parser picks, the
// others are dropped without a word and the run reports a clean comparison
// against a corpus the caller did not name - so what is refused is the COUNT,
// and each spelling pair has to prove it. A guard written against the mixed
// pair alone passes the first two of these and fails the last two - and it
// fails them for the right reason only because of the stderr assertion: a
// same-spelling pair still exits 1 under that guard, having re-run the whole
// 40-seed swarm and then failed to read a sibling that does not exist.
for (const [name, args] of [
	['mixed', ['--against', 'a.json', '--against=b.json']],
	['mixed, other order', ['--against=b.json', '--against', 'a.json']],
	['two space forms', ['--against', 'a.json', '--against', 'b.json']],
	['two inline forms', ['--against=a.json', '--against=b.json']]
]) {
	test(`two sibling paths (${name}) are refused rather than one silently winning`, () => {
		const { status, stderr } = run(/** @type {string[]} */ (args));
		assert.equal(status, 1);
		assert.match(stderr, /--against was given more than once/);
	});
}

// `--corpus` selects WHICH committed corpus runs, and it fails the same ways
// `--against` does - so it is parsed by the same code, and pinned by the same
// assertions. The stakes are a shade higher here: a `--corpus` this parser
// cannot see does not error, it falls back to the default corpus, runs a full
// gate over the wrong one, and reports success. That reads exactly like the
// corpus the caller asked about being green.

test('--corpus with no value refuses instead of falling back to the default corpus', () => {
	const { status, stderr } = run(['--corpus']);
	assert.equal(status, 1);
	assert.match(stderr, /--corpus needs a corpus name/);
});

test('the --corpus=name spelling is seen at all', () => {
	// The vanishing-flag class, on the flag where vanishing is quietest.
	const { status, stderr } = run(['--corpus=']);
	assert.equal(status, 1, 'an empty inline value is refused, not ignored');
	assert.match(stderr, /--corpus needs a corpus name/);
});

test('--corpus followed by another flag refuses, and names what it was given', () => {
	// Deliberately not `--update`, for the reason the `--against` twin says: it
	// is the script's only destructive path, and a guard that regressed would
	// bless a corpus as a side effect of this test failing.
	const { status, stderr } = run(['--corpus', '--verbose']);
	assert.equal(status, 1);
	assert.match(stderr, /--corpus needs a corpus name/);
	assert.match(stderr, /"--verbose"/);
});

for (const [name, args] of [
	['mixed', ['--corpus', 'a', '--corpus=b']],
	['two space forms', ['--corpus', 'a', '--corpus', 'b']],
	['two inline forms', ['--corpus=a', '--corpus=b']]
]) {
	test(`two corpus names (${name}) are refused rather than one silently winning`, () => {
		const { status, stderr } = run(/** @type {string[]} */ (args));
		assert.equal(status, 1);
		assert.match(stderr, /--corpus was given more than once/);
	});
}

test('an unknown corpus name is refused, and the known ones are listed', () => {
	// Not defaulted. Falling back would run the full gate and report success for
	// a corpus the caller never named - and a typo is the likeliest way to get
	// here, so the answer has to say what the alternatives were.
	const { status, stderr } = run(['--corpus', 'adapter-admissions']);
	assert.equal(status, 1);
	assert.match(stderr, /unknown corpus "adapter-admissions"/);
	assert.match(stderr, /adapter-single/);
	assert.match(stderr, /adapter-admission/);
});

test('--corpus runs the corpus it names, and says which one it ran', () => {
	// End to end, both spellings, because the whole point of the flag is that a
	// different corpus actually runs. The name in the success line is what
	// distinguishes "the admission corpus is green" from "the default corpus is
	// green, and your flag went nowhere".
	//
	// Read-only: no `--update`, so the committed corpora are compared, never
	// written.
	for (const args of [['--corpus', 'adapter-admission'], ['--corpus=adapter-admission']]) {
		const { status, stdout, stderr } = run(args);
		assert.equal(status, 0, `exits clean\n${stderr || stdout}`);
		assert.match(stdout, /sim-golden adapter-admission: OK - 40\/40 fingerprints match/);
	}
	// And the default is still the cross-adapter corpus when nothing is named,
	// which is what every existing invocation relies on.
	const bare = run([]);
	assert.equal(bare.status, 0, `${bare.stderr || bare.stdout}`);
	assert.match(bare.stdout, /sim-golden adapter-single: OK/);
});

test('a single --against runs the comparison and names the corpus it read', () => {
	// The one assertion here that goes all the way through the swarm, because
	// it is the only way to see the success line. Read-only: no `--update`, so
	// the committed corpus is compared, never written.
	//
	// Naming the file is the property under test. "40/40 identical" is the same
	// sentence whichever corpus produced it, so a run that silently compared
	// something other than what was asked for is indistinguishable from a
	// correct one unless the line says which file it read.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-sim-cli-'));
	try {
		// Inside the try: a copy that throws - a corpus missing or locked - would
		// otherwise leave the directory behind, since the cleanup below is what
		// removes it.
		const sibling = path.join(dir, 'sibling.golden.json');
		fs.copyFileSync(fileURLToPath(new URL('../dst-goldens/adapter-single.golden.json', import.meta.url)), sibling);
		for (const args of [['--against', sibling], [`--against=${sibling}`]]) {
			const { status, stdout, stderr } = run(args);
			// This test is coupled to the corpus being current, so a drift failure
			// arrives here as well as in the golden gate. Carrying the child's own
			// output into the message is what stops that being an exit code with
			// no explanation attached.
			assert.equal(status, 0, `${args.length === 1 ? 'inline' : 'space'} form exits clean\n${stderr || stdout}`);
			assert.match(stdout, /40\/40 sibling fingerprints identical/);
			// Exact-string rather than path-aware, and safe to be: compareAgainst
			// echoes the argument as given, and the argument here is already
			// absolute and normalized because mkdtempSync built it - so a change
			// that printed a RESOLVED path would print these same bytes and this
			// would still pass. The strict form costs nothing and pins the
			// property that matters, which is that naming the WRONG corpus must
			// not read like naming the right one.
			assert.ok(stdout.includes(sibling), 'the line names the corpus it compared against');
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
