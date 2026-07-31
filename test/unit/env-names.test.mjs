import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `env.js` refuses to boot when a prefixed deployment sets a variable the
// adapter does not recognise, which is a good check with one failure mode: a
// name the runtime reads but forgot to list is then refused as a CONFLICT. That
// is how `SHUTDOWN_RECONNECT_WINDOW_MS` - documented, read at boot - made an app
// with `envPrefix` set fail to start.
//
// Read from source rather than imported because `env.js` evaluates ENV_PREFIX at
// module scope and the list is not exported; the point is to compare the two
// lists mechanically, which is exactly what a human review keeps not doing.

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** The names `env.js` will accept under a prefix. */
function expectedNames() {
	const src = read('../../src/runtime/env.js');
	const block = src.slice(src.indexOf('const expected'), src.indexOf(']);'));
	return new Set([...block.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]));
}

/** Every name any runtime module actually reads through env(). */
function readNames() {
	const names = new Set();
	for (const file of [
		'../../src/runtime/index.js',
		'../../src/runtime/handler/config.js',
		'../../src/runtime/server.js'
	]) {
		for (const m of read(file).matchAll(/\benv\(\s*'([A-Z0-9_]+)'/g)) names.add(m[1]);
	}
	return names;
}

test('every environment variable the runtime reads is one env.js accepts', () => {
	const expected = expectedNames();
	const used = readNames();
	assert.ok(used.size > 5, 'the scan found the env() calls');
	const missing = [...used].filter((name) => !expected.has(name)).sort();
	assert.deepEqual(
		missing,
		[],
		`read through env() but absent from env.js's expected set, so a prefixed ` +
		`deployment setting one is refused at boot: ${missing.join(', ')}`
	);
});

test('the live harness clears every environment variable the runtime reads', () => {
	// The suites start their fixture server with the caller's environment, so
	// anything the runtime reads and the harness does not clear is inherited
	// from whatever shell ran the lane - which turns an unrelated export into a
	// failure that gets debugged as an adapter bug.
	const harness = read('../live/harness.mjs');
	const block = harness.slice(
		harness.indexOf('const RUNTIME_ENV_KEYS'),
		harness.indexOf('];')
	);
	const cleared = new Set([...block.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]));
	// HOST and PORT are set deliberately by every suite, so they are not cleared.
	const missing = [...readNames()]
		.filter((name) => name !== 'HOST' && name !== 'PORT' && !cleared.has(name))
		.sort();
	assert.deepEqual(missing, [], `not cleared by test/live/harness.mjs: ${missing.join(', ')}`);
});
