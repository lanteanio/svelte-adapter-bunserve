import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The argv guards on scripts/sim-golden.js, driven as a PROCESS because that
// script is a top-level side-effecting entry with no import seam - importing it
// would run the gate.
//
// Only the paths that refuse BEFORE the swarm are exercised: everything that
// reaches the corpus costs a 40-seed run per assertion, and the swarm itself is
// gated by scripts/sim-golden.js in CI. What is pinned here is the class of bug
// this flag keeps producing - a spelling the parser cannot see, which does not
// fail but VANISHES, so the gate runs without the cross-adapter comparison and
// reports success.

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
	const { status, stderr } = run(['--against', '--update']);
	assert.equal(status, 1);
	assert.match(stderr, /--against needs a path/);
	assert.match(stderr, /"--update"/, 'the offending value is echoed, not just the rule');
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
	const { status, stderr } = run(['--against=--update']);
	assert.equal(status, 1);
	assert.match(stderr, /"--update"/);
});
