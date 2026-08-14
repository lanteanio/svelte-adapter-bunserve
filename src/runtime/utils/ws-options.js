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
	// Admission control for the upgrade path: concurrent-handshake ceiling,
	// whole-lifetime connection ceiling, per-tick pacing with a finite queue,
	// and the deprioritised cursor lane. undefined means every layer is off,
	// which is the uws default and the backward-compatible one. See
	// utils/upgrade-admission.js; the block is spelled exactly as uws spells it
	// so a config carried between the adapters gates the same way in both.
	upgradeAdmission: undefined,
	// Build-time rather than transport tuning, and nested HERE rather than at the
	// top level because that is where svelte-adapter-uws declares them. The two
	// adapters are drop-in replacements for each other, so a `websocket` block
	// has to mean the same thing in both: spelling these `websocketHandler` and
	// `websocketPath` at the top level made a carried-over config silently not
	// apply, since the other adapter reads the key it does not find and warns
	// about the one it does.
	handler: 'src/ws-handler.js',
	path: '/ws',
	// Also uws-nested: whether a Vary-on-credentials response may be compressed.
	compressCredentialedResponses: false
};

/** Every `websocket.*` key this adapter consumes. */
export const KNOWN_WS_OPTION_KEYS = new Set(Object.keys(DEFAULTS));

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {number}
 */
function requirePositiveInt(value, key) {
	if (!Number.isInteger(value) || /** @type {number} */ (value) <= 0) {
		throw new Error(
			`adapter option \`websocket.${key}\` must be a positive integer, got ${JSON.stringify(value)}.`
		);
	}
	return /** @type {number} */ (value);
}

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
	// Passed through unexamined, deliberately. createUpgradeAdmission applies
	// uws's own rules - maxConnections and maxDeferred must be non-negative safe
	// integers, and nothing else is range-checked - so validating harder here
	// would refuse configs uws runs.
	for (const key of ['maxConcurrent', 'maxConnections', 'perTickBudget', 'maxDeferred']) {
		if (raw[key] !== undefined) out[key] = raw[key];
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
		// the feature off. The fraction itself is clamped by the controller, as
		// uws clamps it, rather than refused.
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
			`adapter option \`websocket.${key}\` must be a boolean, got ${JSON.stringify(value)}.`
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
			'{ publishRatePerSec: 5000, sampleIntervalMs: 1000 }, got ' + JSON.stringify(value) + '.'
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
				`(false disables the signal), got ${JSON.stringify(v)}.`
			);
		}
		if (v <= 0) {
			// Accepted for portability, but a zero or negative threshold is
			// matched with `sample >= threshold`, so the signal fires on every
			// single sample - permanent pressure, which reads as a broken
			// server rather than as the "off" the author probably meant.
			warnings.push(
				`adapter option \`websocket.pressure.${key}\` is ${JSON.stringify(v)}, so that signal ` +
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
				`got ${JSON.stringify(v)}.`
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

	if (raw.maxPayloadLength !== undefined) {
		options.maxPayloadLength = requirePositiveInt(raw.maxPayloadLength, 'maxPayloadLength');
	}
	if (raw.maxBackpressure !== undefined) {
		options.maxBackpressure = requirePositiveInt(raw.maxBackpressure, 'maxBackpressure');
	}
	if (raw.idleTimeout !== undefined) {
		const idle = raw.idleTimeout;
		// 0 is legal here (disables the timeout) so this is not requirePositiveInt.
		if (!Number.isInteger(idle) || /** @type {number} */ (idle) < 0) {
			throw new Error(
				'adapter option `websocket.idleTimeout` must be a non-negative integer number of seconds, ' +
				`got ${JSON.stringify(idle)}.`
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
				`WebSocket hooks (e.g. 'src/ws-handler.js') - got ${JSON.stringify(raw.handler)}.`
			);
		}
		options.handler = raw.handler;
	}
	if (raw.path !== undefined) {
		if (typeof raw.path !== 'string' || raw.path[0] !== '/') {
			throw new Error(
				"adapter option `websocket.path` must be an absolute path string starting with '/' " +
				`(e.g. '/ws') - got ${JSON.stringify(raw.path)}.`
			);
		}
		options.path = raw.path;
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
				`or a numeric uWS compressor constant, got ${JSON.stringify(c)}.`
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
				`spelling '*'), or an array of origin strings, got ${JSON.stringify(a)}.`
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
