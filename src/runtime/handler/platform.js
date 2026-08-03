/**
 * The `platform` object handed to every WebSocket hook and to server-side app
 * code. This is the JSON realtime surface: topic fan-out, per-connection send,
 * brokered subscribe/unsubscribe, and the observability getters.
 *
 * What is deliberately NOT here yet: the pressure/protection surface
 * (onPressure/onPublishRate and flow-control) and the deferred JSON-tier
 * members sendCoalesced, topicEpoch, batch, publishBatched, request, and
 * requestTopic. Those are their own slices. They are omitted
 * rather than stubbed - a zero stub reports
 * "supported" to a caller and then silently does nothing, which is worse than
 * an undefined member a caller CAN feature-detect.
 *
 * "Can" is doing real work in that sentence, and it is not the same as "does".
 * svelte-adapter-uws-extensions guards some of these (requestTopic,
 * authorizeWireSubscribe, the wire members) and binds four of them
 * unconditionally: sendCoalesced and request (src/redis/pubsub.js:285-286),
 * onPressure and onPublishRate (:362-363). So `bus.wrap(platform)` - the first
 * line of that package's documented usage - throws a TypeError against this
 * platform today. Omission is still the right choice; the consumer's missing
 * guards are the bug, and they are tracked on that repo. But nothing here
 * should claim multi-node fan-out works until they land.
 *
 * Every method that touches a socket goes through the facade
 * (handler/ws-facade.js), so a closed socket throws here rather than silently
 * succeeding. The catch sites below turn that throw into the closedWsAborts
 * lane, which is NOT the backpressure-drop lane - see utils/send-result.js for
 * why conflating them corrupts wire state.
 */

import { completeEnvelope } from '../utils/envelope.js';
import { isSystemTopic, isValidWireTopic, createTopicHelperCache } from '../utils/topic.js';
import { SEND_DROPPED } from '../utils/send-result.js';
import { isValidResumeEpoch, isValidResumeSeq } from '../utils/resume-input.js';
import { createLogThrottle } from '../utils/log-throttle.js';
import {
	denyAllBatch,
	isReadableVerdict,
	mapBatchDenials,
	warnUnreadableVerdict
} from '../utils/subscribe-batch.js';
import { envelopePrefix } from './envelope-cache.js';
import { bumpOut } from './ws-stats.js';
import { wsModule } from '../ws-handler-bridge.js';
import { buildBinaryFrame } from '../utils/wire.js';
import { getSharedWireId } from '../utils/shared-wire-id.js';
import { registerWireCodec as _registerWireCodec } from './codec-registry.js';
import { cohortTopics, joinSharedCohort, leaveSharedCohort } from './cohort.js';
import {
	ensureWireId,
	ensureWireState,
	poisonWireState,
	wireStatePoisoned
} from './wire-state.js';
import {
	beginResumeCapture,
	markResumeTruncated,
	coveredSeqFor,
	discardResumeCapture,
	flushResumeTopic
} from './resume-buffer.js';
import {
	MAX_SUBSCRIPTIONS_PER_CONNECTION,
	WS_CAPS,
	WS_PLATFORM,
	WS_SESSION_ID,
	WS_SUBSCRIPTIONS,
	beginPendingSubscribe,
	capCounts,
	captureResumeFrame,
	notePublishedSeq,
	resumeBuffers,
	sharedTopics,
	getServer,
	hasGateHeadroom,
	pendingSubscribeTopics,
	settlePendingSubscribe,
	withGateCounted,
	stampExplicitSeq,
	stampSeq,
	stampSeqValue,
	tombstonePendingSubscribe,
	wsConnections,
	wsCounters
} from './ws-state.js';
import { allow_unauthenticated_subscribe, ws_compression_on, ws_options } from './config.js';

/** Throws from the app's subscribe hook, throttled with decay. */
const subscribeThrewThrottle = createLogThrottle(() => performance.now());

/** Throws from the app's resume hook on the recover lane, throttled with decay. */
const recoverThrewThrottle = createLogThrottle(() => performance.now());

/**
 * A codec that threw, or handed back something that is not bytes. Throttled
 * with decay for the same reason the hook throttles are: safeEncode runs inside
 * the PER-CONNECTION walk, so one broken codec on a busy topic is one stderr
 * write per connection per publish - an event-loop stall and a filled disk from
 * a bug that is already degrading that capability to JSON.
 */
const encodeFailedThrottle = createLogThrottle(() => performance.now());

/**
 * The seq-less JSON envelope a wire member falls back to for a caps-less,
 * poisoned, or codec-declined frame: byte-identical to what `send()` produces
 * (`envelopePrefix + JSON.stringify(data ?? null) + '}'`), so a degraded
 * connection is indistinguishable from a caps-less one to the app.
 *
 * @param {any} ws - the socket facade
 * @param {string} topic
 * @param {string} event
 * @param {unknown} data
 * @param {boolean} compress
 * @returns {0 | 1 | 2}
 */
function wireJsonSend(ws, topic, event, data, compress) {
	const json = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
	let result;
	try {
		result = ws.send(json, false, compress);
	} catch {
		wsCounters.closedWsAborts++;
		return SEND_DROPPED;
	}
	if (result !== SEND_DROPPED) bumpOut(ws, json);
	return result;
}

/**
 * Note this publish's seq against the topic's authoritative high-water mark -
 * the resume barrier's fallback dedup floor, and its ceiling on a watermark a
 * resume hook reports - LRU-bounded in notePublishedSeq. Only an explicit
 * numeric seq is a value that mark can hold: it is cluster-authoritative and
 * may arrive reordered, so it takes the monotone guard there. A `{ seq: true }`
 * counter seq belongs to an unrelated space and only keeps the topic recent.
 *
 * @param {string} topic
 * @param {number | null} seq
 * @param {{ seq?: boolean | number } | undefined} options
 */
function recordPublishedSeq(topic, seq, options) {
	if (seq === null) return;
	notePublishedSeq(topic, seq, isAuthoritativeSeq(options));
}

/**
 * Whether a publish carries an explicit numeric (cluster-authoritative) seq,
 * as opposed to the local `{ seq: true }` counter. The resume dedup floor is
 * an authoritative-space quantity, so only authoritative frames are compared
 * against it.
 *
 * @param {{ seq?: boolean | number } | undefined} options
 * @returns {boolean}
 */
function isAuthoritativeSeq(options) {
	return !!(options && typeof options.seq === 'number');
}

/**
 * A batch published with one explicit cluster seq for all of its entries.
 *
 * FAIL FAST RATHER THAN CORRUPT THE WIRE, the same judgement stampExplicitSeq
 * makes about a seq the wire cannot carry - and for the same reason, so that
 * one class of seq misuse does not fail two different ways depending on
 * whether it was written on the call or on an entry. Both ways of absorbing it
 * lose data silently: stamping all N entries with the one number lets a client
 * that received only part of the batch report that shared seq as its
 * watermark, and the dedup floor then discards the WHOLE batch including the
 * entries it never received; publishing seq-less instead degrades that
 * client's resume dedup with nothing to notice it by. A bad seq is a bug in
 * the calling app, not a runtime condition to absorb.
 *
 * @param {string} topic
 * @param {number} seq
 * @returns {never}
 * @throws {TypeError} always
 */
function throwBatchExplicitSeq(topic, seq) {
	throw new TypeError(
		`publishWireBatch was given a batch-level { seq: ${String(seq)} } (topic "${topic}"): one ` +
		'number cannot be the one-seq-per-entry this method publishes. Put the cluster seq on ' +
		'each entry instead - { data, seq }, each an integer >= 1 - or use { seq: true } for the ' +
		'local counter, which already increments per entry.'
	);
}

/**
 * Whether the most recent safeEncode call returned null because the codec
 * FAILED (threw, or returned a wrong-type value) rather than declined. A
 * decline is a codec's deliberate answer and leaves its per-connection state
 * coherent by contract; a failure escaped partway, so a stateful codec's
 * dictionaries may have advanced for a frame the client will never see - the
 * decode desync poisoning exists for. Callers that passed a non-null state
 * read this immediately after the call and poison on it. A module flag rather
 * than a sentinel return or a callback: every existing `payload == null`
 * check stays exhaustive, and the fan-out walk allocates nothing for it. The
 * write that matters happens after wire.encode returns or throws, so a codec
 * that publishes re-entrantly (resetting the flag inside) cannot leave a
 * stale value behind.
 */
let encodeFailed = false;

/**
 * Encode one wire frame, treating a throwing codec as a decline rather than
 * letting it abort a fan-out walk partway - some subscribers already have the
 * frame, and the seq is stamped and resume-captured, so a mid-walk escape
 * leaves the topic inconsistent. A failure is logged - throttled with decay,
 * because this runs inside the per-connection walk - and the connection takes
 * the JSON envelope like any other decline; `encodeFailed` records that it
 * was a failure, so stateful callers can poison the capability rather than
 * keep referencing state the client never learned.
 *
 * @param {{ encode: Function }} wire
 * @param {string} event
 * @param {unknown} data
 * @param {unknown} [state]
 * @returns {Uint8Array | null}
 */
function safeEncode(wire, event, data, state) {
	encodeFailed = false;
	let payload;
	try {
		payload = wire.encode(event, data, state);
	} catch (err) {
		encodeFailed = true;
		const { log, count } = encodeFailedThrottle();
		if (log) console.error(`[ws] wire.encode threw for ${wire.capability} ${event} (x${count})`, err);
		return null;
	}
	// A wrong-TYPE return is the same class of codec bug as a throw and takes
	// the same answer. Unchecked it reaches buildBinaryFrame, which sizes the
	// frame writer as `8 + payload.length`: for anything without a numeric
	// length that is NaN, the writer gets a zero-capacity buffer, and the
	// growth loop cannot grow it - the codec's bug becomes a hung event loop
	// instead of one degraded connection. An accidentally-async `encode` is the
	// likely route, since a Promise is truthy and has no length. Buffer passes,
	// being a Uint8Array subclass.
	if (payload != null && !(payload instanceof Uint8Array)) {
		encodeFailed = true;
		const { log, count } = encodeFailedThrottle();
		if (log) {
			console.error(
				`[ws] wire.encode returned a ${typeof payload} for ${wire.capability} ${event} (x${count})` +
				' - serving the JSON envelope instead. Return a Uint8Array, or null to decline.'
			);
		}
		return null;
	}
	return payload;
}

/**
 * Deliver one prebuilt envelope to one connection inside a fan-out walk:
 * closed sockets land in the closed lane and only delivered bytes are
 * charged. The walk continues either way.
 *
 * @param {any} ws - the socket facade
 * @param {string} envelope
 * @param {boolean} compress
 * @returns {boolean} whether the frame reached the wire
 */
function wireEnvelopeSend(ws, envelope, compress) {
	try {
		if (ws.send(envelope, false, compress) !== SEND_DROPPED) {
			bumpOut(ws, envelope);
			return true;
		}
	} catch {
		wsCounters.closedWsAborts++;
	}
	return false;
}

/**
 * One reading of whatever a subscribe gate returned, shared by the per-topic
 * `subscribe` hook and the per-batch `subscribeBatch` hook so the two cannot
 * drift.
 *
 * Fail-OPEN on a nullish verdict is deliberate: "no opinion" is the
 * overwhelmingly common return from a hook that guards a few topics and ignores
 * the rest. A hook that means to deny returns `false` or a reason string;
 * `true`, `null` and `undefined` allow.
 *
 * Anything else is UNREADABLE and fails closed. Allowing it would fail open
 * for exactly the hooks most likely to exist: one written
 * `return allowed[topic] ? null : 403`, or one that returns a lookup promise
 * without `await`, denies nothing and hands the client every topic it can
 * name. Both gate lanes read a verdict through `isReadableVerdict`, so the
 * identical hook logic cannot be denied through `subscribeBatch` while being
 * allowed through `subscribe`.
 *
 * @param {unknown} verdict
 * @param {string} topic - named in the warning, not in the client's answer
 * @param {string} hookName - the gate that produced the verdict
 * @returns {string | null} a denial reason, or null to allow
 */
function normalizeSubscribeVerdict(verdict, topic, hookName) {
	if (verdict === false) return 'FORBIDDEN';
	if (typeof verdict === 'string') return verdict;
	if (!isReadableVerdict(verdict)) {
		warnUnreadableVerdict(topic, verdict, hookName);
		return 'INTERNAL_ERROR';
	}
	return null;
}

/** Throws from the app's subscribeBatch hook, throttled with decay. */
const batchThrewThrottle = createLogThrottle(() => performance.now());

/**
 * Run the app's `subscribeBatch` gate over a set of topics, in ONE call, and
 * return a verdict for every topic asked about.
 *
 * Lives here rather than in the demux so that BOTH entry points share it: the
 * wire batch path calls it once per frame, and checkSubscribe calls it for a
 * single topic. Keeping two copies is how `platform.subscribe` ended up with no
 * gate at all while the wire path had one.
 *
 * @param {any} ws
 * @param {string[]} topics
 * @returns {Promise<Map<string, unknown>>}
 */
export async function runBatchGate(ws, topics) {
	const hook = wsModule.subscribeBatch;
	if (typeof hook !== 'function' || topics.length === 0) return new Map();
	let hookPlatform = platform;
	try {
		hookPlatform = ws.getUserData()[WS_PLATFORM] || platform;
	} catch {
		/* closed socket: the shared platform is the honest answer */
	}
	try {
		return mapBatchDenials(topics, await hook(ws, topics, { platform: hookPlatform }));
	} catch (err) {
		// A throwing gate reached no decision, so every topic fails closed - the
		// same contract the per-topic hook gets.
		const { log: logIt, count: threwCount } = batchThrewThrottle();
		if (logIt) {
			const suffix = threwCount > 1 ? ` (occurrence ${threwCount})` : '';
			console.error(`[ws] subscribeBatch hook threw; denying the batch${suffix}:`, err);
		}
		return denyAllBatch(topics, 'INTERNAL_ERROR');
	}
}

let warnedNoSubscribeHook = false;
/** One-shot, because it fires per denied subscribe and would otherwise flood. */
function warnNoSubscribeHook() {
	if (warnedNoSubscribeHook) return;
	warnedNoSubscribeHook = true;
	console.error(
		'[ws] A client tried to subscribe, but this app exports no subscribe gate, so every\n' +
		'  subscription is being DENIED with SUBSCRIBE_NOT_CONFIGURED. Without a gate the server\n' +
		'  cannot tell an app-private topic from a public one, and allowing by default would let\n' +
		'  any client that can name a topic read it. Pick one:\n' +
		'    1. Export `subscribe(ws, topic, { platform })` from your ws handler and return a\n' +
		'       reason string to deny, or null to allow.\n' +
		'    2. Export `subscribeBatch(ws, topics, { platform })` to gate a whole batch in one\n' +
		'       call, returning a map of topic -> denial reason.\n' +
		'    3. Set `websocket: { allowUnauthenticatedSubscribe: true }` in the adapter options\n' +
		'       to state that every topic in this app is public.'
	);
}

/**
 * Lazily built LRU of scoped topic helpers, bound to this platform's publish.
 * Built on first use because it closes over `platform.publish`, which does not
 * exist until the object literal below is complete.
 * @type {((name: string) => any) | null}
 */
let topicHelperCache = null;

/** @type {any} */
/**
 * The one place the subscribe gate runs.
 *
 * Both `platform.subscribe` and `platform.checkSubscribe` come through here,
 * which is what stopped them disagreeing about whether a gate had run at all.
 *
 * `verdict` MUST stay a parameter of a module-private function, because
 * supplying one skips the gate. It cannot ride on `options`: that is a public
 * parameter consumers forward verbatim, and a Symbol key on it is no better,
 * since a Proxy with a catch-all `get` trap answers for a Symbol it cannot
 * name. It cannot be a fourth parameter of `platform.subscribe` either -
 * a verdict short-circuits the gate entirely, so
 * `topics.map(platform.subscribe.bind(platform, ws))`, which supplies
 * `(topic, index, array)`, would pass the index as a verdict and answer every
 * topic without ever consulting the app.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {unknown} [verdict] - already obtained from subscribeBatch for this topic
 * @returns {Promise<string | null>}
 */
async function runSubscribeGate(ws, topic, verdict) {
	// Validated HERE and not only in platform.subscribe, because
	// platform.checkSubscribe is a public entry point too and the documented
	// pattern is `if (await platform.checkSubscribe(...)) return; ws.subscribe(t)`
	// - which handed a NUL-bearing or 4000-character topic to the app's gate and
	// then straight to the socket. The donor validates in the same place.
	if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
	// `__proto__` fails closed on EVERY lane, not just the batch mapping.
	// utils/subscribe-batch.js refuses it because it cannot be an own key of the
	// denials object, so a hook denying it produces an object where the denial is
	// simply absent. The per-topic hook has the mirror-image problem: an app
	// whose gate is an allowlist lookup (`if (!ALLOWLIST[topic]) return
	// 'FORBIDDEN'`) reads `Object.prototype` for it, which is truthy, and allows.
	// The guard therefore lives at the single gate entry point both lanes come
	// through, so they cannot disagree about one topic name. Only reachable with
	// `allowSystemTopicSubscribe: true` - the `__` guard refuses it otherwise.
	if (topic === '__proto__') return 'INTERNAL_ERROR';
	// A verdict the wire batch path already obtained from `subscribeBatch` for
	// THIS topic, so one `subscribe-batch` frame costs one hook call rather
	// than one per entry.
	if (verdict !== undefined) return normalizeSubscribeVerdict(verdict, topic, 'subscribeBatch');
	// `requireGrant` is the OBSERVER-LANE mode: "may this connection see what
	// it already holds?" It falls through to the ordinary app gate below.
	//
	// It does NOT deny on its own. The grant test it asks for only bites in
	// the donor when wire-subscribe authorization has been ARMED and the app
	// exports no subscribe hook (deniesUngrantedObserve, uws
	// src/runtime/utils/ws-symbols.js:187-204: `if (!armed || hasUserHook)
	// return false`). This port has no authorizeWireSubscribe at all, so
	// armed can never be true and the donor would fall through in every
	// reachable configuration. Denying here unconditionally would be stricter
	// than the family in every configuration rather than only in the
	// unimplemented one, and would break the extensions' observer lanes, which
	// pass `{ requireGrant: true }` on every cursor/presence snapshot
	// (shared/ws-subscriptions.js OBSERVER_LANE): a reconnecting tab would never
	// re-sync its cursors, with no error on either side. When
	// authorizeWireSubscribe lands, the grant test belongs here.
	// `subscribeBatch` takes precedence over `subscribe` when both exist,
	// matching the family, and it is consulted HERE rather than only on the
	// wire batch path. Skipping it for single subscribes left
	// `platform.subscribe` - the spelling the docs call the safe one -
	// running no gate at all for an app that gates with the batch hook.
	if (typeof wsModule.subscribeBatch === 'function') {
		const verdicts = await runBatchGate(ws, [topic]);
		return normalizeSubscribeVerdict(verdicts.get(topic), topic, 'subscribeBatch');
	}
	const hook = wsModule.subscribe;
	if (typeof hook !== 'function') {
		// No gate exported at all. Refusing is the safe reading of an
		// ambiguous configuration: the adapter cannot tell whether these
		// topics are public, and silently allowing means a client that can
		// name `user:<id>` receives it. warnNoSubscribeHook() prints the
		// ways to resolve it, once.
		if (!allow_unauthenticated_subscribe) {
			warnNoSubscribeHook();
			return 'SUBSCRIBE_NOT_CONFIGURED';
		}
		return null;
	}
	try {
		// Argument shape matches the rest of the family: (ws, topic, ctx).
		// Folding the topic into the context object would silently break
		// every hook carried over from another adapter in the family - it
		// would either throw on `topic.startsWith` (denying everything) or
		// compare an object against a string (allowing everything).
		// The PER-CONNECTION platform, like every other hook gets. The shared
		// singleton carries no requestId, so a hook that logs the
		// correlation id used to emit it in open/message/drain/close/
		// unsubscribe and nothing in subscribe alone. Falls back to the
		// singleton for a caller that reaches checkSubscribe with a socket
		// that has no slot yet.
		let hookPlatform = platform;
		try {
			hookPlatform = ws.getUserData()[WS_PLATFORM] || platform;
		} catch {
			/* closed socket: the shared platform is the honest answer */
		}
		return normalizeSubscribeVerdict(
			await hook(ws, topic, { platform: hookPlatform }),
			topic,
			'subscribe'
		);
	} catch (err) {
		// A THROWING hook is different from one returning no opinion: the
		// gate reached no decision, so this fails closed. The reason is
		// distinct from FORBIDDEN because it reaches the client, and an app
		// retries a transient internal error where it would never retry a
		// deliberate refusal.
		// Throttled for the same reason as the other hook errors: this fires
		// once per denied subscribe, and a client controls how many of those
		// it sends. See utils/log-throttle.js.
		const { log: logIt, count: threwCount } = subscribeThrewThrottle();
		if (logIt) {
			const suffix = threwCount > 1 ? ` (occurrence ${threwCount})` : '';
			console.error(`[ws] subscribe hook threw; denying the subscription${suffix}:`, err);
		}
		return 'INTERNAL_ERROR';
	}
}

export const platform = {
	/**
	 * Publish to every client subscribed to `topic`, wrapped in the
	 * `{ topic, event, data }` envelope the client store understands. A no-op
	 * when nobody is subscribed, so it is safe to call unconditionally.
	 *
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {{ seq?: boolean | number, jitterMs?: number, compress?: boolean }} [options]
	 * @returns {boolean} whether any local subscriber received it
	 */
	publish(topic, event, data, options) {
		// The call's options are read first, one read per documented field
		// into locals, before any app code can run. completeEnvelope's
		// JSON.stringify calls any payload toJSON, and that code holds a live
		// reference to the caller's options - an options.seq that answers the
		// stamp with one value and the authority reads below with another
		// would record a counter value in the authoritative mark, the
		// cross-space clobber the resume floor exists to prevent. Locals
		// rather than a copied object so the hot path allocates nothing, and
		// named reads so a seq carried on a prototype is seen here exactly as
		// every other lane sees it.
		const seqOpt = options ? options.seq : undefined;
		const jitterOpt = options ? options.jitterMs : undefined;
		const compressOpt = options ? options.compress : undefined;
		const seq = stampSeqValue(seqOpt, topic);
		// Authority is decided from the same single read the stamp consumed.
		const authoritative = typeof seqOpt === 'number';
		// A de-herd window is carried verbatim so each client rolls its own
		// delay. Rolling one server-side offset instead would defer every
		// subscriber of this frame by the SAME amount, which is the stampede
		// the option exists to prevent.
		const jitterMs = typeof jitterOpt === 'number' && jitterOpt > 0 ? jitterOpt : null;
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq, jitterMs);
		// Everything that can still refuse this publish is resolved above this
		// line: stampSeq on a seq the wire cannot carry, completeEnvelope on a
		// payload JSON cannot represent, and getServer when the platform is used
		// before Bun.serve() started. Only then is anything recorded.
		//
		// The MARK is the load-bearing half. It is the resume dedup floor, so
		// raising it for a frame that never went out makes the next gap-fill
		// window discard the republished frame as already-seen - a silent gap.
		// The count is the visible half: `publishCount` is documented as
		// "publishes since boot" and drifts upward on the app's own bug in the
		// one case where nothing was delivered to notice it by.
		const server = getServer();
		if (seq !== null) notePublishedSeq(topic, seq, authoritative);
		wsCounters.publishCount++;
		const compress = ws_compression_on && compressOpt !== false;
		// A connection still gap-filling this topic (resume cutover in
		// flight) is not yet subscribed to live, so hold the envelope it
		// would have received; it flushes once its membership installs. One
		// guarded size check on the path every publish takes.
		if (resumeBuffers.size > 0) {
			captureResumeFrame(topic, seq, envelope, compress, null, authoritative);
		}
		const result = server.publish(topic, envelope, compress);
		// Bun returns the byte count on delivery and 0 when the topic has no
		// subscribers (probed).
		return typeof result === 'number' && result > 0;
	},

	/**
	 * Send to one connection, in the same envelope shape as publish().
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {{ compress?: boolean }} [options]
	 * @returns {0 | 1 | 2} 0 enqueued behind backpressure, 1 sent, 2 dropped
	 */
	send(ws, topic, event, data, options) {
		const payload = completeEnvelope(envelopePrefix(topic, event), data);
		const compress = ws_compression_on && (!options || options.compress !== false);
		// Callers routinely reach here after an await that outlasted the
		// socket. The facade throws; report DROPPED so callers can pattern-match
		// a single failure value without having to distinguish closed from
		// backpressure-dropped, and count it in the closed lane so the two
		// remain separable in telemetry.
		try {
			const result = ws.send(payload, false, compress);
			// Only bytes that actually reached the wire. A SEND_DROPPED frame was
			// refused past the backpressure limit and never went out, so charging
			// it overstates egress for exactly the connections that are already
			// in trouble - and the doc on these counters says apps meter and bill
			// per byte off them.
			if (result !== SEND_DROPPED) bumpOut(ws, payload);
			return result;
		} catch {
			wsCounters.closedWsAborts++;
			return SEND_DROPPED;
		}
	},

	/**
	 * Send to every connection whose userData the filter accepts. Returns the
	 * number of connections written to.
	 *
	 * The filter MUST be synchronous: this walks every live connection, and an
	 * async filter would either serialize the walk behind N awaits or (worse)
	 * be treated as truthy for everyone. A returned Promise is refused
	 * fail-closed, with a one-shot explanation.
	 *
	 * @param {(userData: any) => boolean} filter
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {{ compress?: boolean }} [options]
	 * @returns {number}
	 */
	sendTo(filter, topic, event, data, options) {
		const envelope = completeEnvelope(envelopePrefix(topic, event), data);
		// Opt-IN compression: sendTo frames target a filtered set and are
		// usually one-offs, so deflating each one by default would cost CPU per
		// recipient for no shared benefit.
		const compress = ws_compression_on && !!(options && options.compress === true);
		let count = 0;
		for (const ws of wsConnections) {
			let userData;
			try {
				userData = ws.getUserData();
			} catch {
				wsCounters.closedWsAborts++;
				continue;
			}
			const decision = filter(userData);
			if (decision && typeof decision.then === 'function') {
				if (!wsCounters.sendToAsyncWarned) {
					wsCounters.sendToAsyncWarned = true;
					console.error(
						'[ws] platform.sendTo filter returned a Promise; treating as fail-closed.\n' +
						'  Async filters cannot be used here because sendTo iterates every active\n' +
						'  connection synchronously. Resolve the fields you need into userData from\n' +
						'  your `upgrade` hook so the filter can read them synchronously.'
					);
				}
				continue;
			}
			if (!decision) continue;
			let result;
			try {
				result = ws.send(envelope, false, compress);
			} catch {
				wsCounters.closedWsAborts++;
				continue;
			}
			// Dropped past the backpressure limit: not written, so neither
			// charged nor counted as a connection this reached.
			if (result === SEND_DROPPED) continue;
			bumpOut(ws, envelope);
			count++;
		}
		return count;
	},

	/**
	 * Register a plugin's binary wire codec by its capability token.
	 * Idempotent and last-wins, so a hot-reloading plugin does not accumulate
	 * entries.
	 *
	 * @param {{ capability: string }} wire
	 */
	registerWireCodec(wire) {
		_registerWireCodec(wire);
	},

	/**
	 * Publish to every subscriber of `topic` through a plugin-declared binary
	 * wire codec: capable connections receive the codec's `0x03` frame,
	 * everyone else the exact JSON envelope `publish()` would have sent, with
	 * the SAME seq on both forms - the resume contract requires the binary
	 * frame and the JSON envelope to carry identical sequence numbers.
	 *
	 * A JSON-only deployment pays nothing for this: when no live connection
	 * advertised the codec's capability and nothing is excluded, this is one
	 * native fan-out, byte- and instruction-identical to `publish()`.
	 *
	 * @param {string} topic
	 * @param {string} event
	 * @param {any} data
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any, shared?: boolean }} wire
	 * @param {{ seq?: boolean | number, compress?: boolean, excludeWs?: any }} [options]
	 * @returns {boolean} whether any local subscriber received it. Exact on the
	 *   per-connection walk, which sees each send result; approximate on the
	 *   native fan-out lanes, where Bun reports a byte count for a saturated
	 *   subscriber too - so there it answers "a subscriber existed" rather than
	 *   "bytes reached a socket". Which lane runs depends on whether any live
	 *   connection advertised the capability, so the same call can answer
	 *   differently as unrelated connections come and go.
	 */
	publishWire(topic, event, data, wire, options) {
		// A missing or shapeless codec is a caller error, not a crash: fall
		// back to a plain JSON publish (what every subscriber would get anyway
		// with no capability) rather than dereferencing wire.capability.
		if (!wire || typeof wire.capability !== 'string') {
			return this.publish(topic, event, data, options);
		}
		// One read per documented field into locals, before any app code runs
		// - same discipline as publish() above and the batch lane below, and
		// allocation-free for the same reason: the value the stamp consumes
		// is the value the authority, compression and exclusion decisions
		// below see, whatever a toJSON or accessor does to the caller's
		// object in between.
		const seqOpt = options ? options.seq : undefined;
		const compressOpt = options ? options.compress : undefined;
		const excludeOpt = options ? options.excludeWs : undefined;
		const seq = stampSeqValue(seqOpt, topic);
		// Authority is decided from the same single read the stamp consumed.
		const authoritative = typeof seqOpt === 'number';
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq);
		// Past all three refusal points before the mark or the count moves, as
		// in publish() above and for the same reasons.
		const server = getServer();
		if (seq !== null) notePublishedSeq(topic, seq, authoritative);
		wsCounters.publishCount++;
		// Binary codec frames (and this call's JSON-fallback frames) compress
		// only when the caller opts in with `{ compress: true }` AND a
		// compressor is configured. One decision governs the whole call so a
		// plugin's intent applies to its binary and JSON-fallback frames
		// alike; off by default keeps the high-frequency path uncompressed.
		const compress = ws_compression_on && compressOpt === true;

		// Sender exclusion: when set, this one local socket must never receive
		// the frame. The single native fan-out cannot skip a socket, so an
		// excluding publish always takes the per-subscriber walk (the walk
		// already hands caps-less connections the identical JSON envelope).
		const excludeWs = excludeOpt || null;

		// A resuming connection is not yet on the live membership, so it
		// would receive nothing from any branch below; hold the JSON envelope
		// it would have received as a caps-less subscriber - but never for the
		// socket this publish excluded.
		if (resumeBuffers.size > 0) {
			captureResumeFrame(topic, seq, envelope, compress, excludeWs, authoritative);
		}

		// JSON fast path: no live connection wants binary for this codec.
		if (excludeWs === null && !capCounts.has(wire.capability)) {
			const result = server.publish(topic, envelope, compress);
			return typeof result === 'number' && result > 0;
		}

		const seqOnWire = seq == null ? 0 : seq;

		// Stateful codec (per-connection dictionary / delta baselines): the
		// encoded payload depends on the recipient's state, so
		// encode-once-send-many no longer holds for the binary recipients -
		// each capable connection is encoded against its own state.
		// Connections whose onAttach returned null (an older client that
		// negotiated the stateless schema) share one encode at
		// `wire.schemaVersion`, memoized by topic-id, so a mixed room keeps
		// the single-encode fan-out for those clients.
		if (wire.state) {
			let sharedPayload;
			let sharedEncoded = false;
			/** @type {Map<number, Uint8Array>} */
			const sharedFrameById = new Map();
			let delivered = false;
			for (const ws of wsConnections) {
				if (ws === excludeWs) continue;
				let ud;
				try {
					ud = ws.getUserData();
				} catch {
					wsCounters.closedWsAborts++;
					continue;
				}
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				const caps = ud[WS_CAPS];
				if (!caps || !caps.has(wire.capability)) {
					delivered = wireEnvelopeSend(ws, envelope, compress) || delivered;
					continue;
				}
				const state = ensureWireState(ws, ud, wire);
				if (state == null) {
					// A poisoned capability is served exactly like a caps-less
					// connection: the shared JSON envelope, never binary.
					// Checked only on this null-state branch so the
					// per-connection hot path pays nothing for it.
					if (wireStatePoisoned(ud, wire.capability)) {
						delivered = wireEnvelopeSend(ws, envelope, compress) || delivered;
						continue;
					}
					// Shared encode-once at the codec's baseline schema version.
					if (!sharedEncoded) {
						sharedPayload = safeEncode(wire, event, data, null);
						sharedEncoded = true;
					}
					if (sharedPayload == null) {
						delivered = wireEnvelopeSend(ws, envelope, compress) || delivered;
						continue;
					}
					const id = ensureWireId(ws, ud, topic);
					if (id === -1) {
						// Dropped wire-id announce: the client can never resolve
						// this topic's numeric id, so binary for this capability
						// is permanently undecodable here. JSON for this frame,
						// and poison.
						poisonWireState(ws, ud, wire.capability);
						delivered = wireEnvelopeSend(ws, envelope, compress) || delivered;
						continue;
					}
					let frame = sharedFrameById.get(id);
					if (!frame) {
						frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, sharedPayload);
						sharedFrameById.set(id, frame);
					}
					// A dropped shared frame needs no poisoning: the payload was
					// encoded against no per-connection state, so the client's
					// decoder stays in sync and the next frame is independent.
					try {
						if (ws.send(frame, true, compress) !== SEND_DROPPED) { bumpOut(ws, frame); delivered = true; }
					} catch {
						wsCounters.closedWsAborts++;
					}
				} else {
					// Per-connection encode against this connection's state,
					// stamped with the schema version that state negotiated.
					const payload = safeEncode(wire, event, data, state);
					if (payload == null) {
						// A FAILED encode (throw or wrong-type return) may have
						// advanced this connection's dictionaries for a frame
						// the client will never see - the same desync a dropped
						// stateful frame leaves, and the same answer: JSON from
						// here on. A clean decline poisons nothing.
						if (encodeFailed) poisonWireState(ws, ud, wire.capability);
						delivered = wireEnvelopeSend(ws, envelope, compress) || delivered;
						continue;
					}
					const sv =
						typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
					const id = ensureWireId(ws, ud, topic);
					if (id === -1) {
						// Dropped wire-id announce (see the shared branch above).
						// The encode already advanced this connection's codec
						// state for a frame that will never be sent, which is
						// exactly the desync poisoning exists for.
						poisonWireState(ws, ud, wire.capability);
						delivered = wireEnvelopeSend(ws, envelope, compress) || delivered;
						continue;
					}
					const frame = buildBinaryFrame(sv, id, seqOnWire, payload);
					let result;
					try {
						result = ws.send(frame, true, compress);
					} catch {
						wsCounters.closedWsAborts++;
						continue;
					}
					if (result !== SEND_DROPPED) { bumpOut(ws, frame); delivered = true; }
					// The encode above already mutated this connection's
					// dictionary for the dropped frame, so the client decoder
					// can never catch up - degrade to JSON until reconnect.
					if (result === SEND_DROPPED) poisonWireState(ws, ud, wire.capability);
				}
			}
			return delivered;
		}

		// Stateless codec: encode once, send many. A null payload (the codec
		// declined this frame) falls through to the single native fan-out,
		// instruction-identical to publish(). The codec payload is shared
		// across recipients; only the tiny per-connection frame header
		// (topic-id + seq) differs, memoized per distinct id so the common
		// all-same-id case builds one frame and reuses it for every binary
		// send.
		const payload = safeEncode(wire, event, data);
		if (payload == null) {
			if (excludeWs === null) {
				const result = server.publish(topic, envelope, compress);
				return typeof result === 'number' && result > 0;
			}
			// Declined frame with sender exclusion: the same JSON envelope the
			// single fan-out would have sent, delivered per subscriber so the
			// excluded socket is skipped.
			let delivered = false;
			for (const ws of wsConnections) {
				if (ws === excludeWs) continue;
				let ud;
				try {
					ud = ws.getUserData();
				} catch {
					wsCounters.closedWsAborts++;
					continue;
				}
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				try {
					// Inside the guard: a frame refused past the backpressure
					// limit never went out, so it is not delivery.
					if (ws.send(envelope, false, compress) !== SEND_DROPPED) {
						bumpOut(ws, envelope);
						delivered = true;
					}
				} catch {
					wsCounters.closedWsAborts++;
				}
			}
			return delivered;
		}

		// Shared binary fan-out: a stateless codec marked `shared: true` fans
		// out via cohort topics - the byte-identical 0x03 frame to
		// `topic\0bin`, the JSON envelope to `topic\0json` - so this publish
		// is two native fan-outs, not a per-connection walk. Eligible only
		// with no sender exclusion (a single native publish cannot skip one
		// socket; an excluding shared publish falls through to the walk
		// below). The frame is identical for every binary subscriber because
		// the topic-id is the server-wide shared id, announced when a
		// connection joined the binary cohort.
		if (wire.shared && excludeWs === null) {
			// Lazy migration: the FIRST shared publish to a topic cohorts its
			// current subscribers (a one-time walk, paid once per topic), then
			// marks the topic shared so a later joiner is cohorted at
			// subscribe time instead.
			if (!sharedTopics.has(topic)) {
				for (const ws of wsConnections) {
					let ud;
					try {
						ud = ws.getUserData();
					} catch {
						wsCounters.closedWsAborts++;
						continue;
					}
					const subs = ud[WS_SUBSCRIPTIONS];
					if (!subs || !subs.has(topic)) continue;
					joinSharedCohort(ws, ud, topic, wire.capability);
				}
				sharedTopics.set(topic, wire.capability);
			}
			const { bin, json } = cohortTopics(topic);
			// The binary cohort exists only if a capable client joined it (its
			// announce succeeded); otherwise this shared topic currently has
			// only JSON subscribers and skips the binary fan-out entirely.
			const id = getSharedWireId(topic);
			let binBytes = 0;
			if (id !== undefined) {
				binBytes = server.publish(bin, buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload), compress);
			}
			const jsonBytes = server.publish(json, envelope, compress);
			// Native publish returns the byte count on delivery, 0 for an empty
			// cohort - so this reports honestly whether any cohort had a member.
			return (typeof binBytes === 'number' && binBytes > 0) || (typeof jsonBytes === 'number' && jsonBytes > 0);
		}

		let delivered = false;
		/** @type {Map<number, Uint8Array>} */
		const frameById = new Map();
		for (const ws of wsConnections) {
			if (ws === excludeWs) continue;
			let ud;
			try {
				ud = ws.getUserData();
			} catch {
				wsCounters.closedWsAborts++;
				continue;
			}
			const subs = ud[WS_SUBSCRIPTIONS];
			if (!subs || !subs.has(topic)) continue;
			const caps = ud[WS_CAPS];
			if (caps && caps.has(wire.capability) && !wireStatePoisoned(ud, wire.capability)) {
				const id = ensureWireId(ws, ud, topic);
				if (id === -1) {
					// Dropped wire-id announce: the topic-id mapping is itself
					// per-connection state the client now permanently lacks, so
					// even a stateless codec's frames would be undecodable.
					// JSON for this frame, and poison. A dropped binary FRAME
					// below needs no such handling - the shared payload carries
					// no per-connection state, so a lost frame cannot desync.
					poisonWireState(ws, ud, wire.capability);
					delivered = wireEnvelopeSend(ws, envelope, compress) || delivered;
					continue;
				}
				let frame = frameById.get(id);
				if (!frame) {
					frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload);
					frameById.set(id, frame);
				}
				try {
					if (ws.send(frame, true, compress) !== SEND_DROPPED) {
						bumpOut(ws, frame);
						delivered = true;
					}
				} catch {
					wsCounters.closedWsAborts++;
				}
			} else {
				delivered = wireEnvelopeSend(ws, envelope, compress) || delivered;
			}
		}
		return delivered;
	},

	/**
	 * Multi-entry fan-out via a stateful plugin codec: one tick's same-event
	 * updates delivered as ONE binary frame per capable connection (the
	 * codec's `<event>-batch` form) and as the per-entry JSON envelopes -
	 * byte-identical to N publishWire calls - for everyone else. Each entry
	 * may carry its own `excludeWs` (per-entry author suppression); an entry
	 * is withheld from its excluded socket on every delivery path.
	 *
	 * Sequencing and accounting match N publishWire calls exactly: one seq
	 * per entry. The binary batch frame's header seq slot carries the
	 * subset's LAST entry seq (batch consumers order by the codec's own
	 * stamp, not the header seq).
	 *
	 * Degradation: a codec that cannot represent the batch (null) falls back to
	 * per-entry encodes; a per-entry null falls back to that entry's JSON
	 * envelope; a dropped frame or wire-id announce poisons the capability to
	 * JSON until reconnect. A connection whose codec state is null (it
	 * negotiated the stateless schema of a stateful codec) receives the
	 * per-entry JSON envelopes: the batch frame is a stateful-state
	 * optimization, and JSON is the form every client can decode. A wholly
	 * stateless codec never reaches here - publishWireBatch routes it through
	 * publishWire per entry above, keeping its binary fan-out.
	 *
	 * An explicit cluster seq belongs on the ENTRY (`{ data, seq }`), not on the
	 * batch: one seq per entry is the contract above, and a single number cannot
	 * satisfy it for N entries. A batch-level `{ seq: <number> }` therefore
	 * THROWS, exactly as a per-entry seq the wire cannot carry does - see
	 * throwBatchExplicitSeq for why absorbing it either way loses data silently.
	 * `{ seq: true }` is unaffected: the counter increments per entry, which is
	 * already one seq per entry.
	 *
	 * The batch is read ONCE, at the top of the call: `entries` and `options`
	 * are captured (own enumerable properties) into private records, so
	 * mutating the caller's array, entry objects or options object after the
	 * call starts - from a payload's toJSON, say - does not change what the
	 * batch publishes. The payload reference is captured too; its CONTENTS
	 * stay live, serialising whenever the lane serialises, as on every
	 * publish lane.
	 *
	 * @param {string} topic
	 * @param {string} event - the PER-ENTRY event name; the codec's batch
	 *   form is looked up as `<event>-batch` with `{ updates }` data.
	 * @param {Array<{ data: any, excludeWs?: any, seq?: number }>} entries
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any }} wire
	 * @param {{ seq?: boolean, compress?: boolean }} [options] - `seq` is the
	 *   counter opt-in only; a number here is the refused batch-level form.
	 * @returns {boolean}
	 * @throws {TypeError} on a batch-level explicit seq, or an entry seq the
	 *   wire cannot carry
	 */
	publishWireBatch(topic, event, entries, wire, options) {
		// The call-level options are captured FIRST: one explicit read per
		// field, taken before any other app-observable read. Everything below
		// runs app code sooner or later (completeEnvelope's JSON.stringify
		// calls any toJSON, and the entries walk can trap through a Proxy),
		// and app code holds live references to the caller's objects - an
		// options.seq that answers the refusal below with one value and a
		// later read with another would smuggle the refused batch-level seq
		// form in for every counter-lane entry. The value refused and the
		// value used are one read. Field reads rather than a spread, because a
		// spread copies own enumerable properties only: a numeric seq carried
		// on a prototype, or by an inherited accessor, would vanish from the
		// copy and slip past a refusal every other read of the same object
		// would have thrown on.
		if (options) options = { seq: options.seq, compress: options.compress, excludeWs: options.excludeWs };
		// Checked BEFORE the empty-batch no-op below. A batch-level seq is a
		// property of the CALL, not of this tick's data, so whether it is
		// refused must not depend on how many entries happened to be ready -
		// otherwise the misuse hides on exactly the ticks that publish nothing
		// and surfaces later under load, which is what fail-fast exists to
		// prevent.
		if (options && typeof options.seq === 'number') throwBatchExplicitSeq(topic, options.seq);
		if (!Array.isArray(entries) || entries.length === 0) return false;
		// Every per-entry seq is checked AND CAPTURED before anything is
		// stamped or sent. stampExplicitSeq throws on a seq the wire cannot
		// carry, and a throw from inside either publish loop below would leave
		// the earlier entries already fanned out and the topic's mark already
		// advanced, for a batch that never went out whole. Whole-batch or
		// nothing, like the refusals around it. The predicate matches the
		// stamping paths exactly, so a nullish or non-numeric `seq` falls
		// through to the counter lane as it does there rather than being
		// refused only here.
		//
		// Captured rather than merely checked: the batch is normalised into
		// PRIVATE RECORDS - data reference, exclusion target, validated seq -
		// and every read below is against these records, never the caller's
		// array or entry objects again. A toJSON rewriting a later entry's
		// seq would otherwise have it stamped unchecked on the stateful lane,
		// or thrown on mid-batch by the per-entry reroute with earlier
		// entries already delivered; one flipping excludeWs would make
		// delivery, the fast-path choice and the resume capture disagree
		// about who was excluded; one swapping a data reference would put
		// different payloads on the two wires under one seq; and one growing
		// or shrinking the array would publish a membership no pre-pass ever
		// saw. What this batch publishes is what this call was handed.
		// (Payload INTERNALS stay the app's own objects, as on every publish
		// lane - the record pins the reference, not the contents.)
		const n = entries.length;
		{
			const records = new Array(n);
			for (let i = 0; i < n; i++) {
				const e = entries[i];
				records[i] = {
					data: e.data,
					excludeWs: e.excludeWs,
					seq: typeof e.seq === 'number' ? stampExplicitSeq(e.seq, topic) : undefined
				};
			}
			entries = records;
		}
		// A stateless codec gains nothing from a batched walk (encode-once
		// already amortizes it) - route through the per-entry path unchanged.
		//
		// This lane is N independent publishes, so "whole batch or nothing"
		// covers the SEQ only: every seq below comes from the pre-pass
		// snapshot, already accepted, so no publish in this loop can throw on
		// one - but a payload that fails to serialise partway through leaves
		// the earlier entries already fanned out and counted. Making it atomic
		// would mean serialising every entry up front and then again per
		// publish, which is the cost this reroute exists to avoid. The
		// stateful lane below builds all its envelopes first and so IS whole
		// for both.
		if (!wire || !wire.state) {
			let ok = false;
			for (let i = 0; i < n; i++) {
				// The private record from the pre-pass, not the caller's entry:
				// by the second iteration, app toJSON code has already run
				// inside the first entry's publish, and the caller's objects
				// can no longer be trusted to say what this call was handed.
				const entry = entries[i];
				// Allocate a per-entry options object only when the entry
				// actually overrides something, as the exclude-only form did.
				let per = options;
				if (entry.excludeWs !== undefined || entry.seq !== undefined) {
					per = { ...(options || {}) };
					if (entry.excludeWs !== undefined) per.excludeWs = entry.excludeWs;
					if (entry.seq !== undefined) per.seq = entry.seq;
				}
				ok = this.publishWire(topic, event, entry.data, wire, per) || ok;
			}
			return ok;
		}
		const compress = ws_compression_on && !!(options && options.compress === true);

		// Per-entry seq and envelope - the exact bookkeeping N publishWire
		// calls would have produced.
		const envs = new Array(n);
		// The seq AS STAMPED: a number, or null for an entry carrying none.
		// Deliberately not the wire's 0 sentinel, which the frame builder wants
		// but the resume capture must not see: 0 is a seq the explicit lane can
		// legitimately issue, and collapsing it into "no seq" hands the capture a
		// null that is never deduped, so the same event is deduped through
		// publish() and re-delivered through here. The 0 is applied at the frame
		// sites below, where it means "no seq" on the wire and nowhere else.
		const seqs = new Array(n);
		// Authority per entry, decided in the pre-pass and reused below. The
		// records are private, so nothing an app toJSON does between here and
		// delivery can change what they say.
		const authoritative = new Array(n);
		let anyExclude = false;
		for (let i = 0; i < n; i++) {
			const entry = entries[i];
			// A per-entry explicit seq is cluster-authoritative exactly as the
			// same value would be through publishWire, and already took the
			// same wire-representability check in the pre-pass, whose record
			// is stamped verbatim here. Anything else draws from this batch's
			// shared options (the counter, or no seq at all).
			const seq = entry.seq !== undefined ? entry.seq : stampSeq(options, topic);
			// An explicit entry seq is authoritative by construction: the
			// pre-pass accepted it or threw - there is no refused-but-published
			// case left to tell apart, and no way for a toJSON run by an
			// earlier iteration's completeEnvelope to swap in a value the
			// pre-pass never saw.
			authoritative[i] = entry.seq !== undefined;
			seqs[i] = seq;
			envs[i] = completeEnvelope(envelopePrefix(topic, event), entry.data, seq);
			if (entry.excludeWs !== undefined && entry.excludeWs !== null) anyExclude = true;
		}
		// The topic's mark and the publish count both move only once EVERY entry
		// has stamped AND serialized. completeEnvelope runs app code and throws
		// on a payload JSON cannot carry, so doing either inside the loop above
		// left a batch that put nothing on any wire with its authoritative mark
		// already advanced for the entries it got through - and that mark is the
		// resume dedup floor, so a later window would discard the republished
		// frames as already-seen. Whole batch or nothing, the rule the per-entry
		// seq pre-pass already enforces.
		//
		// ONE thing is not rolled back, deliberately: the `{ seq: true }` counter
		// advanced in the loop above for every entry it stamped. It cannot be
		// undone safely - completeEnvelope runs JSON.stringify, so a toJSON can
		// publish re-entrantly and take the next value, and a rollback would then
		// hand two frames the same seq. And it costs nothing: the counter is a
		// separate space that is never deduped and never marks the topic, so a
		// refused batch leaves a gap in that topic's counter numbering and
		// nothing else. No contract anywhere calls that lane contiguous.
		const server = getServer();
		for (let i = 0; i < n; i++) {
			if (authoritative[i]) notePublishedSeq(topic, seqs[i], true);
			else recordPublishedSeq(topic, seqs[i], options);
		}
		wsCounters.publishCount += n;
		// Resume cutover in flight: hold the per-entry JSON envelopes a
		// caps-less resuming subscriber would receive from this batch, each
		// skipping the socket its own entry excluded.
		if (resumeBuffers.size > 0) {
			// Authority is per ENTRY here, not per call: an entry carrying its own
			// explicit seq sits in the cluster space and is measured against the
			// dedup floor, while a counter-stamped one is not. The call-level
			// options cannot contribute authority - a numeric batch seq was
			// refused above - so the entry is the whole answer, as decided in the
			// stamping pass and carried in `authoritative` rather than read off
			// the app's entries a second time.
			for (let i = 0; i < n; i++) {
				captureResumeFrame(
					topic,
					seqs[i],
					envs[i],
					compress,
					entries[i].excludeWs,
					authoritative[i]
				);
			}
		}

		// Declared here, before the helper that closes over it, so the two can
		// be read together. The fast path below returns its own byte tally
		// without consulting this flag.
		let delivered = false;

		const sendJson = (ws, list) => {
			for (let i = 0; i < list.length; i++) {
				try {
					if (ws.send(list[i], false, compress) !== SEND_DROPPED) {
						bumpOut(ws, list[i]);
						delivered = true;
					}
				} catch {
					wsCounters.closedWsAborts++;
					return;
				}
			}
		};

		// JSON fast path: no live connection wants binary for this codec and
		// no entry excludes a socket - N native fan-outs, byte-identical to N
		// publishWire calls.
		if (!anyExclude && !capCounts.has(wire.capability)) {
			let anyBytes = false;
			for (let i = 0; i < n; i++) {
				const r = server.publish(topic, envs[i], compress);
				if (typeof r === 'number' && r > 0) anyBytes = true;
			}
			return anyBytes;
		}
		for (const ws of wsConnections) {
			let ud;
			try {
				ud = ws.getUserData();
			} catch {
				wsCounters.closedWsAborts++;
				continue;
			}
			const subs = ud[WS_SUBSCRIPTIONS];
			if (!subs || !subs.has(topic)) continue;
			// The subset this socket receives: entries not excluded for it.
			// The no-exclusion common case reuses the shared arrays. The seq
			// list is filtered ALONGSIDE them: the declined-batch lane below
			// stamps per-entry frames from it, and indexing the unfiltered
			// array with a subset index stamps one entry's payload with
			// another's seq - the client then records a watermark that never
			// matches the frame it holds.
			let list = entries;
			let envList = envs;
			let seqList = seqs;
			let lastSeq = seqs[n - 1];
			if (anyExclude) {
				list = [];
				envList = [];
				seqList = [];
				for (let i = 0; i < n; i++) {
					if (entries[i].excludeWs === ws) continue;
					list.push(entries[i]);
					envList.push(envs[i]);
					seqList.push(seqs[i]);
					lastSeq = seqs[i];
				}
				if (list.length === 0) continue;
			}
			const caps = ud[WS_CAPS];
			if (!caps || !caps.has(wire.capability)) {
				sendJson(ws, envList);
				continue;
			}
			// A poisoned capability reads a null state and is served JSON,
			// exactly like publishWire's null-state branch.
			const state = ensureWireState(ws, ud, wire);
			if (state == null) {
				sendJson(ws, envList);
				continue;
			}
			const updates = new Array(list.length);
			for (let i = 0; i < list.length; i++) updates[i] = list[i].data;
			const payload = safeEncode(wire, event + '-batch', { updates }, state);
			const sv =
				typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
			if (payload == null) {
				// A FAILED batch encode may have advanced this connection's
				// dictionaries partway - running the per-entry encodes below
				// against that state would reference entries the client never
				// learned. Poison and serve the JSON envelopes; only a clean
				// decline earns the per-entry retry.
				if (encodeFailed) {
					poisonWireState(ws, ud, wire.capability);
					sendJson(ws, envList);
					continue;
				}
				// The codec declined the batch (older codec, unrepresentable
				// entry): per-entry encodes with per-entry JSON fallback - the
				// N publishWire bodies this call replaces.
				for (let i = 0; i < list.length; i++) {
					const p = safeEncode(wire, event, list[i].data, state);
					if (p == null) {
						// Same rule per entry: a failure poisons and the rest
						// of the batch goes out as JSON; a decline costs only
						// this entry's binary form.
						if (encodeFailed) {
							poisonWireState(ws, ud, wire.capability);
							sendJson(ws, envList.slice(i));
							break;
						}
						try {
							if (ws.send(envList[i], false, compress) !== SEND_DROPPED) {
								bumpOut(ws, envList[i]);
								delivered = true;
							}
						} catch {
							wsCounters.closedWsAborts++;
							break;
						}
						continue;
					}
					const id = ensureWireId(ws, ud, topic);
					if (id === -1) {
						poisonWireState(ws, ud, wire.capability);
						sendJson(ws, envList.slice(i));
						break;
					}
					// 0 is the wire's "no seq" (see sendWire); the null lives only
					// in seqs, where the resume capture can still read it.
					const frame = buildBinaryFrame(sv, id, seqList[i] ?? 0, p);
					let result;
					try {
						result = ws.send(frame, true, compress);
					} catch {
						wsCounters.closedWsAborts++;
						break;
					}
					if (result !== SEND_DROPPED) { bumpOut(ws, frame); delivered = true; }
					if (result === SEND_DROPPED) {
						poisonWireState(ws, ud, wire.capability);
						sendJson(ws, envList.slice(i + 1));
						break;
					}
				}
				continue;
			}
			const id = ensureWireId(ws, ud, topic);
			if (id === -1) {
				// Dropped wire-id announce: binary is permanently undecodable
				// here, and the batch encode already advanced this
				// connection's dictionaries - the desync poisoning exists for.
				poisonWireState(ws, ud, wire.capability);
				sendJson(ws, envList);
				continue;
			}
			const frame = buildBinaryFrame(sv, id, lastSeq ?? 0, payload);
			let result;
			try {
				result = ws.send(frame, true, compress);
			} catch {
				wsCounters.closedWsAborts++;
				continue;
			}
			if (result !== SEND_DROPPED) { bumpOut(ws, frame); delivered = true; }
			// The encode mutated the dictionaries for a frame the client
			// never saw - JSON until reconnect.
			if (result === SEND_DROPPED) poisonWireState(ws, ud, wire.capability);
		}
		return delivered;
	},

	/**
	 * Single-target send via a plugin-declared binary wire codec. The target
	 * receives a `0x03` frame when it advertised `wire.capability` and the
	 * codec can encode this frame; otherwise it receives the JSON envelope
	 * `send()` would have sent. No seq is stamped (matches `send()`); the
	 * binary frame carries seq 0 ("no seq"). Used for snapshot/catalog frames.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @param {string} event
	 * @param {any} data
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any }} wire
	 * @param {{ compress?: boolean }} [options] - `{ compress: true }` opts this
	 *   low-frequency binary frame into permessage-deflate when a compressor is
	 *   configured (binary frames are uncompressed by default).
	 * @returns {0 | 1 | 2} the send tri-state, or 2 on a closed socket
	 */
	sendWire(ws, topic, event, data, wire, options) {
		let ud;
		try {
			ud = ws.getUserData();
		} catch {
			wsCounters.closedWsAborts++;
			return SEND_DROPPED;
		}
		const caps = ud[WS_CAPS];
		// Binary codec frames compress only when the caller opts in with
		// `{ compress: true }` AND a compressor is configured: the
		// high-frequency paths this exists for are exactly the ones per-frame
		// deflate would tax.
		const compress = ws_compression_on && !!(options && options.compress === true);
		let payload = null;
		let schemaVersion = wire.schemaVersion;
		// A poisoned capability is served exactly like a caps-less connection:
		// the JSON envelope, never binary (see handler/wire-state.js).
		if (caps && caps.has(wire.capability) && !wireStatePoisoned(ud, wire.capability)) {
			if (wire.state) {
				// Share the connection's codec state with publishWire so a
				// snapshot CATALOG interns ids the following BULK (and every
				// later broadcast) references against the same dictionary.
				const state = ensureWireState(ws, ud, wire);
				payload = safeEncode(wire, event, data, state);
				// A failed encode against real per-connection state poisons,
				// as on every stateful lane; with a null state (older client
				// on the stateless schema) there is nothing to desync.
				if (payload == null && state != null && encodeFailed) {
					poisonWireState(ws, ud, wire.capability);
				}
				if (state != null && typeof state.schemaVersion === 'number') {
					schemaVersion = state.schemaVersion;
				}
			} else {
				payload = safeEncode(wire, event, data);
			}
		}
		if (payload == null) {
			return wireJsonSend(ws, topic, event, data, compress);
		}
		const id = ensureWireId(ws, ud, topic);
		if (id === -1) {
			// Dropped wire-id announce: the client can never resolve this
			// topic's numeric id, so binary for this capability is permanently
			// undecodable here. JSON for this frame, and poison so every later
			// frame takes the JSON path too.
			poisonWireState(ws, ud, wire.capability);
			return wireJsonSend(ws, topic, event, data, compress);
		}
		const frame = buildBinaryFrame(schemaVersion, id, 0, payload);
		let result;
		try {
			result = ws.send(frame, true, compress);
		} catch {
			wsCounters.closedWsAborts++;
			return SEND_DROPPED;
		}
		if (result !== SEND_DROPPED) bumpOut(ws, frame);
		// A dropped STATEFUL frame poisons: the encode already mutated this
		// connection's dictionary for a frame the client never saw, and that
		// desync is unrecoverable in-band. Stateless payloads carry no
		// per-connection state, so a drop costs only the frame.
		if (result === SEND_DROPPED && wire.state) poisonWireState(ws, ud, wire.capability);
		return result;
	},

	/**
	 * Multi-entry single-target send via a stateful plugin codec: one tick's
	 * same-event updates for ONE subscriber as a single binary frame (the
	 * codec's `<event>-batch` form), or the per-entry JSON envelopes when the
	 * connection has no capability / is poisoned. The per-subscriber twin of
	 * publishWireBatch, for culled per-viewer delivery walks. No seq is
	 * stamped (matches `send()` / `sendWire()`); the binary frame carries
	 * seq 0.
	 *
	 * Degradation: a declined batch falls back to per-entry encodes, a
	 * per-entry null to that entry's JSON envelope, and a dropped stateful
	 * frame poisons the capability to JSON until reconnect. A stateless codec
	 * has no batch form and is routed per entry through sendWire, so a capable
	 * connection still receives binary rather than JSON.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @param {string} event - the PER-ENTRY event name
	 * @param {Array<{ data: any }>} entries
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any }} wire
	 * @param {{ compress?: boolean }} [options]
	 * @returns {0 | 1 | 2} the tri-state of the LAST frame sent, 1 for an
	 *   empty entries array, or 2 on a closed socket
	 */
	sendWireBatch(ws, topic, event, entries, wire, options) {
		if (!Array.isArray(entries) || entries.length === 0) return 1;
		let ud;
		try {
			ud = ws.getUserData();
		} catch {
			wsCounters.closedWsAborts++;
			return SEND_DROPPED;
		}
		const caps = ud[WS_CAPS];
		const compress = ws_compression_on && !!(options && options.compress === true);
		const sendJsonFrom = (i) => {
			let result = 1;
			for (; i < entries.length; i++) {
				result = wireJsonSend(ws, topic, event, entries[i].data, compress);
				if (result === SEND_DROPPED && ws._closed) return SEND_DROPPED;
			}
			return result;
		};
		if (!caps || !caps.has(wire.capability) || wireStatePoisoned(ud, wire.capability)) {
			return sendJsonFrom(0);
		}
		// A STATELESS codec has no batch form; route each entry through
		// sendWire so a capable connection still gets binary, exactly as the
		// fan-out batch routes a stateless codec through publishWire per entry.
		// Dumping to JSON here would send a capable client JSON from
		// sendWireBatch while sendWire sent it binary for the same codec.
		if (!wire.state) {
			let result = 1;
			for (let i = 0; i < entries.length; i++) {
				result = this.sendWire(ws, topic, event, entries[i].data, wire, options);
				if (result === SEND_DROPPED && ws._closed) return SEND_DROPPED;
			}
			return result;
		}
		const state = ensureWireState(ws, ud, wire);
		if (state == null) return sendJsonFrom(0);
		const updates = new Array(entries.length);
		for (let i = 0; i < entries.length; i++) updates[i] = entries[i].data;
		const schemaVersion =
			typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
		const payload = safeEncode(wire, event + '-batch', { updates }, state);
		if (payload == null) {
			// A FAILED batch encode may have advanced the dictionaries partway;
			// poison and serve JSON rather than encode per entry against state
			// the client never learned (see publishWireBatch).
			if (encodeFailed) {
				poisonWireState(ws, ud, wire.capability);
				return sendJsonFrom(0);
			}
			// The codec declined the batch (older codec, unrepresentable
			// entry): the N sendWire bodies this call replaces.
			let result = 1;
			for (let i = 0; i < entries.length; i++) {
				const p = safeEncode(wire, event, entries[i].data, state);
				if (p == null) {
					if (encodeFailed) {
						poisonWireState(ws, ud, wire.capability);
						return sendJsonFrom(i);
					}
					result = wireJsonSend(ws, topic, event, entries[i].data, compress);
					continue;
				}
				const id = ensureWireId(ws, ud, topic);
				if (id === -1) {
					poisonWireState(ws, ud, wire.capability);
					return sendJsonFrom(i);
				}
				const frame = buildBinaryFrame(schemaVersion, id, 0, p);
				try {
					result = ws.send(frame, true, compress);
				} catch {
					wsCounters.closedWsAborts++;
					return SEND_DROPPED;
				}
				if (result !== SEND_DROPPED) bumpOut(ws, frame);
				if (result === SEND_DROPPED) {
					poisonWireState(ws, ud, wire.capability);
					return sendJsonFrom(i + 1);
				}
			}
			return result;
		}
		const id = ensureWireId(ws, ud, topic);
		if (id === -1) {
			// Dropped wire-id announce; the batch encode already advanced this
			// connection's dictionaries - the desync the poisoning exists for.
			poisonWireState(ws, ud, wire.capability);
			return sendJsonFrom(0);
		}
		const frame = buildBinaryFrame(schemaVersion, id, 0, payload);
		let result;
		try {
			result = ws.send(frame, true, compress);
		} catch {
			wsCounters.closedWsAborts++;
			return SEND_DROPPED;
		}
		if (result !== SEND_DROPPED) bumpOut(ws, frame);
		if (result === SEND_DROPPED) poisonWireState(ws, ud, wire.capability);
		return result;
	},

	/**
	 * Ask connected clients to reconnect on a jittered schedule, then (by
	 * default) close them.
	 *
	 * This is required equipment for a managed drain on Bun, not a nicety:
	 * `server.stop()` leaves open WebSockets fully FUNCTIONAL - an echo
	 * round-trip completes after it (probed) - and they are only cut when
	 * `stop(true)` terminates them with a 1006. Without an explicit advise +
	 * close, a rolling deploy either hangs waiting for sockets that never leave
	 * or guillotines them.
	 *
	 * Each client rolls its own delay inside the window rather than the server
	 * assigning one, so a fleet does not re-hammer the replacement in a single
	 * backoff tick.
	 *
	 * @param {{ windowMs?: number, afterMs?: number, close?: boolean, filter?: (userData: any) => boolean, compress?: boolean }} [options]
	 * @returns {number} connections the advisory actually REACHED. A client past
	 *   its backpressure limit is closed but not counted, because it never saw
	 *   the frame. In the close-only mode (`{ close: true }` with no `windowMs`)
	 *   there is no advisory to reach anyone, so this counts connections closed.
	 */
	adviseReconnect(options) {
		const windowMs = options && typeof options.windowMs === 'number' && options.windowMs > 0
			? Math.floor(options.windowMs)
			: 0;
		const afterMs = options && typeof options.afterMs === 'number' && options.afterMs > 0
			? Math.floor(options.afterMs)
			: 0;
		const doClose = !options || options.close !== false;
		// A window is what makes an ADVISORY possible; with none there is nothing
		// to tell the client. But a caller that EXPLICITLY asked to close still
		// gets the close: returning early here would make
		// `adviseReconnect({ close: true })` a silent no-op - zero advised,
		// zero closed, no warning. A bare `adviseReconnect()` still returns 0
		// without closing anything, because close-defaults-true must not turn an
		// argument-less call into a mass disconnect.
		const advisory = windowMs > 0;
		if (!advisory && !(options && options.close === true)) return 0;
		const filter = options && typeof options.filter === 'function' ? options.filter : null;
		// Additive control frame: an old client that does not know the type
		// ignores it and falls back to ordinary backoff, so this needs no
		// capability negotiation.
		const frame = !advisory
			? ''
			: afterMs > 0
				? '{"type":"reconnect","afterMs":' + afterMs + ',"windowMs":' + windowMs + '}'
				: '{"type":"reconnect","windowMs":' + windowMs + '}';
		const compress = ws_compression_on && !!(options && options.compress === true);
		let count = 0;
		// Snapshot the registry: with close:true the close handler runs and
		// mutates wsConnections while we iterate.
		for (const ws of [...wsConnections]) {
			let userData;
			try {
				userData = ws.getUserData();
			} catch {
				wsCounters.closedWsAborts++;
				continue;
			}
			if (filter) {
				const decision = filter(userData);
				// An async filter cannot be evaluated synchronously, and a
				// Promise is truthy - so treating it as a verdict would advise
				// and CLOSE every connection on the instance, which is the
				// opposite of the caller's intent when they filtered. Fail
				// closed, exactly as sendTo does.
				if (decision && typeof decision.then === 'function') {
					if (!wsCounters.adviseAsyncWarned) {
						wsCounters.adviseAsyncWarned = true;
						console.error(
							'[ws] platform.adviseReconnect filter returned a Promise; treating as fail-closed.\n' +
							'  Async filters cannot be used here because the drain walks every active\n' +
							'  connection synchronously. Resolve the fields you need into userData from\n' +
							'  your `upgrade` hook so the filter can read them synchronously.'
						);
					}
					continue;
				}
				if (!decision) continue;
			}
			if (advisory) {
				let result;
				try {
					result = ws.send(frame, false, compress);
				} catch {
					wsCounters.closedWsAborts++;
					continue;
				}
				// SEND_DROPPED means the frame never reached the wire: this client
				// is past its backpressure limit. Counting it as advised reports a
				// reconnect window the client never received - and since the
				// buffer cannot drain, the graceful close below cannot flush
				// either, so this client sees a 1006 no matter what. Close it
				// anyway (nothing better is available) but do not claim it was
				// advised; the drain reports the difference.
				if (result === SEND_DROPPED) {
					if (doClose) ws.end(1012, 'server draining');
					continue;
				}
				bumpOut(ws, frame);
			}
			count++;
			// 1012 "service restart" is the honest code for a drain, and the
			// client's reconnect scheduling is already carried by the frame.
			if (doClose) ws.end(1012, 'server draining');
		}
		return count;
	},

	/**
	 * Subscribe a connection from server-side code, running the app's
	 * `subscribe` hook first.
	 *
	 * Always prefer this over a raw `ws.subscribe(topic)` for server-initiated
	 * subscriptions: the wire-level authorization hook fires only for client
	 * `subscribe` frames, so a direct socket call silently bypasses the gate
	 * and can leak a topic the app would have refused.
	 *
	 * Idempotent - subscribing twice returns null both times, charges the
	 * counter once, and runs the hook once.
	 *
	 * Exactly THREE parameters, and deliberately not four: the batch verdict
	 * travels through `subscribeWithVerdict` below, which is not reachable from
	 * this object. A fourth positional parameter here made every extra argument a
	 * caller happened to pass an unconditional gate bypass -
	 * `topics.map(platform.subscribe.bind(platform, ws))` supplies
	 * `(topic, index, array)`, and the array read as an allow verdict.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @param {{ allowSystemTopic?: boolean }} [options]
	 * @returns {Promise<string | null>} null on success, else a denial reason
	 */
	async subscribe(ws, topic, options) {
		return subscribeWithVerdict(ws, topic, options, undefined);
	},

	/**
	 * Run the app's subscribe authorization hook without subscribing.
	 *
	 * Applies the SAME system-namespace guard `subscribe` does, with the same
	 * `{ allowSystemTopic: true }` escape. Without it the two disagreed about
	 * the same topic, and the documented check-then-subscribe pattern - which
	 * ends in a bare `ws.subscribe(topic)` the adapter never sees - became the
	 * way to reach an internal channel with client input. Nothing in the family
	 * asks this about a `__` topic: the extensions' observer lanes pass the real
	 * application topic, and the one caller that starts from a `__cursor:` name
	 * strips the prefix before asking.
	 *
	 * `requireGrant` is the other member the family defines here, and it is
	 * still not read: the grant test it asks for needs `authorizeWireSubscribe`,
	 * which this port does not have, so the donor itself falls through to the
	 * app gate in every reachable configuration. See runSubscribeGate.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @param {any} [options]
	 * @returns {Promise<string | null>} a denial reason, or null to allow
	 */
	async checkSubscribe(ws, topic, options) {
		// Validated BEFORE the system-namespace guard, because `isSystemTopic`
		// reads `topic.charCodeAt(0)` and this is the one gate entry point the
		// adapter cannot see the other half of - the documented pattern is
		// `if (await platform.checkSubscribe(ws, topic) !== null) return;` over a
		// topic taken straight from client input. Guard-first turned
		// `{"room": null}` into a rejected promise where `subscribe` returns
		// `INVALID_TOPIC`, so the two disagreed at exactly the boundary the
		// shared gate exists to keep them agreeing on. It fails closed in the
		// documented spelling, but an app wrapping the call in a try/catch with
		// a permissive fallback flips that open.
		if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
		if (!(options && options.allowSystemTopic) && isSystemTopic(topic)) {
			return 'INVALID_TOPIC';
		}
		return runSubscribeGate(ws, topic);
	},

	/**
	 * Unsubscribe a connection and keep the adapter's bookkeeping in step.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @returns {boolean} whether the connection had been subscribed
	 */
	unsubscribe(ws, topic) {
		let userData;
		try {
			userData = ws.getUserData();
		} catch {
			wsCounters.closedWsAborts++;
			return false;
		}
		// Cancel any subscribe for this topic still sitting in the authorization
		// gate. Done BEFORE the membership check, because the racing case is
		// exactly the one where the topic is not in `subs` yet - an unsubscribe
		// that returns early here would let the gate land afterwards and
		// resurrect a subscription the client just cancelled.
		tombstonePendingSubscribe(userData, topic);
		const subs = userData[WS_SUBSCRIPTIONS];
		if (!subs || !subs.has(topic)) return false;
		try {
			ws.unsubscribe(topic);
		} catch {
			// The native membership is already gone with the socket; the
			// bookkeeping below still has to run or the counter leaks.
			wsCounters.closedWsAborts++;
		}
		subs.delete(topic);
		wsCounters.totalSubscriptions--;
		// A shared topic's cohort membership travels with the logical
		// subscription; leaving releases the wire-id ref this connection held.
		if (sharedTopics.has(topic)) leaveSharedCohort(ws, userData, topic);
		return true;
	},

	/** Live connections on THIS instance. */
	get connections() {
		return wsConnections.size;
	},

	/**
	 * Sum of every live connection's subscription count on this instance.
	 *
	 * Maintained on the subscribe/unsubscribe/close paths - hot-path work that
	 * only earns its keep because this getter exposes it.
	 */
	get totalSubscriptions() {
		return wsCounters.totalSubscriptions;
	},

	/** Topic publishes since boot on this instance. Monotonic. */
	get publishCount() {
		return wsCounters.publishCount;
	},

	/**
	 * Clients subscribed to a topic on this instance. This reads Bun's native
	 * membership count, so it also sees subscriptions made by a direct
	 * `ws.subscribe` that never went through `platform.subscribe`.
	 *
	 * @param {string} topic
	 * @returns {number}
	 */
	subscribers(topic) {
		return getServer().subscriberCount(topic);
	},

	/**
	 * Invoke `fn(ws, userData)` for every connection subscribed to `topic`.
	 * Where `subscribers()` gives a count, this yields the sockets, so a caller
	 * can make a per-recipient decision the shared fan-out cannot: a culled
	 * slice, a skipped slow consumer, a per-viewport payload.
	 *
	 * O(connections) and paid entirely by the caller - the zero-config publish
	 * path never walks. Reads the adapter's own subscription set rather than
	 * native membership, because native membership yields no userData.
	 *
	 * @param {string} topic
	 * @param {(ws: any, userData: any) => void} fn
	 */
	forEachSubscriber(topic, fn) {
		for (const ws of wsConnections) {
			let ud;
			try {
				ud = ws.getUserData();
			} catch {
				wsCounters.closedWsAborts++;
				continue;
			}
			const subs = ud[WS_SUBSCRIPTIONS];
			if (subs && subs.has(topic)) fn(ws, ud);
		}
	},

	/**
	 * Largest inbound frame, in bytes, the server accepts. Bun closes the
	 * connection on anything larger (probed: a 4 KiB frame against a 1 KiB cap
	 * closed the socket with 1006), so size payloads against this rather than
	 * guessing.
	 */
	get maxPayloadLength() {
		return ws_options?.maxPayloadLength ?? 1024 * 1024;
	},

	/**
	 * Bytes queued on `ws` but not yet flushed. Returns 0 for a closed
	 * connection rather than throwing, so it is safe to call on every send in a
	 * backpressure-aware loop.
	 *
	 * @param {any} ws
	 * @returns {number}
	 */
	bufferedAmount(ws) {
		try {
			return ws.getBufferedAmount();
		} catch {
			return 0;
		}
	},

	/** Sends/subscribes refused because the socket had already closed. */
	get closedWsAborts() {
		return wsCounters.closedWsAborts;
	},

	/**
	 * Releases whose teardown could not be recorded for the close hook. Any
	 * non-zero value means an `unsubscribe` hook has been failing persistently
	 * enough to fill a connection's record, so those releases lost the
	 * close-hook fallback. Their own hook is then the only thing that could
	 * have torn them down - and if the deferral queue was also full, it did not
	 * run either.
	 */
	get droppedReleaseRecords() {
		return wsCounters.droppedReleaseRecords;
	},

	/**
	 * A publisher scoped to one topic: `platform.topic('chat').created(data)`.
	 * Helpers are cached per name, so this allocates once per topic rather than
	 * once per call.
	 *
	 * @param {string} name
	 */
	topic(name) {
		if (topicHelperCache === null) {
			topicHelperCache = createTopicHelperCache(
				(topic, event, data) => platform.publish(topic, event, data)
			);
		}
		return topicHelperCache(name);
	},

	/**
	 * Determinism seams. App and plugin code reads wall clock, monotonic time,
	 * and randomness through the platform so a deterministic simulation can
	 * substitute all three in one place instead of patching globals.
	 */
	now() {
		return Date.now();
	},

	monotonic() {
		return performance.now();
	},

	/**
	 * Randomness, as an OBJECT of named generators rather than a single
	 * function. The shape is load-bearing: consumers reach for `random.u32()`
	 * and `random.uuid()` directly, and the extensions bus guards with
	 * `platform.random ?? fallback` - a bare function is truthy, so it would
	 * defeat that fallback and then throw on the first `.u32()`. A
	 * present-but-wrong member is worse than an absent one.
	 */
	random: {
		float: () => Math.random(),
		u32: () => Math.floor(Math.random() * 0x1_0000_0000) >>> 0,
		uuid: () => crypto.randomUUID(),
		/** @param {number} n */
		bytes: (n) => crypto.getRandomValues(new Uint8Array(n))
	}
};


/**
 * The implementation behind `platform.subscribe`, plus the PRIVATE verdict
 * channel the wire batch path needs.
 *
 * Kept OFF the platform object on purpose. The verdict says "the gate has
 * already run for this topic in this frame, do not run it again", so anything
 * able to supply one can install a subscription the app never authorized - and
 * every caller-reachable spelling is forgeable: a key on the options bag (a
 * Proxy with a catch-all `get` answers even a Symbol key), or a trailing
 * positional parameter of `platform.subscribe` itself, where an ordinary
 * `topics.map(platform.subscribe.bind(platform, ws))` supplies the array as a
 * verdict and quietly allows every topic.
 *
 * What holds now is narrower than "unreachable": this is an exported binding,
 * so anything that can import this module can call it. It is not a member of
 * the platform object, which is the surface an app hook, a wrapped bus, or a
 * `ws` holder is handed - none of those can reach the verdict channel. Only
 * handler/ws.js imports it, and only for the batch lane it exists to serve.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {{ allowSystemTopic?: boolean }} [options]
 * @param {unknown} [verdict] - from a batch gate already run for this frame
 * @returns {Promise<string | null>} null on success, else a denial reason
 */
export async function subscribeWithVerdict(ws, topic, options, verdict) {
	// Server-side callers are trusted past the always-illegal bytes: an app
	// using non-ASCII topic names must not be blocked at this layer.
	if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
	// The `__` namespace is the adapter's and its plugins' own. The guard is
	// HERE and not only on the wire path because the documented advice is to
	// route server-initiated subscribes through this method, so an app
	// implementing its own `join` verb otherwise passes a client-supplied
	// room straight into an internal channel - refused on the wire
	// microseconds earlier and granted here. Callers that legitimately need
	// one pass `{ allowSystemTopic: true }`.
	//
	// The guard stays even though it costs the extensions bus its
	// `degraded`/`recovered` events: that package subscribes its system channel
	// through this method without the option
	// (svelte-adapter-uws-extensions/src/redis/pubsub.js:634). Dropping the
	// guard for every app to unblock one privileged caller would turn the
	// documented-safe spelling into the bypass; the privileged caller passes the
	// option instead.
	const allowSystemTopic = !!(options && options.allowSystemTopic);
	if (!allowSystemTopic && isSystemTopic(topic)) return 'INVALID_TOPIC';
	let userData;
	try {
		userData = ws.getUserData();
	} catch {
		wsCounters.closedWsAborts++;
		return 'CLOSED';
	}
	const subs = userData[WS_SUBSCRIPTIONS];
	if (!subs) return 'CLOSED';
	if (subs.has(topic)) return null;
	// Count gates that are open but have not landed. Bun does not await the
	// message handler, so a client can pipeline subscribe frames faster than
	// they install: every one of them reads `subs.size` at its pre-await
	// value, passes, and lands. Measured at 500 installed against a cap of
	// 20 with a 40ms async hook, and the ceiling is the client's write rate,
	// not the cap. The in-flight total is what makes this a bound - and it
	// also bounds the concurrent app-hook invocations, which are their own
	// stampede against whatever the hook talks to.
	//
	// DISTINCT pending topics, not total in-flight gates: N concurrent
	// subscribes to ONE topic can only ever install one subscription, so
	// counting them N times refused legitimate subscribes with a
	// `RATE_LIMITED` that was not true (measured: 25 concurrent subscribes
	// to a single topic produced 5 false denials against a cap of 20).
	if (subs.size + pendingSubscribeTopics(userData) >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
		return 'RATE_LIMITED';
	}

	// Stamp the in-flight subscribe BEFORE the gate. An unsubscribe landing
	// while the hook is awaited bumps the epoch, and the landing below then
	// refuses to install a subscription the client has already left - which
	// would otherwise survive as a phantom the client believes it cancelled.
	// The SECOND limit: concurrent gates. The cap above counts distinct
	// pending topics, so N concurrent subscribes to ONE topic cost 1 against
	// it - correct for what can install, useless as a bound on app work:
	// without this check a socket repeating one topic opens a fresh gate call
	// per frame with nothing to stop it.
	if (!hasGateHeadroom(ws)) return 'RATE_LIMITED';

	const token = beginPendingSubscribe(userData, topic);
	let denial;
	try {
		denial = await withGateCounted(ws, () => runSubscribeGate(ws, topic, verdict));
	} catch (err) {
		settlePendingSubscribe(userData, topic, token);
		throw err;
	}
	// Recover gap-fill, only after the gate ALLOWED: a topic's replay history
	// must never be served ahead of a refusal. The barrier opens BEFORE the
	// resume await so a publish landing inside the hook's window is held, and
	// the pending entry stays in flight across the await so an unsubscribe
	// landing mid-resume still cancels the install below.
	let recoverCapture = null;
	let recoverCovered;
	const recover = options && options.recover;
	if (
		(denial === null || denial === undefined) &&
		recover &&
		// The same rule the wire lane applies, for a caller reaching this
		// through the platform API rather than through a subscribe frame: an
		// offset the server could not have issued is not a recover, and
		// subscribing plainly beats gap-filling from a fabricated cursor.
		isValidResumeSeq(recover.offset) &&
		typeof wsModule.resume === 'function'
	) {
		// The resume hook is app work a client frame triggers, so it runs
		// under the same per-connection concurrency bound as the gates. The
		// subscribe gate released its count above; without re-taking one here
		// a client pipelining recover subscribes to distinct topics would
		// open one concurrent backend read - and one live-frame buffer - per
		// frame it can write.
		if (!hasGateHeadroom(ws)) {
			settlePendingSubscribe(userData, topic, token);
			return 'RATE_LIMITED';
		}
		recoverCapture = beginResumeCapture([topic], ws);
		try {
			recoverCovered = await withGateCounted(ws, () =>
				wsModule.resume(ws, {
					sessionId: userData[WS_SESSION_ID],
					lastSeenSeqs: { [topic]: recover.offset },
					lastSeenEpochs: isValidResumeEpoch(recover.epoch) ? { [topic]: recover.epoch } : undefined,
					platform: userData[WS_PLATFORM] || platform
				})
			);
		} catch (err) {
			// The hook did not finish, so how much of the window it covered is
			// unknown - and the `subscribed` ack this lane ends with would imply a
			// gap-fill that did not happen, which the client cannot detect. Signal
			// the same truncation the overflow path sends: the client drops its
			// stored offset for this topic and cold-resyncs. Throttled, because a
			// hook that throws on client-shaped input throws on every frame and a
			// client can loop that frame.
			const { log: logIt, count: threwCount } = recoverThrewThrottle();
			if (logIt) {
				const suffix = threwCount > 1 ? ` (occurrence ${threwCount})` : '';
				console.error(`[ws] recover-on-subscribe hook threw${suffix}:`, err);
			}
			if (recoverCapture) markResumeTruncated(recoverCapture, topic);
		}
	}
	const stillWanted = settlePendingSubscribe(userData, topic, token);
	// Explicit nullish test, NOT truthiness. checkSubscribe classifies any
	// string the hook returns as a denial reason, including the empty
	// string - which a hook produces naturally from a lookup miss
	// (`DENY_REASONS[topic] ?? ''`). Under truthiness that denial fell
	// through to the install below and the client got a `subscribed` ack for
	// a topic the app meant to refuse.
	if (denial !== null && denial !== undefined) return denial;
	if (!stillWanted) {
		if (recoverCapture) discardResumeCapture(recoverCapture);
		return 'CANCELLED';
	}

	// Re-check after the await: a duplicate subscribe may have landed and
	// completed while this one was in the gate. The client is then already
	// live, so any frames held for it would be duplicates - discard them.
	if (subs.has(topic)) {
		if (recoverCapture) discardResumeCapture(recoverCapture);
		return null;
	}
	// And re-check the cap, for the same reason it counts in-flight above:
	// this gate entered when there was headroom, and any number of others
	// may have landed while it was awaiting. The pre-gate check bounds how
	// many hooks run at once; this one bounds what actually installs.
	if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
		if (recoverCapture) discardResumeCapture(recoverCapture);
		return 'RATE_LIMITED';
	}
	try {
		ws.subscribe(topic);
	} catch {
		if (recoverCapture) discardResumeCapture(recoverCapture);
		wsCounters.closedWsAborts++;
		return 'CLOSED';
	}
	subs.add(topic);
	wsCounters.totalSubscriptions++;
	// Live membership is installed: flush any frames held during the resume
	// window, in order, skipping what the resume already covered, before the
	// caller sends the ack.
	if (recoverCapture) flushResumeTopic(recoverCapture, topic, coveredSeqFor(recoverCovered, topic));
	// A topic already running shared binary fan-out cohorts its joiners at
	// subscribe time; the first shared publish cohorted whoever preceded it.
	const sharedCap = sharedTopics.get(topic);
	if (sharedCap !== undefined) joinSharedCohort(ws, userData, topic, sharedCap);
	return null;
}