import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `env.js` refuses to boot when a prefixed deployment sets a variable the
// adapter does not recognise, which is a good check with one failure mode: a
// name the runtime reads but nobody listed is then refused as a CONFLICT. That
// is how `SHUTDOWN_RECONNECT_WINDOW_MS` - documented, read at boot - made an app
// with `envPrefix` set fail to start.
//
// Read from source rather than imported because `env.js` evaluates ENV_PREFIX at
// module scope and the list is not exported; the point is to compare the lists
// mechanically, which is exactly what human review keeps not doing.

const path = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => readFileSync(path(rel), 'utf8');

/**
 * The names between a marker and the end of its array literal.
 *
 * The end is searched FROM the marker, not from the start of the file: an
 * earlier `];` would otherwise make the slice empty and the comparison vacuous.
 *
 * @param {string} src
 * @param {string} marker
 * @param {string} close
 */
function namesIn(src, marker, close) {
	const start = src.indexOf(marker);
	assert.notEqual(start, -1, `${marker} not found - this test is reading the wrong shape`);
	const end = src.indexOf(close, start);
	assert.notEqual(end, -1, `${close} not found after ${marker}`);
	const names = new Set(
		[...src.slice(start, end).matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1])
	);
	assert.ok(names.size > 5, `${marker} parsed to ${names.size} names, which cannot be right`);
	return names;
}

/** The names `env.js` will accept under a prefix. */
function expectedNames() {
	return namesIn(read('../../src/runtime/env.js'), 'const expected', ']);');
}

/**
 * Every name any runtime module reads through env().
 *
 * WALKED, not a hand-kept file list. A list is maintained by remembering to
 * update it, which is the same habit that produced the bug this file exists to
 * catch - a new module with a new env() call would simply not be looked at.
 */
function readNames() {
	const root = path('../../src/runtime');
	const names = new Set();
	let scanned = 0;
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
		scanned++;
		const src = readFileSync(`${entry.parentPath ?? entry.path}/${entry.name}`, 'utf8');
		for (const m of src.matchAll(/\benv\(\s*'([A-Z0-9_]+)'/g)) names.add(m[1]);
	}
	assert.ok(scanned > 10, `only ${scanned} runtime files scanned, so the walk is broken`);
	assert.ok(names.size > 5, `only ${names.size} env() calls found, so the scan is broken`);
	return names;
}

test('every environment variable the runtime reads is one env.js accepts', () => {
	const expected = expectedNames();
	const missing = [...readNames()].filter((name) => !expected.has(name)).sort();
	assert.deepEqual(
		missing,
		[],
		'read through env() but absent from env.js, so a prefixed deployment setting one is ' +
		`refused at boot: ${missing.join(', ')}`
	);
});

test('env.js accepts nothing the runtime has stopped reading', () => {
	// The other direction. A name left behind after its last reader is deleted
	// is only clutter, but it is also how the list stops describing the runtime
	// and starts being folklore.
	const used = readNames();
	const stale = [...expectedNames()].filter((name) => !used.has(name)).sort();
	assert.deepEqual(stale, [], `accepted by env.js but read nowhere: ${stale.join(', ')}`);
});

test('the live harness clears every environment variable the runtime reads', () => {
	// The suites start their fixture server with the caller's environment, so
	// anything the runtime reads and the harness does not clear is inherited
	// from whatever shell ran the lane - which turns an unrelated export into a
	// failure that gets debugged as an adapter bug.
	const cleared = namesIn(read('../live/harness.mjs'), 'const RUNTIME_ENV_KEYS', '];');
	// HOST and PORT are set deliberately by every suite, so they are not cleared.
	const missing = [...readNames()]
		.filter((name) => name !== 'HOST' && name !== 'PORT' && !cleared.has(name))
		.sort();
	assert.deepEqual(missing, [], `not cleared by test/live/harness.mjs: ${missing.join(', ')}`);
});
