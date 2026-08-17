import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeWsOptions,
	toBunWebsocketOptions,
	BUN_IDLE_TIMEOUT_MAX
} from '../../src/runtime/utils/ws-options.js';

test('defaults match svelte-adapter-uws so a ported config behaves the same', () => {
	const { options, warnings, unknownKeys } = normalizeWsOptions(undefined);
	assert.equal(options.maxPayloadLength, 1024 * 1024);
	assert.equal(options.idleTimeout, 120);
	assert.equal(options.maxBackpressure, 1024 * 1024);
	assert.equal(options.closeOnBackpressureLimit, false);
	assert.equal(options.sendPingsAutomatically, true);
	assert.equal(options.compression, false);
	assert.equal(options.allowedOrigins, 'same-origin');
	assert.deepEqual(warnings, []);
	assert.deepEqual(unknownKeys, []);
});

test('the bounds the README documents are the bounds an app gets', () => {
	// The block in README.md that shows every option with its default quotes
	// these literals, and prose cannot import a constant. Every other test
	// reads them through normalizeWsOptions or an imported symbol, so changing
	// one would leave the documented figure wrong with the suite green - which
	// for a BOUND is worse than a stale sentence: an operator sizing a
	// deployment against the documented number would be sizing against a
	// number the server no longer enforces.
	//
	// These are not the parity defaults above. This adapter deliberately caps
	// where the family historically did not, so the numbers are its own.
	const { options } = normalizeWsOptions(undefined);
	assert.equal(options.maxSubscriptionsPerConnection, 10_000);
	assert.equal(options.maxConcurrentSubscribeGates, 64);
	assert.equal(options.maxConcurrentUnsubscribeHooks, 64);
	assert.equal(options.maxQueuedUnsubscribeHooks, 1024);
	assert.equal(options.maxControlEgressBytes, 4 * 1024 * 1024);
	// The three defaults that decide what a client may reach. Each is
	// documented as false, and each is a widening if it flips.
	assert.equal(options.allowNonAsciiTopics, false);
	assert.equal(options.allowSystemTopicSubscribe, false);
	assert.equal(options.allowUnauthenticatedSubscribe, false);
	// Echo policy rather than access control - whether a publisher is sent its
	// own message - but documented as false and pinned for the same reason.
	assert.equal(options.publishToSelf, false);
});

test('the upgrade rate limit defaults to the uws figures', () => {
	const { options } = normalizeWsOptions(undefined);
	assert.equal(options.upgradeRateLimit, 10);
	assert.equal(options.upgradeRateLimitWindow, 10);
});

test('a rate limit of 0 disables the limiter and is not an error', () => {
	assert.equal(normalizeWsOptions({ upgradeRateLimit: 0 }).options.upgradeRateLimit, 0);
});

test('a rate-limit WINDOW of 0 is refused, and says why it is not the way to disable', () => {
	// The two zeroes mean opposite things, which is the trap. Zero LIMIT
	// disables the limiter; zero WINDOW breaks it - every request then looks
	// like a fresh window, the estimate evaluates to NaN, and `NaN >= limit` is
	// false, so everything is admitted while the config says a limit is on.
	assert.throws(
		() => normalizeWsOptions({ upgradeRateLimitWindow: 0 }),
		/upgradeRateLimitWindow.*greater than 0.*does not disable the limiter, it breaks it/s
	);
});

test('an unusable rate limit fails the build rather than disabling itself', () => {
	for (const bad of ['10', null, {}, NaN, Infinity, -1, true]) {
		assert.throws(
			() => normalizeWsOptions({ upgradeRateLimit: bad }),
			/upgradeRateLimit.*finite number/s,
			`refuses ${JSON.stringify(bad) ?? String(bad)}`
		);
		assert.throws(
			() => normalizeWsOptions({ upgradeRateLimitWindow: bad }),
			/upgradeRateLimitWindow/s,
			`refuses window ${JSON.stringify(bad) ?? String(bad)}`
		);
	}
});

test('`metrics` is accepted, named, and not loaded', () => {
	// The key builds, because a config carried from the sibling has to. What it
	// MEANS differs, and honouring it would produce a server that looks
	// instrumented and is not - so the difference is said out loud at build time
	// rather than discovered from a dashboard of zeroes.
	const { options, warnings, unknownKeys } = normalizeWsOptions({ metrics: './src/lib/metrics.js' });
	assert.equal(options.metrics, './src/lib/metrics.js');
	assert.deepEqual(unknownKeys, [], 'not an unknown key - it is a known one with different semantics');
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /does not load it/);
	assert.match(warnings[0], /platform\.metrics/);
	assert.match(warnings[0], /platform\.metricsSnapshot/);
});

test('a `metrics` value that is not a module path still fails the build', () => {
	// Wrong TYPE is a mistake wherever the value was going to be read.
	for (const bad of [true, 42, {}, '']) {
		assert.throws(() => normalizeWsOptions({ metrics: bad }), /websocket.metrics.*module/s,
			`refuses ${JSON.stringify(bad)}`);
	}
});

test('the auth preflight has its own path, guard and budget', () => {
	const { options } = normalizeWsOptions(undefined);
	assert.equal(options.authPath, '/__ws/auth');
	assert.equal(options.authPathRequireOrigin, true);
	// HIGHER than the upgrade door's ten, as uws defaults it: every reconnect
	// that preflights also upgrades, so matching them would make this door the
	// binding constraint on both.
	assert.equal(options.authPathRateLimit, 30);
	assert.equal(options.authPathRateLimitWindow, 10);
});

test('an authPath that is not an absolute path, or collides with the WS path, fails the build', () => {
	assert.throws(() => normalizeWsOptions({ authPath: 'ws-auth' }), /authPath.*starting with/s);
	assert.throws(() => normalizeWsOptions({ authPath: 42 }), /authPath.*absolute path string/s);
	// The WebSocket lane is matched first, so an app would see its preflight
	// answered with a 426 and nothing naming the option.
	assert.throws(
		() => normalizeWsOptions({ authPath: '/ws' }),
		/authPath.*must differ from.*websocket.path/s
	);
	// Including when only ONE of the two moved onto the other's value.
	assert.throws(
		() => normalizeWsOptions({ path: '/__ws/auth' }),
		/authPath.*must differ from/s
	);
});

test('the auth budget takes the same zeroes as the upgrade one, and refuses the same values', () => {
	assert.equal(normalizeWsOptions({ authPathRateLimit: 0 }).options.authPathRateLimit, 0);
	assert.throws(
		() => normalizeWsOptions({ authPathRateLimitWindow: 0 }),
		/authPathRateLimitWindow.*greater than 0.*does not disable the limiter, it breaks it/s
	);
	for (const bad of ['30', null, {}, NaN, Infinity, -1, true]) {
		assert.throws(
			() => normalizeWsOptions({ authPathRateLimit: bad }),
			/authPathRateLimit.*finite number/s,
			`refuses ${JSON.stringify(bad) ?? String(bad)}`
		);
	}
	assert.throws(
		() => normalizeWsOptions({ authPathRequireOrigin: 'no' }),
		/authPathRequireOrigin.*must be a boolean/s
	);
});

test('upgradeTimeout defaults to the ten seconds uws defaults to', () => {
	// A carried config that names no timeout has to get the same bound on both
	// adapters, or the same hung dependency 504s on one and hangs on the other.
	const { options } = normalizeWsOptions(undefined);
	assert.equal(options.upgradeTimeout, 10);
});

test('upgradeTimeout accepts a fractional number of seconds, as uws does', () => {
	// uws guards this one as a protective NUMBER rather than an integer, so
	// `0.5` is a valid config there. Refusing it here would fail a build that
	// succeeds on the sibling, which is the exact difference this parity exists
	// to remove.
	assert.equal(normalizeWsOptions({ upgradeTimeout: 0.5 }).options.upgradeTimeout, 0.5);
	assert.equal(normalizeWsOptions({ upgradeTimeout: 30 }).options.upgradeTimeout, 30);
});

test('upgradeTimeout of 0 disables the bound and is not an error', () => {
	// The documented spelling for "wait indefinitely". It has to be reachable
	// deliberately, because the alternative an app reaches for otherwise is a
	// very large number, which is a different thing.
	assert.equal(normalizeWsOptions({ upgradeTimeout: 0 }).options.upgradeTimeout, 0);
});

test('an unusable upgradeTimeout fails the build rather than disabling itself', () => {
	// The failure this refusal exists for: the runtime compares against this
	// bound, every comparison against a non-number is false, and so a value the
	// normalizer waved through would turn the timeout OFF while the config says
	// it is on. A string is the realistic way to get here - an unconverted
	// environment variable.
	for (const bad of ['10', null, {}, [], NaN, Infinity, -1, -0.5, true]) {
		assert.throws(
			() => normalizeWsOptions({ upgradeTimeout: bad }),
			/upgradeTimeout.*non-negative, finite number/s,
			`refuses ${JSON.stringify(bad) ?? String(bad)}`
		);
	}
});

test('idleTimeout at the Bun ceiling is accepted', () => {
	// 960 accepted, 961 threw - probe/bun-api-facts.report.md, idle-timeout-cap.
	const { options } = normalizeWsOptions({ idleTimeout: BUN_IDLE_TIMEOUT_MAX });
	assert.equal(options.idleTimeout, 960);
});

test('idleTimeout above the Bun ceiling fails the BUILD, not the boot', () => {
	assert.throws(
		() => normalizeWsOptions({ idleTimeout: 961 }),
		/idleTimeout.*961.*960 or less/s
	);
	assert.throws(() => normalizeWsOptions({ idleTimeout: 1200 }), /960 or less/);
});

test('the ceiling error names svelte-adapter-uws as the likely source', () => {
	// A config carried over from the uws adapter is the realistic way to exceed
	// a ceiling only Bun has; the message has to say so or the fix is a guess.
	assert.throws(() => normalizeWsOptions({ idleTimeout: 3600 }), /svelte-adapter-uws/);
});

test('idleTimeout 0 is legal (disables the timeout)', () => {
	const { options } = normalizeWsOptions({ idleTimeout: 0 });
	assert.equal(options.idleTimeout, 0);
});

test('negative or fractional idleTimeout is rejected', () => {
	assert.throws(() => normalizeWsOptions({ idleTimeout: -1 }), /non-negative integer/);
	assert.throws(() => normalizeWsOptions({ idleTimeout: 1.5 }), /non-negative integer/);
});

test('size options must be positive integers', () => {
	assert.throws(() => normalizeWsOptions({ maxPayloadLength: 0 }), /positive integer/);
	assert.throws(() => normalizeWsOptions({ maxPayloadLength: -1 }), /positive integer/);
	assert.throws(() => normalizeWsOptions({ maxBackpressure: 1.5 }), /positive integer/);
});

test('boolean options reject non-booleans', () => {
	assert.throws(() => normalizeWsOptions({ closeOnBackpressureLimit: 'yes' }), /must be a boolean/);
	assert.throws(() => normalizeWsOptions({ sendPingsAutomatically: 1 }), /must be a boolean/);
});

test('numeric uWS compressor translates on/off and warns that tuning was dropped', () => {
	const { options, warnings } = normalizeWsOptions({ compression: 1 });
	assert.equal(options.compression, true);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /numeric/);
	assert.match(warnings[0], /tuning|compressor selection/);
});

test('numeric DISABLED (0) translates to off', () => {
	const { options } = normalizeWsOptions({ compression: 0 });
	assert.equal(options.compression, false);
});

test('the { compress, decompress } object shape is carried through verbatim', () => {
	// Probed as accepted by Bun.serve.
	const shape = { compress: true, decompress: true };
	const { options, warnings } = normalizeWsOptions({ compression: shape });
	assert.deepEqual(options.compression, shape);
	assert.deepEqual(warnings, []);
});

test('a nonsense compression value is rejected', () => {
	assert.throws(() => normalizeWsOptions({ compression: 'fast' }), /websocket.compression/);
});

test('allowedOrigins accepts the keywords and an explicit list', () => {
	assert.equal(normalizeWsOptions({ allowedOrigins: 'any' }).options.allowedOrigins, 'any');
	assert.equal(
		normalizeWsOptions({ allowedOrigins: 'same-origin' }).options.allowedOrigins,
		'same-origin'
	);
	// The family's spelling of 'any'. Rejecting it failed the BUILD of an app
	// whose config is correct on every other adapter in the family.
	assert.equal(normalizeWsOptions({ allowedOrigins: '*' }).options.allowedOrigins, '*');
	assert.deepEqual(
		normalizeWsOptions({ allowedOrigins: ['https://a.example'] }).options.allowedOrigins,
		['https://a.example']
	);
	assert.throws(() => normalizeWsOptions({ allowedOrigins: [''] }), /allowedOrigins/);
	assert.throws(() => normalizeWsOptions({ allowedOrigins: 5 }), /allowedOrigins/);
});

test('unknown keys are reported rather than silently ignored', () => {
	const { unknownKeys } = normalizeWsOptions({ maxPayloadLength: 4096, mxaPayloadLength: 4096 });
	assert.deepEqual(unknownKeys, ['mxaPayloadLength']);
});

test('a non-object websocket option is rejected', () => {
	assert.throws(() => normalizeWsOptions('yes'), /must be an object/);
	assert.throws(() => normalizeWsOptions([]), /must be an object/);
});

test('translation to Bun renames exactly the three renamed keys', () => {
	const { options } = normalizeWsOptions({
		maxPayloadLength: 4096,
		idleTimeout: 30,
		maxBackpressure: 8192,
		closeOnBackpressureLimit: true,
		sendPingsAutomatically: false,
		compression: true
	});
	const bun = toBunWebsocketOptions(options);
	assert.equal(bun.maxPayloadLength, 4096);
	assert.equal(bun.idleTimeout, 30);
	assert.equal(bun.backpressureLimit, 8192);
	assert.equal(bun.closeOnBackpressureLimit, true);
	assert.equal(bun.sendPings, false);
	assert.equal(bun.perMessageDeflate, true);
	assert.equal(bun.publishToSelf, false);
	// The uWS spellings must not leak through: Bun would ignore them silently,
	// so a leaked key means an unenforced backpressure limit in production.
	assert.equal('maxBackpressure' in bun, false);
	assert.equal('sendPingsAutomatically' in bun, false);
	assert.equal('compression' in bun, false);
});

test('allowedOrigins never reaches Bun (it is an adapter-level upgrade decision)', () => {
	const { options } = normalizeWsOptions({ allowedOrigins: ['https://a.example'] });
	assert.equal('allowedOrigins' in toBunWebsocketOptions(options), false);
});

test('websocket.pressure: false and null build, because the sibling accepts both', () => {
	// The family spells a disabled section `false`, and a svelte.config.js that
	// builds against svelte-adapter-uws has to build here - refusing the
	// sibling's own documented spelling at BUILD time is the config-portability
	// break this adapter exists to avoid.
	for (const value of [false, null]) {
		const { options, warnings } = normalizeWsOptions({ pressure: value });
		assert.equal(options.pressure, undefined, `pressure: ${value} resolves to sampler defaults`);
		assert.deepEqual(warnings, [], 'and says nothing, because it is a supported spelling');
	}
});

test('pressure thresholds pass through, and false disables one signal', () => {
	const { options, warnings } = normalizeWsOptions({
		pressure: { publishRatePerSec: 500, memoryHeapUsedRatio: false, sampleIntervalMs: 250 }
	});
	assert.deepEqual(options.pressure, {
		publishRatePerSec: 500, memoryHeapUsedRatio: false, sampleIntervalMs: 250
	});
	assert.deepEqual(warnings, []);
});

test('a pressure block of the wrong TYPE throws, naming the shape it wanted', () => {
	assert.throws(() => normalizeWsOptions({ pressure: 'loud' }), /websocket\.pressure.*object of thresholds/s);
	assert.throws(() => normalizeWsOptions({ pressure: [1, 2] }), /websocket\.pressure.*object of thresholds/s);
	assert.throws(
		() => normalizeWsOptions({ pressure: { publishRatePerSec: 'lots' } }),
		/websocket\.pressure\.publishRatePerSec.*number or false/s
	);
	assert.throws(
		() => normalizeWsOptions({ pressure: { publishRatePerSec: NaN } }),
		/websocket\.pressure\.publishRatePerSec/
	);
	assert.throws(
		() => normalizeWsOptions({ pressure: { sampleIntervalMs: 'often' } }),
		/websocket\.pressure\.sampleIntervalMs.*milliseconds/s
	);
});

test('an out-of-range pressure number is accepted with a warning, never a build failure', () => {
	// Accepted because the sibling accepts it; warned because `>= 0` fires on
	// every sample, which reads as a permanently broken server.
	const zero = normalizeWsOptions({ pressure: { publishRatePerSec: 0 } });
	assert.equal(zero.options.pressure.publishRatePerSec, 0);
	assert.equal(zero.warnings.length, 1);
	assert.match(zero.warnings[0], /fires on every sample/);
	assert.match(zero.warnings[0], /Use `false` to disable it/);

	const low = normalizeWsOptions({ pressure: { sampleIntervalMs: 5 } });
	assert.equal(low.warnings.length, 1);
	assert.match(low.warnings[0], /clamps anything under 100ms/);

	const high = normalizeWsOptions({ pressure: { sampleIntervalMs: 3e9 } });
	assert.equal(high.warnings.length, 1);
	assert.match(high.warnings[0], /silently becomes 1ms/);
});

test('a typo inside the pressure block warns instead of tuning nothing in silence', () => {
	// The whole failure this catches: a misspelled threshold leaves the DEFAULT
	// in place, so the operator's tuning did nothing and no other signal says so.
	const { options, warnings } = normalizeWsOptions({
		pressure: { publishRatePerSecond: 5000, publishRatePerSec: 900 }
	});
	assert.equal(options.pressure.publishRatePerSec, 900, 'the good key still applies');
	assert.equal('publishRatePerSecond' in options.pressure, false, 'the typo is dropped');
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /websocket\.pressure\.publishRatePerSecond/);
	assert.match(warnings[0], /still in effect/);
});

test('pressure never reaches Bun.serve (it is an adapter-level sampler knob)', () => {
	const { options } = normalizeWsOptions({ pressure: { publishRatePerSec: 100 } });
	assert.equal('pressure' in toBunWebsocketOptions(options), false);
});
