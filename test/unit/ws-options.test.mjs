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
