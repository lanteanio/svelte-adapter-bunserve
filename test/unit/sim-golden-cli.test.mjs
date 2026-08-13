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
	// whole corpus has been built.
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
// same-spelling pair still exits 1 under that guard, having built the whole
// corpus and then failed to read a sibling that does not exist.
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
			// Exact-string rather than path-aware: compareAgainst echoes the
			// argument as given, so this round-trips byte for byte. A change that
			// printed a RESOLVED path would still name the corpus and would still
			// fail here, which is a false red worth recognising rather than a bug.
			assert.ok(stdout.includes(sibling), 'the line names the corpus it compared against');
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
