import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	KNOWN_ADAPTER_OPTIONS,
	assertScalarOptions,
	suggestOption,
	unknownOptionWarnings
} from '../../src/adapter-options.js';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// The two-tier option policy. The whole point is the config-file user who gets
// no type checking: a key they misspelled is destructured away and the default
// silently applies, so the knob they think they set does nothing.

test('a clean config produces no warnings', () => {
	assert.deepEqual(unknownOptionWarnings({ out: 'build', precompress: true }), []);
	assert.deepEqual(unknownOptionWarnings({}), []);
	assert.deepEqual(unknownOptionWarnings(undefined), []);
});

test('an unknown top-level key WARNS rather than throwing', () => {
	// Never fatal: an app pinning an older adapter than its config was written
	// for has to keep building, or every option we add is a breaking change.
	const warnings = unknownOptionWarnings({ nonsenseKey: 1 });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /unknown option `nonsenseKey`/);
	assert.match(warnings[0], /having no effect/);
});

test('a misspelling is named with the option it probably meant', () => {
	const [wrongCase] = unknownOptionWarnings({ healthcheckpath: '/x' });
	assert.match(wrongCase, /Did you mean `healthCheckPath`\?/, 'case-only differences always match');

	const [typo] = unknownOptionWarnings({ precomress: true });
	assert.match(typo, /Did you mean `precompress`\?/);

	const [plural] = unknownOptionWarnings({ staticHeader: {} });
	assert.match(plural, /Did you mean `staticHeaders`\?/);
});

test('a key resembling nothing gets no misleading suggestion', () => {
	// A wrong guess is worse than none - it sends someone to rename a key that
	// was never the one they wanted.
	const [warning] = unknownOptionWarnings({ zzzzzzzzzzzz: true });
	assert.match(warning, /unknown option/);
	assert.doesNotMatch(warning, /Did you mean/);
	assert.equal(suggestOption('zzzzzzzzzzzz'), undefined);
});

test('every known option is listed, and suggests itself', () => {
	// Guards the list against drifting from the destructure in index.js: a new
	// option added there but not here would be warned about as unknown, which is
	// a worse failure than the one this file exists to prevent.
	for (const key of KNOWN_ADAPTER_OPTIONS) {
		assert.deepEqual(unknownOptionWarnings({ [key]: null }), [], `${key} is recognised`);
		assert.equal(suggestOption(key), key);
	}
});

test('a non-boolean for a boolean option THROWS, and says why coercion is refused', () => {
	// The worst case in the set: 'no' is truthy, so the option reads as ON while
	// its author plainly meant OFF.
	assert.throws(
		() => assertScalarOptions({ precompress: 'no' }),
		/`precompress` must be true or false/
	);
	assert.doesNotThrow(() => assertScalarOptions({ precompress: false }));
});

test('a non-string for a string option throws', () => {
	assert.throws(() => assertScalarOptions({ out: 42 }), /`out` must be a string/);
	assert.throws(() => assertScalarOptions({ envPrefix: null }), /`envPrefix` must be a string/);
});

test('the websocket-nested options are validated where they now live', () => {
	// `handler`, `path` and `compressCredentialedResponses` moved from the top
	// level into `websocket` to match svelte-adapter-uws, which is the only
	// position that makes a config portable between the two adapters. Their
	// validation moved with them, so it is asserted against the block they are
	// actually read from rather than the one they used to be read from.
	assert.throws(
		() => normalizeWsOptions({ handler: [] }),
		/`websocket.handler` must be a path/
	);
	assert.throws(
		() => normalizeWsOptions({ path: 'ws' }),
		/`websocket.path` must be an absolute path/
	);
	assert.throws(
		() => normalizeWsOptions({ compressCredentialedResponses: 1 }),
		/`websocket.compressCredentialedResponses` must be a boolean/
	);
	const { options } = normalizeWsOptions({ path: '/socket', handler: 'src/ws.js' });
	assert.equal(options.path, '/socket');
	assert.equal(options.handler, 'src/ws.js');
	assert.equal(options.compressCredentialedResponses, false, 'and the default is off');
});

test('healthCheckPath is held to the rule readinessCheckPath already states', () => {
	// Without the leading slash it can never match: the pathname it is compared
	// against always has one, so the probe 404s forever while looking configured.
	assert.throws(
		() => assertScalarOptions({ healthCheckPath: 'healthz' }),
		/must be an absolute path string starting with '\/'/
	);
	assert.throws(() => assertScalarOptions({ healthCheckPath: 8080 }), /absolute path string/);
	assert.doesNotThrow(() => assertScalarOptions({ healthCheckPath: '/healthz' }));
	assert.doesNotThrow(
		() => assertScalarOptions({ healthCheckPath: false }),
		'false disables the route and stays legal'
	);
});

test('options the adapter never received are not invented', () => {
	// `in` rather than a truthiness check: an option absent from the config must
	// not be validated into existence, or every default would have to satisfy
	// the same rules as an explicit value.
	assert.doesNotThrow(() => assertScalarOptions({}));
	assert.doesNotThrow(() => assertScalarOptions(undefined));
});
