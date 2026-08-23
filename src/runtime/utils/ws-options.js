/**
 * WebSocket option normalization (build time) and translation to Bun's
 * `Bun.serve({ websocket })` option names (runtime). Pure and dependency-free:
 * the build calls normalizeWsOptions so a misconfiguration fails the build
 * instead of at the first upgrade, and the runtime calls toBunWebsocketOptions
 * on the already-validated result.
 *
 * The adapter keeps the uWS-shaped option names the family already documents
 * (`maxBackpressure`, `sendPingsAutomatically`, `compression`) rather than
 * exposing Bun's spelling directly: the same svelte.config.js has to work
 * across the family's adapters, and the rename is one pure function. Where the
 * two runtimes genuinely differ - Bun's hard idleTimeout ceiling, uWS's numeric
 * compressor tuning - the difference is handled here, loudly.
 */

/**
 * Bun refuses to construct a server above this: `websocket expects idleTimeout
 * to be 960 or less` (probed - 960 accepted, 961 and 1200 both threw). uWS has
 * no such ceiling, so a config ported from svelte-adapter-uws can carry a value
 * Bun rejects. Caught at build rather than at Bun.serve, where it would be a
 * crash on boot with no adapter context in the message.
 */
export const BUN_IDLE_TIMEOUT_MAX = 960;

/** Adapter defaults, matching svelte-adapter-uws so a ported config behaves the same. */
const DEFAULTS = {
	maxPayloadLength: 1024 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: 'same-origin',
	publishToSelf: false,
	// Both default to the restrictive answer: a topic namespace is easier to
	// widen later than to claw back once clients depend on it.
	allowNonAsciiTopics: false,
	allowSystemTopicSubscribe: false,
	// A real bound on what one connection can pin, not a formality. See
	// handler/ws-state.js for why a cap high enough to never fire is worse than
	// no cap at all.
	maxSubscriptionsPerConnection: 10_000,
	// Authorization gates one connection may have running at once. A SECOND
	// bound, separate from the subscription cap: the cap counts distinct pending
	// topics (so N concurrent subscribes to one topic cost 1, which is right for
	// what can install) and that leaves concurrent APP WORK unbounded. The gate
	// is where an app does its DB round-trip.
	maxConcurrentSubscribeGates: 64,
	// Unsubscribe hooks one connection may have running at once, and how many may
	// WAIT behind them. A THIRD bound rather than a share of the gate counter,
	// because the two lanes have different rights: a subscribe gate may be
	// refused, an unsubscribe hook may only be deferred - dropping it leaks the
	// plugin state the app releases in it. See utils/hook-queue.js.
	maxConcurrentUnsubscribeHooks: 64,
	maxQueuedUnsubscribeHooks: 1024,
	// Control-frame bytes one connection may be sent per 10s window, after
	// which it is closed. The ack channel is inherently amplifying - a client
	// names a topic in a few bytes and is answered with a whole frame - and the
	// acks cannot be collapsed without breaking the family client.
	maxControlEgressBytes: 4 * 1024 * 1024,
	// When no `subscribe` hook is exported, every topic is readable by every
	// client. That has to be opted into rather than arrived at by omission.
	allowUnauthenticatedSubscribe: false,
	// Pressure-sampler thresholds (see handler/pressure-metrics.js for the
	// defaults and each signal's meaning). undefined means "sampler defaults";
	// the sampler always runs when the WS surface exists, so this only TUNES.
	pressure: undefined,
	// Upgrades one client address may make per window, and how long that window
	// is in seconds. Both uws's numbers. `upgradeRateLimit: 0` disables the
	// limiter; the WINDOW refuses zero, because a zero window does not disable
	// anything - it makes every request look like a fresh window, which admits
	// everything (see the validator).
	upgradeRateLimit: 10,
	upgradeRateLimitWindow: 10,
	// How long the app's `upgrade` hook may take, in seconds, before the
	// handshake is refused with a 504. Seconds and a default of 10 because that
	// is what uws declares; `0` disables it. It bounds the HOOK, not the
	// handshake: a hook that awaits a database or an identity provider is the
	// thing that hangs, and a hung handshake holds an admission slot and a
	// connection permit the whole time it waits.
	upgradeTimeout: 10,
	// Admission control for the upgrade path: concurrent-handshake ceiling,
	// whole-lifetime connection ceiling, per-tick pacing with a finite queue,
	// and the deprioritised cursor lane. undefined means every layer is off,
	// which is the uws default and the backward-compatible one. See
	// utils/upgrade-admission.js; the block is spelled exactly as uws spells it
	// so a config carried between the adapters gates the same way in both.
	upgradeAdmission: undefined,
	// The path to an operator's metrics module, as uws declares it. ACCEPTED so a
	// carried config builds, and NOT LOADED - see the validator for why a module
	// cannot own the registry on this runtime.
	metrics: undefined,
	// Build-time rather than transport tuning, and nested HERE rather than at the
	// top level because that is where svelte-adapter-uws declares them. The two
	// adapters are drop-in replacements for each other, so a `websocket` block
	// has to mean the same thing in both: spelling these `websocketHandler` and
	// `websocketPath` at the top level made a carried-over config silently not
	// apply, since the other adapter reads the key it does not find and warns
	// about the one it does.
	handler: 'src/ws-handler.js',
	path: '/ws',
	// Where the auth preflight POST is served, when the handler exports an
	// `authenticate` hook. uws's path, because the family client store is the
	// thing that calls it and it has one address for both adapters. The `__`
	// prefix is what makes it obviously not a page; Cloudflare Access is the
	// documented reason an app would move it.
	authPath: '/__ws/auth',
	// Preflights one client address may make per window, and how long that window
	// is in seconds. Both uws's numbers, and the limit is HIGHER than the upgrade
	// door's on purpose: every reconnect that preflights also upgrades, so this
	// door sees at least as much traffic during a reconnect wave, and matching
	// them 1:1 would make the preflight the binding constraint on both. Zero
	// disables it; the WINDOW refuses zero, for the reason the upgrade window
	// does.
	authPathRateLimit: 30,
	authPathRateLimitWindow: 10,
	// Whether that endpoint requires evidence the request came from a page this
	// server trusts (CSRF defense). On by default, and off is how a native client
	// that sends none of those headers is accepted.
	authPathRequireOrigin: true,
	// Also uws-nested: whether a Vary-on-credentials response may be compressed.
	compressCredentialedResponses: false
};

/** Every `websocket.*` key this adapter consumes. */
export const KNOWN_WS_OPTION_KEYS = new Set(Object.keys(DEFAULTS));

/**
 * Keys the build ACCEPTS so a config carried from svelte-adapter-uws still
 * builds, and deliberately does not honour. Each one warns at build time saying
 * what this adapter does instead.
 *
 * Declared here rather than inferred, because "accepted" and "honoured" are two
 * different questions and only one of them is answered by
 * {@link KNOWN_WS_OPTION_KEYS}. A key in this set is a PARITY GAP - the feature
 * is not implemented - and the parity oracle reads this set so it cannot report
 * one as at parity merely because the validator stopped calling it unknown.
 * Removing a key from here is part of implementing it.
 *
 * @type {ReadonlySet<string>}
 */
export const INERT_WS_OPTION_KEYS = new Set(['metrics']);

/**
 * Render a rejected option value for a message that must not itself fail.
 *
 * `JSON.stringify` is the obvious choice and the wrong one: it THROWS on a
 * BigInt, so `upgradeRateLimit: 10n` failed the build with "Do not know how to
 * serialize a BigInt" - an error about the message builder, naming neither the
 * option nor what it accepts, on a value someone wrote precisely because they
 * meant a large integer. It also returns `undefined` for a function or a bare
 * `undefined`, which reads as the word "undefined" pasted into the sentence.
 *
 * Every other value renders exactly as `JSON.stringify` renders it, so the
 * messages read as they always did.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
	if (typeof value === 'bigint') return `${value}n`;
	if (typeof value === 'symbol') return String(value);
	if (typeof value === 'function') return `[Function${value.name ? ' ' + value.name : ''}]`;
	try {
		const shown = JSON.stringify(value);
		// `undefined` for a value JSON has no representation for.
		return shown === undefined ? String(value) : shown;
	} catch {
		// A circular object, or one whose getters throw. The tag form renders
		// anything, and a message about a bad value must not fail with a
		// different error than the one it was written to report.
		return Object.prototype.toString.call(value);
	}
}

/**
 * A NUMBER that bounds the upgrade gate.
 *
 * CHECKED HERE, at build time, because two of the four fail SILENTLY at the
 * other end. `createUpgradeAdmission` reads `maxConcurrent` and `perTickBudget`
 * as `(opts && opts.x) || 0`, and a non-empty string is truthy, so the string
 * survives as the bound: `inFlight >= 'abc'` is false forever and the concurrency
 * ceiling is off while the config says it is on. `perTickBudget` is worse than
 * off - the string also fails the `<= 0` test that would run callbacks inline,
 * while leaving the deferred ceiling at 0, so the pacing queue is full on
 * arrival and every upgrade is refused. Neither says anything.
 *
 * A NON-NEGATIVE SAFE INTEGER, which is what uws requires of all four. It used
 * to range-check only two of them and take a fractional value for the rest, and
 * this adapter matched that deliberately - refusing a value uws runs would turn
 * a working deployment into a build failure on the way across. uws has since
 * tightened all four, so matching it now means tightening too: a count is a
 * whole number of things, and `maxConcurrent: 1.5` was never a bound anyone
 * meant.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {number}
 */
function requireAdmissionCount(value, key) {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
	throw new Error(
		'adapter option `websocket.upgradeAdmission.' + key + '` must be a non-negative safe ' +
		'integer - got ' +
		describeValue(value) + '. This option bounds a resource, and every comparison against a ' +
		'non-number is false, so an unrecognized value does not fall back to the default: it ' +
		'turns the bound off, or refuses every upgrade. If the value comes from the ' +
		'environment, convert it explicitly (e.g. Number(process.env.WS_MAX_CONCURRENT)).'
	);
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {number}
 */
function requirePositiveInt(value, key) {
	if (!Number.isInteger(value) || /** @type {number} */ (value) <= 0) {
		throw new Error(
			`adapter option \`websocket.${key}\` must be a positive integer, got ${describeValue(value)}.`
		);
	}
	return /** @type {number} */ (value);
}

/**
 * A bound that PROTECTS a resource: any finite number at or above the floor.
 *
 * Not an integer check, because uws guards these as protective numbers and a
 * config valid there has to build here. Not a silent fallback either: the
 * runtime compares against these, every comparison against a non-number is
 * false, and so a value waved through would turn the bound OFF while the config
 * says it is on. A string is the realistic way to get here - an unconverted
 * environment variable.
 *
 * `min` is the smallest MEANINGFUL non-zero value, where a bound has one. Any
 * positive number is accepted by default, which is right for a count and wrong
 * for a duration: a knob whose unit is seconds has values that are arithmetically
 * positive and operationally the same as off, and "greater than zero" lets every
 * one of them through.
 *
 * @param {unknown} value
 * @param {string} key
 * @param {{ allowZero?: boolean, zeroMeans?: string, min?: number, minMeans?: string }} [opts]
 * @returns {number}
 */
function requireProtectiveNumber(
	value,
	key,
	{ allowZero = true, zeroMeans = '', min = Number.MIN_VALUE, minMeans = '' } = {}
) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		if (value === 0) {
			if (allowZero) return value;
			throw new Error(`adapter option \`websocket.${key}\` must be greater than 0. ${zeroMeans}`);
		}
		if (value >= min) return value;
		if (value > 0) {
			throw new Error(
				`adapter option \`websocket.${key}\` must be at least ${min}, got ${describeValue(value)}. ` +
				minMeans
			);
		}
	}
	// The bound reads as a range rather than as a comparison against a phrase:
	// spelled `>= ${allowZero ? 0 : 'greater than 0'}` this said "must be a
	// finite number >= greater than 0", which is the line an operator sees on
	// the realistic failure - an environment variable that was never converted.
	const bound = allowZero ? '>= 0' : min > Number.MIN_VALUE ? `>= ${min}` : '> 0';
	throw new Error(
		`adapter option \`websocket.${key}\` must be a finite number ${bound}, ` +
		`got ${describeValue(value)}. This option bounds a resource, and every comparison against a ` +
		'non-number is false - so an unrecognized value would disable the bound entirely rather than ' +
		'fall back to the default. If the value comes from the environment, convert it explicitly ' +
		`(e.g. Number(process.env.WS_${key.toUpperCase()})).`
	);
}

/**
 * The largest `maxPayloadLength`, in BYTES.
 *
 * uws's bound, adopted so a config cannot be tuned here and refused there. It
 * hands the limit to a receiver that stores it in a fixed-width integer and
 * truncates anything larger, which reports the configured figure back while
 * enforcing a different one. Bun has no such limit and accepts 3000000000
 * without complaint, so nothing but this line would catch it.
 */
const MAX_PAYLOAD_LENGTH_CEILING = 0x7fffffff;

/**
 * The shortest rate-limit window, in SECONDS.
 *
 * ONE SECOND, because that is the family's floor: svelte-adapter-uws refuses
 * anything below 1 for every protective number that does not allow zero, so a
 * smaller value here would build on one adapter and fail the build on the other
 * - the failure the whole parity effort exists to remove. It is also the
 * smallest window that means anything as a rate: below it the limit stops being
 * "N per window" and becomes a burst cap on whatever fraction of a second the
 * requests happen to land in.
 *
 * Zero is refused separately and for a different reason: it makes the sliding
 * estimate divide by zero, and `NaN >= limit` is false, so the door admits
 * everything while the config says a limit is in force. That arithmetic does
 * NOT carry over to small non-zero values - the clock this runs on is
 * fractional, so a half-millisecond window counts and refuses exactly as
 * configured. It is simply not a window anyone means.
 */
const MIN_RATE_LIMIT_WINDOW = 1;

/** Keys the `websocket.upgradeAdmission` block accepts, as uws declares them. */
const ADMISSION_KEYS = new Set([
	'maxConcurrent', 'maxConnections', 'perTickBudget', 'maxDeferred', 'cursorLane', 'waitingRoom'
]);

/**
 * Validate the `websocket.upgradeAdmission` block.
 *
 * WARNS where uws warns and ACCEPTS what uws accepts, which is the whole
 * constraint: the adapters are drop-in replacements in both directions, so a
 * block that builds there has to build here. Refusing a value uws merely
 * clamps would turn a working deployment into a build failure on the way
 * across, which is a worse outcome than the sloppy value it was refusing.
 *
 * So the value ranges are NOT re-litigated here. `createUpgradeAdmission`
 * enforces exactly what uws enforces - the two integer ceilings - and clamps
 * the cursor fraction the same way; this pass checks the SHAPE and names keys
 * that will not be read, which is the failure an operator cannot otherwise
 * see.
 *
 * @param {unknown} value
 * @param {string[]} warnings
 * @returns {{ maxConcurrent?: number, maxConnections?: number, perTickBudget?: number, maxDeferred?: number, cursorLane?: { fraction?: number } }}
 */
function requireUpgradeAdmission(value, warnings) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(
			'adapter option `websocket.upgradeAdmission` must be an object, e.g. ' +
			'{ maxConcurrent: 1000, maxConnections: 50000, perTickBudget: 64 }.'
		);
	}
	const raw = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(raw)) {
		if (!ADMISSION_KEYS.has(key)) {
			warnings.push(
				`unknown adapter option \`websocket.upgradeAdmission.${key}\` is ignored, so the bound it ` +
				`was meant to set is not applied. Known keys are ${[...ADMISSION_KEYS].join(', ')}.`
			);
		}
	}
	/** @type {Record<string, unknown>} */
	const out = {};
	// CHECKED, not waved past. The rationale for passing these through was that
	// createUpgradeAdmission applies the rules, which is true of maxConnections and
	// maxDeferred - it refuses both as non-negative safe integers - and false of the
	// other two, which it reads through `|| 0` and never examines again. What each
	// of those then does to a running server is in requireAdmissionCount.
	for (const key of ['maxConcurrent', 'maxConnections', 'perTickBudget', 'maxDeferred']) {
		if (raw[key] !== undefined) out[key] = requireAdmissionCount(raw[key], key);
	}
	if (raw.cursorLane !== undefined) {
		if (raw.cursorLane === null || typeof raw.cursorLane !== 'object' || Array.isArray(raw.cursorLane)) {
			throw new Error(
				'adapter option `websocket.upgradeAdmission.cursorLane` must be an object, e.g. { fraction: 0.25 }.'
			);
		}
		const lane = /** @type {Record<string, unknown>} */ (raw.cursorLane);
		for (const key of Object.keys(lane)) {
			if (key !== 'fraction') {
				warnings.push(
					`unknown adapter option \`websocket.upgradeAdmission.cursorLane.${key}\` is ignored; ` +
					'the only key is fraction.'
				);
			}
		}
		// Preserved even when empty: `cursorLane: {}` is what ENABLES the lane at
		// the default fraction, so dropping an empty object would silently turn
		// the feature off. A fraction that IS a number is clamped by the controller
		// rather than refused, as uws clamps it - but it has to be one first. The
		// controller tests `typeof fraction === 'number'` and falls back to 0.25 when
		// it is not, so a typo did not fail: it bought a reserved lane sized by a
		// default nobody chose, and said nothing.
		if (lane.fraction !== undefined &&
			(typeof lane.fraction !== 'number' || !Number.isFinite(lane.fraction))) {
			throw new Error(
				'adapter option `websocket.upgradeAdmission.cursorLane.fraction` must be a finite ' +
				`number - got ${describeValue(lane.fraction)}. A non-number is not refused by the ` +
				'controller, it is silently read as the default, so the lane would be sized by ' +
				'something nobody asked for.'
			);
		}
		out.cursorLane = lane.fraction === undefined ? {} : { fraction: lane.fraction };
	}
	// ACCEPTED AND NAMED, because this adapter has no holding page. uws serves
	// one by default whenever an admission layer is set, and `false` is its
	// documented opt-out - so refusing the key outright would fail the build for
	// the config a careful uws operator writes. A crossed ceiling answers 503
	// here either way; what an object asks for is a page that does not exist,
	// and saying so is the difference between a known gap and a silent one.
	if (raw.waitingRoom !== undefined && raw.waitingRoom !== false) {
		warnings.push(
			'adapter option `websocket.upgradeAdmission.waitingRoom` is not implemented by this adapter: ' +
			'a crossed ceiling answers 503 with retry-after rather than serving a holding page. ' +
			'svelte-adapter-uws serves one; set it to `false` to state that intent explicitly here.'
		);
	}
	return out;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {boolean}
 */
function requireBoolean(value, key) {
	if (typeof value !== 'boolean') {
		throw new Error(
			`adapter option \`websocket.${key}\` must be a boolean, got ${describeValue(value)}.`
		);
	}
	return value;
}

/**
 * The pressure-threshold keys that accept a number or `false` (false disables
 * that signal). `sampleIntervalMs` is number-only and validated separately.
 */
const PRESSURE_SIGNAL_KEYS = [
	'memoryHeapUsedRatio', 'publishRatePerSec', 'subscriberRatio',
	'topicPublishRatePerSec', 'topicPublishBytesPerSec',
	'psiCpuSome', 'psiMemoryFull', 'psiIoFull', 'cpuThrottledRatio'
];

/**
 * The floor the sampler clamps `sampleIntervalMs` to, and the ceiling past
 * which a timer delay stops meaning what it says: above 2^31-1 ms both
 * runtimes silently fall back to a 1 ms interval, which would turn a config
 * asking for a RARE sample into a ~1 kHz one, each tick paying a memory read,
 * a kernel-file read and a bounded connection walk.
 */
export const PRESSURE_INTERVAL_MIN_MS = 100;
export const PRESSURE_INTERVAL_MAX_MS = 2 ** 31 - 1;

/**
 * Validate the `websocket.pressure` block, warning rather than refusing
 * wherever the sibling adapter accepts a value: a `svelte.config.js` that
 * builds against svelte-adapter-uws has to build here, so `false` (the
 * family's spelling for "this whole section is off"), `null`, and
 * out-of-range numbers are all accepted and reported, never thrown on. Wrong
 * TYPES still throw, which is this adapter's documented two-tier policy and
 * matches what the sibling's own types declare.
 *
 * Unknown nested keys are warned about, because a typo'd threshold leaves the
 * DEFAULT silently in place - the operator's tuning did nothing and there is
 * no other signal. The sibling walks its nested sections for the same reason.
 *
 * @param {unknown} value
 * @param {string[]} warnings - build-time warnings, appended in place
 * @returns {Record<string, unknown> | undefined} thresholds, or undefined for the defaults
 */
function requirePressureThresholds(value, warnings) {
	// `false`/`null` mean "leave the sampler alone": the family spells a
	// disabled section that way, and the sampler is not optional here (it is
	// what platform.pressure reads), so both resolve to plain defaults.
	if (value === false || value === null) return undefined;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(
			'adapter option `websocket.pressure` must be an object of thresholds (or `false`), e.g. ' +
			'{ publishRatePerSec: 5000, sampleIntervalMs: 1000 }, got ' + describeValue(value) + '.'
		);
	}
	const raw = /** @type {Record<string, unknown>} */ (value);
	/** @type {Record<string, unknown>} */
	const out = {};

	for (const key of Object.keys(raw)) {
		const v = raw[key];
		if (key === 'sampleIntervalMs') continue; // handled below
		if (!PRESSURE_SIGNAL_KEYS.includes(key)) {
			warnings.push(
				`unknown adapter option \`websocket.pressure.${key}\` is ignored, so the default for ` +
				'the threshold you meant to set is still in effect. Known thresholds: ' +
				PRESSURE_SIGNAL_KEYS.join(', ') + ', sampleIntervalMs.'
			);
			continue;
		}
		if (v === undefined || v === false) {
			out[key] = v;
			continue;
		}
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			throw new Error(
				`adapter option \`websocket.pressure.${key}\` must be a number or false ` +
				`(false disables the signal), got ${describeValue(v)}.`
			);
		}
		if (v <= 0) {
			// Accepted for portability, but a zero or negative threshold is
			// matched with `sample >= threshold`, so the signal fires on every
			// single sample - permanent pressure, which reads as a broken
			// server rather than as the "off" the author probably meant.
			warnings.push(
				`adapter option \`websocket.pressure.${key}\` is ${describeValue(v)}, so that signal ` +
				'fires on every sample (thresholds are compared with >=). Use `false` to disable it.'
			);
		}
		out[key] = v;
	}

	if (raw.sampleIntervalMs !== undefined) {
		const v = raw.sampleIntervalMs;
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			throw new Error(
				'adapter option `websocket.pressure.sampleIntervalMs` must be a number of milliseconds, ' +
				`got ${describeValue(v)}.`
			);
		}
		if (v < PRESSURE_INTERVAL_MIN_MS) {
			warnings.push(
				`\`websocket.pressure.sampleIntervalMs\` is ${v}ms; the sampler clamps anything under ` +
				`${PRESSURE_INTERVAL_MIN_MS}ms back to the 1000ms default rather than spin.`
			);
			out.sampleIntervalMs = v;
		} else if (v > PRESSURE_INTERVAL_MAX_MS) {
			// Left to the sampler's own clamp so the runtime is safe however
			// the value arrives, but warned here because a build-time warning
			// is the only place the author sees it.
			warnings.push(
				`\`websocket.pressure.sampleIntervalMs\` is ${v}ms, past the ${PRESSURE_INTERVAL_MAX_MS}ms ` +
				'timer ceiling; it is capped there, because a larger delay silently becomes 1ms.'
			);
			out.sampleIntervalMs = v;
		} else {
			out.sampleIntervalMs = v;
		}
	}

	return out;
}

/**
 * @typedef {Object} NormalizedWsOptions
 * @property {Record<string, any>} options - adapter-shaped, fully defaulted
 * @property {string[]} warnings - build-time warnings (best-effort translations)
 * @property {string[]} unknownKeys - keys the adapter does not consume
 */

/**
 * Validate and default the `websocket` adapter option.
 *
 * @param {unknown} input - the raw `websocket` option value
 * @returns {NormalizedWsOptions}
 */
export function normalizeWsOptions(input) {
	if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
		throw new Error(
			'adapter option `websocket` must be an object, e.g. ' +
			"{ maxPayloadLength: 1048576, idleTimeout: 120 }."
		);
	}
	const raw = /** @type {Record<string, unknown>} */ (input || {});
	/** @type {string[]} */
	const warnings = [];
	const options = { ...DEFAULTS };

	// INTEGERS, and for two different reasons now.
	//
	// Bun validates both itself and refuses a fractional one outright ("websocket
	// expects maxPayloadLength to be an integer", and the same for
	// backpressureLimit), so accepting one here would trade a build error for a
	// server that does not start - the worse of the two by the whole distance
	// between build time and deploy time. That is the ONLY reason for
	// `maxBackpressure`, which uws still takes as any finite number at or above 1,
	// so this adapter stays narrower there and the difference stays recorded.
	//
	// `maxPayloadLength` also has a CEILING, and that one is uws's: it hands the
	// bound to a receiver that stores it in a fixed-width integer and truncates
	// anything larger, so past the ceiling the configured figure is reported back
	// while a different one is enforced. Bun takes 3000000000 without complaint,
	// which is exactly why the bound has to be stated here - a config tuned
	// against Bun alone would fail the build on uws.
	//
	// Pinned rather than left as prose: api-parity.test.mjs drives both accepted
	// ranges and fails if either stops being true in either direction.
	if (raw.maxPayloadLength !== undefined) {
		options.maxPayloadLength = requirePositiveInt(raw.maxPayloadLength, 'maxPayloadLength');
		if (options.maxPayloadLength > MAX_PAYLOAD_LENGTH_CEILING) {
			throw new Error(
				'adapter option `websocket.maxPayloadLength` must be no greater than ' +
				MAX_PAYLOAD_LENGTH_CEILING + ' - got ' + describeValue(raw.maxPayloadLength) + '. ' +
				'Bun takes a larger bound without complaint and svelte-adapter-uws refuses it, so a ' +
				'config tuned here would fail the build there. The reason is uws\'s receiver: it stores ' +
				'this limit in a fixed-width integer, so past this point the figure you configured is ' +
				'reported back while a truncated one is enforced.'
			);
		}
	}
	if (raw.maxBackpressure !== undefined) {
		options.maxBackpressure = requirePositiveInt(raw.maxBackpressure, 'maxBackpressure');
	}
	if (raw.upgradeRateLimit !== undefined) {
		options.upgradeRateLimit = requireProtectiveNumber(
			raw.upgradeRateLimit,
			'upgradeRateLimit',
			{ allowZero: true }
		);
	}
	if (raw.upgradeRateLimitWindow !== undefined) {
		// The WINDOW refuses zero where the limit accepts it, and the two zeroes
		// mean opposite things. Setting the LIMIT to zero disables the limiter;
		// setting the WINDOW to zero breaks it - every request then looks like a
		// fresh window, the sliding estimate divides by zero and evaluates to
		// NaN, and `NaN >= limit` is false, so everything is admitted while the
		// config says a limit is in force.
		options.upgradeRateLimitWindow = requireProtectiveNumber(
			raw.upgradeRateLimitWindow,
			'upgradeRateLimitWindow',
			{
				allowZero: false,
				zeroMeans: 'A zero WINDOW does not disable the limiter, it breaks it: every request ' +
					'then looks like a fresh window, the estimate evaluates to NaN, and NaN >= limit ' +
					'is false - so everything is admitted. Set `upgradeRateLimit` itself to 0 to ' +
					'disable the limit deliberately.',
				min: MIN_RATE_LIMIT_WINDOW,
				minMeans: 'A window shorter than a second is not a rate - it is a burst cap on whatever ' +
					'fraction of a second the requests land in - and svelte-adapter-uws refuses it, so ' +
					'a config carried between the two adapters would build here and fail there. Set ' +
					'`upgradeRateLimit` itself to 0 to disable the limit deliberately.'
			}
		);
	}
	if (raw.authPathRateLimit !== undefined) {
		options.authPathRateLimit = requireProtectiveNumber(
			raw.authPathRateLimit,
			'authPathRateLimit',
			{ allowZero: true }
		);
	}
	if (raw.authPathRateLimitWindow !== undefined) {
		// Zero is refused here and accepted on the limit, exactly as at the
		// upgrade door and for the same arithmetic: a zero window makes every
		// request look like a fresh one, the sliding estimate divides by zero and
		// evaluates to NaN, and `NaN >= limit` is false - so everything is
		// admitted while the config says a limit is in force.
		options.authPathRateLimitWindow = requireProtectiveNumber(
			raw.authPathRateLimitWindow,
			'authPathRateLimitWindow',
			{
				allowZero: false,
				zeroMeans: 'A zero WINDOW does not disable the limiter, it breaks it: every request ' +
					'then looks like a fresh window, the estimate evaluates to NaN, and NaN >= limit ' +
					'is false - so everything is admitted. Set `authPathRateLimit` itself to 0 to ' +
					'disable the limit deliberately.',
				min: MIN_RATE_LIMIT_WINDOW,
				minMeans: 'A window shorter than a second is not a rate - it is a burst cap on whatever ' +
					'fraction of a second the requests land in - and svelte-adapter-uws refuses it, so ' +
					'a config carried between the two adapters would build here and fail there. Set ' +
					'`authPathRateLimit` itself to 0 to disable the limit deliberately.'
			}
		);
	}
	if (raw.upgradeTimeout !== undefined) {
		const seconds = raw.upgradeTimeout;
		// Any finite non-negative NUMBER, not an integer. uws guards this one as
		// a protective number rather than an integer, so `upgradeTimeout: 0.5` is
		// a valid config there - and a config that builds on one adapter and
		// throws on the other is the exact failure this parity exists to remove.
		// The bound is protective, so a non-number cannot fall back to the
		// default: every comparison against one is false, which would disable the
		// timeout rather than restore it.
		if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
			throw new Error(
				'adapter option `websocket.upgradeTimeout` must be a non-negative, finite number of ' +
				`seconds, got ${describeValue(seconds)}. Use 0 to disable the timeout deliberately; ` +
				'anything unrecognized would disable it silently, because a comparison against a ' +
				'non-number is false. If the value comes from the environment, convert it explicitly ' +
				'(e.g. Number(process.env.WS_UPGRADE_TIMEOUT)).'
			);
		}
		options.upgradeTimeout = seconds;
	}
	if (raw.idleTimeout !== undefined) {
		const idle = raw.idleTimeout;
		// 0 is legal here (disables the timeout) so this is not requirePositiveInt.
		//
		// An INTEGER for the same reason the two bounds above are one: Bun refuses a
		// fractional idleTimeout when the server is constructed, so uws taking 0.5
		// is a difference this adapter cannot close by accepting it. Both this and
		// the ceiling below are recorded against uws's accepted range in
		// api-parity.test.mjs, so neither can quietly stop being true.
		if (!Number.isInteger(idle) || /** @type {number} */ (idle) < 0) {
			throw new Error(
				'adapter option `websocket.idleTimeout` must be a non-negative integer number of seconds, ' +
				`got ${describeValue(idle)}.`
			);
		}
		if (/** @type {number} */ (idle) > BUN_IDLE_TIMEOUT_MAX) {
			throw new Error(
				`adapter option \`websocket.idleTimeout\` is ${idle} seconds, but Bun refuses any value above ` +
				`${BUN_IDLE_TIMEOUT_MAX} ("websocket expects idleTimeout to be 960 or less"). ` +
				'uWS has no such ceiling, so a config carried over from svelte-adapter-uws can exceed it. ' +
				`Lower it to ${BUN_IDLE_TIMEOUT_MAX} or less.`
			);
		}
		options.idleTimeout = /** @type {number} */ (idle);
	}
	if (raw.closeOnBackpressureLimit !== undefined) {
		options.closeOnBackpressureLimit = requireBoolean(raw.closeOnBackpressureLimit, 'closeOnBackpressureLimit');
	}
	if (raw.sendPingsAutomatically !== undefined) {
		options.sendPingsAutomatically = requireBoolean(raw.sendPingsAutomatically, 'sendPingsAutomatically');
	}
	if (raw.publishToSelf !== undefined) {
		options.publishToSelf = requireBoolean(raw.publishToSelf, 'publishToSelf');
	}
	if (raw.allowNonAsciiTopics !== undefined) {
		options.allowNonAsciiTopics = requireBoolean(raw.allowNonAsciiTopics, 'allowNonAsciiTopics');
	}
	if (raw.allowSystemTopicSubscribe !== undefined) {
		options.allowSystemTopicSubscribe = requireBoolean(raw.allowSystemTopicSubscribe, 'allowSystemTopicSubscribe');
	}
	if (raw.allowUnauthenticatedSubscribe !== undefined) {
		options.allowUnauthenticatedSubscribe = requireBoolean(raw.allowUnauthenticatedSubscribe, 'allowUnauthenticatedSubscribe');
	}
	if (raw.pressure !== undefined) {
		options.pressure = requirePressureThresholds(raw.pressure, warnings);
	}
	if (raw.upgradeAdmission !== undefined) {
		options.upgradeAdmission = requireUpgradeAdmission(raw.upgradeAdmission, warnings);
	}
	if (raw.compressCredentialedResponses !== undefined) {
		options.compressCredentialedResponses = requireBoolean(
			raw.compressCredentialedResponses,
			'compressCredentialedResponses'
		);
	}
	if (raw.handler !== undefined) {
		if (typeof raw.handler !== 'string' || raw.handler.length === 0) {
			throw new Error(
				'adapter option `websocket.handler` must be a path to the module exporting your ' +
				`WebSocket hooks (e.g. 'src/ws-handler.js') - got ${describeValue(raw.handler)}.`
			);
		}
		options.handler = raw.handler;
	}
	if (raw.path !== undefined) {
		if (typeof raw.path !== 'string' || raw.path[0] !== '/') {
			throw new Error(
				"adapter option `websocket.path` must be an absolute path string starting with '/' " +
				`(e.g. '/ws') - got ${describeValue(raw.path)}.`
			);
		}
		options.path = raw.path;
	}
	if (raw.metrics !== undefined) {
		// The TYPE is still checked, because a config that names something other
		// than a module path is a mistake wherever it is going to be read.
		if (typeof raw.metrics !== 'string' || raw.metrics.length === 0) {
			throw new Error(
				'adapter option `websocket.metrics` must be a path to a module whose default export is a ' +
				`metrics registry (e.g. './src/lib/metrics.js') - got ${describeValue(raw.metrics)}.`
			);
		}
		// NOT STORED. The type check above is worth doing wherever the value was
		// going to be read, but keeping the value would leave one `ws_options.metrics`
		// read between here and a build that honours the option - at which point
		// the key would be honoured, the warning would still fire, and the parity
		// list would still call it a gap. An inert key that holds nothing cannot
		// become live by accident.
		// ACCEPTED AND NAMED, exactly as `upgradeAdmission.waitingRoom` is, and for
		// a sharper reason: honouring it would produce a server that LOOKS
		// instrumented and is not. On this runtime a module imported by both a
		// SvelteKit route and the WebSocket handler is two separate copies in the
		// build - SvelteKit's server bundle is bundled before the adapter's own
		// pass reads the handler - so the adapter would write into one instance
		// while the app's scrape route rendered the other, with every adapter
		// family stuck at zero and nothing to say why. This adapter owns the
		// registry instead, and the app reaches THAT one through the platform.
		warnings.push(
			'adapter option `websocket.metrics` names a module, and this adapter does not load it: it owns ' +
			'the metrics registry itself, because a module imported by both a route and the WebSocket ' +
			'handler is two separate instances in the built output - the adapter would write to one and ' +
			'your scrape route would render the other. Reach the registry through `platform.metrics` ' +
			'(register your own instruments on it) and serve `await platform.metricsSnapshot()` from a ' +
			'route. Remove the option to silence this.'
		);
	}
	if (raw.authPath !== undefined) {
		if (typeof raw.authPath !== 'string' || raw.authPath[0] !== '/') {
			throw new Error(
				"adapter option `websocket.authPath` must be an absolute path string starting with '/' " +
				`(e.g. '/__ws/auth') - got ${describeValue(raw.authPath)}.`
			);
		}
		options.authPath = raw.authPath;
	}
	// Checked against the RESOLVED pair, so it fires whether the collision was
	// written out or arrived by moving only one of the two onto the other's
	// default. The upgrade lane is matched first, so an auth path equal to it
	// would never be reached and an app would see its preflight answered with a
	// 426 - a failure with nothing in it that names this option.
	if (options.authPath === options.path) {
		throw new Error(
			`adapter option \`websocket.authPath\` ('${options.authPath}') must differ from ` +
			`\`websocket.path\` ('${options.path}'). The WebSocket endpoint is matched first, so the ` +
			'auth preflight would never be reached.'
		);
	}
	if (raw.authPathRequireOrigin !== undefined) {
		options.authPathRequireOrigin = requireBoolean(raw.authPathRequireOrigin, 'authPathRequireOrigin');
	}
	if (raw.maxSubscriptionsPerConnection !== undefined) {
		options.maxSubscriptionsPerConnection = requirePositiveInt(
			raw.maxSubscriptionsPerConnection,
			'maxSubscriptionsPerConnection'
		);
	}
	if (raw.maxConcurrentSubscribeGates !== undefined) {
		options.maxConcurrentSubscribeGates = requirePositiveInt(
			raw.maxConcurrentSubscribeGates,
			'maxConcurrentSubscribeGates'
		);
	}
	if (raw.maxConcurrentUnsubscribeHooks !== undefined) {
		options.maxConcurrentUnsubscribeHooks = requirePositiveInt(
			raw.maxConcurrentUnsubscribeHooks,
			'maxConcurrentUnsubscribeHooks'
		);
	}
	if (raw.maxQueuedUnsubscribeHooks !== undefined) {
		options.maxQueuedUnsubscribeHooks = requirePositiveInt(
			raw.maxQueuedUnsubscribeHooks,
			'maxQueuedUnsubscribeHooks'
		);
	}
	if (raw.maxControlEgressBytes !== undefined) {
		options.maxControlEgressBytes = requirePositiveInt(
			raw.maxControlEgressBytes,
			'maxControlEgressBytes'
		);
	}
	if (raw.compression !== undefined) {
		const c = raw.compression;
		if (typeof c === 'number') {
			// uWS exposes numeric compressor constants (SHARED_COMPRESSOR and the
			// dedicated/windowed variants). Bun's perMessageDeflate has no numeric
			// equivalent, so the tuning cannot be carried across - only the
			// on/off decision survives. Warn rather than throw: the deployment
			// still gets compression, just not the requested tuning.
			options.compression = c !== 0;
			warnings.push(
				`websocket.compression was set to the numeric uWS compressor constant ${c}. ` +
				'Bun exposes permessage-deflate as a boolean or { compress, decompress } object with no ' +
				`numeric tuning, so this was translated to ${options.compression} and the specific ` +
				'compressor selection was dropped.'
			);
		} else if (typeof c === 'boolean') {
			options.compression = c;
		} else if (c && typeof c === 'object' && !Array.isArray(c)) {
			// Bun accepts { compress, decompress } verbatim (probed: accepted).
			options.compression = /** @type {any} */ (c);
		} else {
			throw new Error(
				'adapter option `websocket.compression` must be a boolean, a { compress, decompress } object, ' +
				`or a numeric uWS compressor constant, got ${describeValue(c)}.`
			);
		}
	}
	if (raw.allowedOrigins !== undefined) {
		const a = raw.allowedOrigins;
		// '*' is what the rest of the adapter family spells this, and the whole
		// point of keeping the uWS-shaped names is that one svelte.config.js
		// moves across. Rejecting the family's own documented value at BUILD
		// time - failing an app's build on a config that is correct everywhere
		// else - is the worst version of a gratuitous rename.
		const ok = a === 'same-origin' || a === 'any' || a === '*' ||
			(Array.isArray(a) && a.every((o) => typeof o === 'string' && o.length > 0));
		if (!ok) {
			throw new Error(
				"adapter option `websocket.allowedOrigins` must be 'same-origin', 'any' (or its family " +
				`spelling '*'), or an array of origin strings, got ${describeValue(a)}.`
			);
		}
		// `['*']` is a silent deny-all: inside the array the token is compared
		// literally, so it matches only a client that sends `Origin: *`, which
		// nothing does. Fail-closed, so not a hole - but an operator who writes
		// the array form of the family's wildcard gets a server that refuses
		// every browser and no clue why.
		if (Array.isArray(a) && a.includes('*')) {
			warnings.push(
				"`websocket.allowedOrigins` contains '*' inside an array, where it is compared " +
				"literally and matches nothing. Use the bare string `allowedOrigins: '*'` (or " +
				"'any') to allow every origin, or list the actual origins."
			);
		}
		options.allowedOrigins = a;
	}

	const unknownKeys = Object.keys(raw).filter((k) => !KNOWN_WS_OPTION_KEYS.has(k));

	return { options, warnings, unknownKeys };
}

/**
 * Translate normalized adapter options into the `websocket` option object
 * `Bun.serve` accepts. Renames only - every value has already been validated by
 * normalizeWsOptions at build time.
 *
 * An explicit allowlist, so an adapter-level option can never leak into Bun's
 * socket config. Deliberately absent: `allowedOrigins` (an upgrade decision, see
 * utils/ws-origin.js), `allowNonAsciiTopics` / `allowSystemTopicSubscribe` /
 * `allowUnauthenticatedSubscribe` (wire and gate policy),
 * `maxSubscriptionsPerConnection`, `maxConcurrentSubscribeGates`,
 * `maxConcurrentUnsubscribeHooks`, `maxQueuedUnsubscribeHooks` and
 * `maxControlEgressBytes` (per-connection bounds this adapter enforces itself).
 *
 * @param {Record<string, any>} options - output of normalizeWsOptions().options
 * @returns {Record<string, any>}
 */
export function toBunWebsocketOptions(options) {
	return {
		maxPayloadLength: options.maxPayloadLength,
		idleTimeout: options.idleTimeout,
		// Rename only: uWS calls this maxBackpressure.
		backpressureLimit: options.maxBackpressure,
		closeOnBackpressureLimit: options.closeOnBackpressureLimit,
		// Rename only: uWS calls this sendPingsAutomatically.
		sendPings: options.sendPingsAutomatically,
		perMessageDeflate: options.compression,
		publishToSelf: options.publishToSelf
	};
}
