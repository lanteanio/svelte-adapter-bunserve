import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	KNOWN_ADAPTER_OPTIONS,
	assertScalarOptions,
	suggestOption,
	unknownOptionWarnings
} from '../../src/adapter-options.js';
import { KNOWN_WS_OPTION_KEYS, normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';
import adapter from '../../src/index.js';

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

test('a websocket option written at the top level is pointed at its real home', () => {
	// The likeliest way to lose a real option, and the one a spell-check cannot
	// reach: the key is spelled correctly and simply sits a level too high. No
	// top-level name resembles it, so before this it drew either silence or a
	// suggestion to rename it to something unrelated - while the protection it
	// configures never applied.
	const [warning] = unknownOptionWarnings({ maxPayloadLength: 1024 });
	assert.match(warning, /unknown option `maxPayloadLength`/);
	assert.match(warning, /Did you mean `websocket\.maxPayloadLength`\?/);
});

test('every websocket option can name its own home', () => {
	// Guards the two key sets against drifting apart: a websocket option added
	// later has to be answerable here too, or it becomes the one shape this file
	// cannot explain.
	for (const key of KNOWN_WS_OPTION_KEYS) {
		assert.equal(suggestOption(key), `websocket.${key}`, `${key} names its home`);
	}
});

test('a top-level near-miss is still answered at the top level', () => {
	// The nested home is the LAST answer, not the first. A key that is merely
	// misspelled is still a top-level key, and pointing it into `websocket` would
	// be a worse suggestion than the one it already had.
	assert.equal(suggestOption('staticHeader'), 'staticHeaders');
	assert.equal(suggestOption('healthcheckpath'), 'healthCheckPath');
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

test('a BigInt is refused by the option it names, not by the message builder', () => {
	// `JSON.stringify` THROWS on a BigInt. A diagnostic built with it fails with
	// "Do not know how to serialize a BigInt" - an error about the message
	// builder, naming neither the option nor what it accepts, on a value someone
	// wrote precisely BECAUSE they meant a large integer. The value that is
	// hardest to render is the one most likely to be written here.
	const cases = [
		['readinessCheckPath', /absolute path string/],
		['healthCheckPath', /absolute path string/],
		['precompress', /must be true or false/],
		['staticDotfiles', /must be true or false/],
		['out', /must be a string/]
	];
	for (const [option, accepts] of cases) {
		assert.throws(
			() => adapter({ [option]: 1024n }),
			(err) => {
				assert.match(err.message, new RegExp(option), `${option}: the message names the option`);
				assert.match(err.message, accepts, `${option}: and what it accepts`);
				assert.match(err.message, /1024n/, `${option}: and the value it was given`);
				assert.doesNotMatch(
					err.message,
					/serialize a BigInt/,
					`${option}: the diagnostic must not fail with an error of its own`
				);
				return true;
			}
		);
	}
});

test('a value that resists rendering is still described rather than thrown over', () => {
	// The other shapes JSON.stringify has no answer for. None of them should
	// reach the operator as an error about the error.
	const hostile = [Symbol('nope'), function named() {}, { get x() { throw new Error('getter'); } }];
	for (const value of hostile) {
		assert.throws(
			() => adapter({ precompress: value }),
			(err) => {
				assert.match(err.message, /must be true or false/);
				assert.doesNotMatch(err.message, /getter/, 'a throwing getter does not become the message');
				return true;
			}
		);
	}
});

test('a value that fails every renderer is still refused by the option it names', () => {
	// The renderer behind the diagnostic runs code the value brought with it:
	// `JSON.stringify` calls enumerable getters, and the `[object Tag]` fallback
	// reads Symbol.toStringTag - a getter - and touches a proxy's internals,
	// which a revoked one answers by throwing. A value can therefore defeat the
	// first renderer AND the one guarding it, and the diagnostic written to stop
	// the build with an answer then stops it with a question.
	const twoRenderersDeep = {
		get x() { throw new Error('enumerable getter'); },
		get [Symbol.toStringTag]() { throw new Error('tag getter'); }
	};
	const { proxy: revoked, revoke } = Proxy.revocable({}, {});
	revoke();
	for (const value of [twoRenderersDeep, revoked]) {
		assert.throws(
			() => adapter({ healthCheckPath: value }),
			(err) => {
				assert.match(err.message, /healthCheckPath/, 'the message names the option');
				assert.match(err.message, /absolute path string/, 'and what it accepts');
				assert.doesNotMatch(err.message, /tag getter|enumerable getter/, 'a throwing getter does not become the message');
				assert.doesNotMatch(err.message, /revoked/i, 'nor does the proxy machinery');
				return true;
			}
		);
	}
});

test('an ordinary Symbol.toStringTag still renders, through the tag it declares', () => {
	// The guarded fallback must stay a renderer, not become a blindfold: a value
	// that merely resists JSON (circular) but answers the tag question politely
	// is still shown by its tag.
	const config = { [Symbol.toStringTag]: 'Config' };
	config.self = config;
	assert.throws(
		() => adapter({ healthCheckPath: config }),
		(err) => {
			assert.match(err.message, /healthCheckPath/);
			assert.match(err.message, /\[object Config\]/, 'the tag the value declares is the rendering');
			return true;
		}
	);
});

test('a function whose name is booby-trapped is still refused as a function', () => {
	// Reading `.name` runs a getter. The function branch sits before the guarded
	// renderers, so it is inside the same guard rather than trusted.
	const fn = () => {};
	Object.defineProperty(fn, 'name', { get() { throw new Error('name getter'); } });
	assert.throws(
		() => adapter({ precompress: fn }),
		(err) => {
			assert.match(err.message, /must be true or false/);
			assert.doesNotMatch(err.message, /name getter/);
			return true;
		}
	);
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

test('an options bag that refuses to be read is refused, not crashed on', () => {
	// The factory reads the bag before anything validates it, and a revoked
	// Proxy answers every one of those reads with a native TypeError that
	// names nothing. The bag is copied once at the door instead, and one that
	// cannot be copied is refused in the adapter's own words.
	const p = Proxy.revocable({}, {});
	p.revoke();
	assert.throws(
		() => adapter(/** @type {any} */ (p.proxy)),
		(err) => {
			assert.match(err.message, /adapter options must be a plain object/);
			assert.ok(!/proxy that has been revoked/.test(err.message), 'the native error does not escape');
			return true;
		}
	);
});

test('a CALLABLE value that refuses to be read is refused by name, everywhere', () => {
	// The gap this closes, and the reason it is a sweep rather than two cases:
	// `typeof` reports 'function' for a revoked Proxy built over a callable
	// target, so every gate that routes only `typeof === 'object'` through the
	// guarded copy hands such a value straight to whatever inspects it next.
	// One gate did - `Array.isArray` on it threw "Cannot perform 'IsArray' on a
	// proxy that has been revoked", naming neither the option nor what it
	// accepts - and so did the options bag itself. A gate added later would
	// have the same hole for the same reason, which is what this walks.
	const revokedCallable = () => {
		const { proxy, revoke } = Proxy.revocable(function noop() {}, {});
		revoke();
		return /** @type {any} */ (proxy);
	};
	const nativeThrow = /Cannot perform|proxy that has been revoked/;

	/** @type {[string, (v: any) => any][]} */
	const PLACES = [
		['out', (v) => ({ out: v })],
		['precompress', (v) => ({ precompress: v })],
		['envPrefix', (v) => ({ envPrefix: v })],
		['healthCheckPath', (v) => ({ healthCheckPath: v })],
		['readinessCheckPath', (v) => ({ readinessCheckPath: v })],
		['staticDotfiles', (v) => ({ staticDotfiles: v })],
		['staticHeaders', (v) => ({ staticHeaders: v })],
		["staticHeaders['x-a']", (v) => ({ staticHeaders: { 'x-a': v } })],
		['websocket', (v) => ({ websocket: v })],
		['websocket.allowedOrigins', (v) => ({ websocket: { allowedOrigins: v } })],
		['websocket.allowedOrigins[0]', (v) => ({ websocket: { allowedOrigins: [v] } })],
		['websocket.path', (v) => ({ websocket: { path: v } })],
		['websocket.handler', (v) => ({ websocket: { handler: v } })],
		['websocket.maxPayloadLength', (v) => ({ websocket: { maxPayloadLength: v } })],
		['websocket.idleTimeout', (v) => ({ websocket: { idleTimeout: v } })],
		['websocket.maxBackpressure', (v) => ({ websocket: { maxBackpressure: v } })],
		['websocket.compression', (v) => ({ websocket: { compression: v } })],
		['websocket.pressure', (v) => ({ websocket: { pressure: v } })],
		['websocket.upgradeAdmission', (v) => ({ websocket: { upgradeAdmission: v } })],
		['websocket.upgradeAdmission.maxConcurrent', (v) => ({ websocket: { upgradeAdmission: { maxConcurrent: v } } })],
		['websocket.upgradeAdmission.cursorLane', (v) => ({ websocket: { upgradeAdmission: { cursorLane: v } } })],
		['websocket.upgradeAdmission.cursorLane.fraction', (v) => ({ websocket: { upgradeAdmission: { cursorLane: { fraction: v } } } })],
		['websocket.egress', (v) => ({ websocket: { egress: v } })],
		['websocket.egress.windowMs', (v) => ({ websocket: { egress: { windowMs: v } } })],
		['websocket.egress.topic', (v) => ({ websocket: { egress: { topic: v } } })],
		['websocket.egress.topic.messages', (v) => ({ websocket: { egress: { topic: { messages: v } } } })]
	];

	for (const [label, make] of PLACES) {
		assert.throws(
			() => adapter(make(revokedCallable())),
			(err) => {
				assert.doesNotMatch(err.message, nativeThrow,
					`${label}: the proxy machinery reached the user`);
				return true;
			},
			`${label}: a value that refuses to be read must be refused`
		);
	}
});

test('a callable options bag is refused rather than read as an empty config', () => {
	// Both flavours, and for two different reasons. A revoked callable answers
	// every read with a native throw; an ordinary function answers them all
	// with undefined, so the copy would be `{}` and the build would proceed on
	// silent defaults - the worse of the two, because nothing says anything.
	const { proxy, revoke } = Proxy.revocable(function noop() {}, {});
	revoke();
	for (const bag of [proxy, function config() {}]) {
		assert.throws(
			() => adapter(/** @type {any} */ (bag)),
			(err) => {
				assert.match(err.message, /adapter options must be a plain object/);
				assert.doesNotMatch(err.message, /proxy that has been revoked/);
				return true;
			}
		);
	}
});

test('a throwing getter on the bag lands in the refusal, not in the walk', () => {
	const bomb = { get precompress() { throw new Error('boom from the bag'); } };
	assert.throws(
		() => adapter(/** @type {any} */ (bomb)),
		(err) => {
			assert.match(err.message, /adapter options must be a plain object/);
			assert.ok(!/boom from the bag/.test(err.message), 'the getter error does not escape');
			return true;
		}
	);
});
