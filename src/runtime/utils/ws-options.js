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
	allowUnauthenticatedSubscribe: false
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
