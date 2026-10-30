import { deliveryAuthorization, publishAuthorized } from './delivery-authorization.js';
/** Realtime topic delivery, connection state, and request observability. */

import { isUint8Array } from 'node:util/types';
import { completeGameEnvelope, assertStampableSeq, wrapBatchEnvelope, createHlc } from '../utils/epoch.js';
import { registerGameIngress, assertGameLaneClusterSafe, GAME_FANOUT_CAP, GAME_FANOUT_SCHEMA_VERSION, encodeGameFanoutPayload } from './game-ingress.js';
import { completeEnvelope, completeSerializedEnvelope, envelopeData } from '../utils/envelope.js';
import { assert, fatal, readAssertionCounts } from '../utils/assertions.js';
import { isSystemTopic, isValidWireTopic, createTopicHelperCache } from '../utils/topic.js';
import { SEND_DROPPED, publishReached } from '../utils/send-result.js';
import { isValidResumeEpoch, isValidResumeSeq } from '../utils/resume-input.js';
import { createLogThrottle } from '../utils/log-throttle.js';
import { processMonotonicNow, randomBytes as randomOctets, randomFloat, randomU32, randomUuid, wallEpoch } from '../runtime.js';
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
import { getSharedWireId, sharedWireIdRefs } from '../utils/shared-wire-id.js';
import { registerWireCodec as _registerWireCodec } from './codec-registry.js';
import { cohortTopics, joinSharedCohort, leaveSharedCohort } from './cohort.js';
import {
	ensureWireId,
	ensureWireState,
	poisonWireState,
	wireStatePoisoned
} from './wire-state.js';
import {
	EGRESS_ADMITTED,
	admitPublishEgress,
	binaryFrameChargeBytes,
	chargeDirectEgress,
	chargePublishEgress,
	egressGate,
	envelopeWireBytes,
	excludedRecipient,
	resolvePublishTenant
} from './publish-egress.js';
import {
	beginResumeCapture,
	markResumeTruncated,
	coveredSeqFor,
	discardResumeCapture,
	flushResumeTopic
} from './resume-buffer.js';
import {
	MAX_SUBSCRIPTIONS_PER_CONNECTION,
	MAX_PENDING_SUBSCRIBES_PER_CONNECTION,
	WS_CAPS,
	WS_PLATFORM,
	WS_SESSION_ID,
	WS_SUBSCRIPTIONS,
	beginPendingSubscribe,
	isPendingSubscribeCancelled,
	subscribeAuth,
	capCounts,
	captureResumeFrame,
	notePublishedSeq,
	resumeBuffers,
	sharedTopics,
	getServer,
	heldSubscriptions,
	mintTopicEpoch,
	topicEpochValue,
	pressureListeners,
	pressureSnapshot,
	publishRateListeners,
	settlePendingSubscribe,
	stampSeq,
	stampSeqValue,
	tombstonePendingSubscribe,
	wsConnections,
	wsCounters,
	WS_COALESCED,
	MAX_COALESCED_KEYS_PER_CONNECTION
} from './ws-state.js';
import { flushCoalescedFor } from './coalesced.js';
import { allow_non_ascii_topics, authorize_wire_subscribe, authorize_wire_subscribe_strict, ws_compression_on, ws_options } from './config.js';
import { metricsRegistry, metricsSnapshot, projectMetrics } from './metrics.js';
import { resolveEntrySeq, resolveSendSeq } from '../utils/publish-seq.js';
import { isWarmupRequest } from './warmup-registry.js';
import {
	deniesUngrantedObserve,
	deniesWireSubscribeLanding,
	deniesWireSubscribePreHook,
	exceedsSubscriptionCap,
	isAuthorizationHook,
	recoverIsRevoked,
	isPluginOwnedTopic,
	wantsRecover
} from '../utils/subscribe-policy.js';
import {
	WS_ATTRIBUTION,
	WS_PUBLISH_GRANT,
	WS_COHORT_JOIN,
	WS_COHORT_LEAVE,
	WS_RELEASE_MEMBERSHIP,
	pendingSubscribeTotal,
	WS_REVOKED_UNSUBSCRIBE,
	addLogicalSubscription,
	heldLandingWouldAck,
	releaseDerivedSubscriptions,
	removeLogicalSubscription,
	membershipUnconfirmed,
	settleDeniedSubscribe,
	settleHeldSubscribe,
	unwindRevokedMembership
} from '../utils/ws-symbols.js';
import { dispatchServerUnsubscribeHook, dispatchUnsubscribeHook } from './unsubscribe-hook.js';
import { nativeTopic } from '../utils/recognized-string.js';

// Seed the live arming from the build. Raises after this come through
// `platform.authorizeWireSubscribe()`; nothing ever lowers it.
if (authorize_wire_subscribe) {
	subscribeAuth.enabled = true;
	if (authorize_wire_subscribe_strict) subscribeAuth.strict = true;
}

// The per-topic window stats the pressure sampler drains are recorded by
// chargePublishEgress in publish-egress.js - one charge point per logical
// publish, beside every `publishCountWindow` bump, so `publishRate` and
// `topPublishers` are computed over the same window from the same events. The
// `b` field stays the envelope's STRING length (UTF-16 code units, the same
// measure the sibling records); the egress BYTES ceiling has its own exact
// unit and its own field.

/** Throws from the app's subscribe hook, throttled with decay. */
const subscribeThrewThrottle = createLogThrottle(() => processMonotonicNow());

/** Throws from the app's resume hook on the recover lane, throttled with decay. */
const recoverThrewThrottle = createLogThrottle(() => processMonotonicNow());

/**
 * The JSON envelope a wire member falls back to for a caps-less, poisoned, or
 * codec-declined frame: byte-identical to what `send()` produces
 * (completeEnvelope over the same prefix and data), so a degraded connection
 * is indistinguishable from a caps-less one to the app.
 *
 * @param {any} ws - the socket facade
 * @param {string} topic
 * @param {string} event
 * @param {unknown} data
 * @param {boolean} compress
 * @param {number | null} [seq] - the caller's explicit gap-fill seq, carried
 *   here so a connection that fell back to JSON keys the same watermark a
 *   binary one would have read out of the frame's seq slot
 * @returns {0 | 1 | 2}
 */
function wireJsonSend(ws, topic, event, data, compress, seq) {
	const json = completeEnvelope(envelopePrefix(topic, event), data, seq);
	let result;
	try {
		result = deliveryAuthorization.send(ws, json, false, compress);
	} catch {
		wsCounters.closedWsAborts++;
		return SEND_DROPPED;
	}
	if (result !== SEND_DROPPED) bumpOut(ws, json);
	return result;
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
/**
 * Refuse a batch-level `seq` that is not a seq option at all, with the message
 * every other lane gives for the same value. publishWireBatch reads the option
 * once and stamps per entry, so without this the refusal would land on the
 * first counter-lane entry with earlier entries already recorded.
 *
 * @param {unknown} seqOption
 * @param {string} topic
 */
function assertSeqOption(seqOption, topic) {
	if (seqOption === undefined || seqOption === null) return;
	if (typeof seqOption === 'boolean' || typeof seqOption === 'number') return;
	stampSeqValue(seqOption, topic);
}

/**
 * Resolve an entry's override: a validated number is its authority, true
 * draws the counter, false and null omit the seq, and undefined inherits the
 * batch options. Invalid values are refused by entry position.
 *
 * @param {unknown} seq
 * @param {string} topic
 * @param {number} index
 * @returns {number | boolean | undefined}
 */
function entrySeq(seq, topic, index) {
	return resolveEntrySeq(seq, topic, index);
}

function throwBatchExplicitSeq(topic, seq) {
	throw new TypeError(
		`publishWireBatch was given a batch-level { seq: ${String(seq)} } (topic "${topic}"): one ` +
		'number cannot be the one-seq-per-entry this method publishes. Put the cluster seq on ' +
		'each entry instead - { data, seq }, each a positive integer number or bigint inside the ' +
		'wire\'s safe-integer range - or use { seq: true } for the ' +
		'local counter, which already increments per entry.'
	);
}

/**
 * Deliver one prebuilt envelope to one connection inside a fan-out walk:
 * closed sockets land in the closed lane. A broadcast charges no
 * per-connection traffic counter (see bumpOut). The walk continues either way.
 *
 * @param {any} ws - the socket facade
 * @param {string} envelope
 * @param {boolean} compress
 * @returns {boolean} whether the frame reached the wire
 */
function wireEnvelopeSend(ws, envelope, compress, envelopeCache = null) {
	try {
		if (deliveryAuthorization.send(ws, envelope, false, compress, null, envelopeCache) !== SEND_DROPPED || deliveryAuthorization.armed) return true;
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
export function normalizeSubscribeVerdict(verdict, topic, hookName) {
	if (verdict === false) return 'FORBIDDEN';
	if (typeof verdict === 'string') return verdict;
	if (!isReadableVerdict(verdict)) {
		warnUnreadableVerdict(topic, verdict, hookName);
		return 'INTERNAL_ERROR';
	}
	return null;
}

/** Throws from the app's subscribeBatch hook, throttled with decay. */
const batchThrewThrottle = createLogThrottle(() => processMonotonicNow());

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

/** Resolve every batch authorization before recovery and ordered landing. */
export async function runWireBatchGates(ws, topics, tokens, preDenied = []) {
	if (typeof wsModule.subscribeBatch === 'function') {
		const hookTopics = topics.filter((_topic, index) => !preDenied[index]);
		const verdicts = hookTopics.length ? await runBatchGate(ws, hookTopics) : new Map();
		return topics.map((topic, index) => preDenied[index] ? 'FORBIDDEN' : verdicts.get(topic));
	}
	let userData;
	try { userData = ws.getUserData(); }
	catch { return topics.map(() => 'CLOSED'); }
	return Promise.all(topics.map((topic, index) =>
		preDenied[index] ? 'FORBIDDEN' : isPendingSubscribeCancelled(userData, topic, tokens[index])
			? null : runSubscribeGate(ws, topic, undefined, { fromWire: true })));
}

/**
 * Whether the server-grant gate, not an app hook, decides a wire subscribe
 * right now.
 *
 * The wire batch lane asks this before it runs the app's `subscribeBatch`
 * hook. An ungranted topic is refused before application work; held topics
 * still reach the hook so a current application denial remains authoritative.
 *
 * Exported rather than re-derived in the demux: the arming and the
 * side-effect-only hook rule live here, and a second spelling of them is how
 * the two lanes would come to disagree.
 *
 * @returns {boolean}
 */
export function wireGrantGateDecides() {
	if (!subscribeAuth.enabled) return false;
	// Strict is conjunctive, so a hook does not take the decision away from the
	// grant; it only narrows what the grant already allowed.
	return !(hasUserSubscribeHook() && !subscribeAuth.strict);
}

/**
 * Whether the app exported a subscribe hook that DECIDES, which is what stands
 * the grant gate aside.
 *
 * One definition, read by every lane. The question is not `typeof
 * wsModule.subscribe === 'function'`: a plugin's hook observes the subscribe
 * without ever denying, and counting it would disarm the gate for an app that
 * merely imported the plugin. See {@link isAuthorizationHook}.
 *
 * @returns {boolean}
 */
export function hasUserSubscribeHook() {
	return isAuthorizationHook(wsModule.subscribe) || isAuthorizationHook(wsModule.subscribeBatch);
}

/**
 * Whether the OBSERVER lane's grant has gone since the gate let it in.
 *
 * The app's hook is awaited, and `platform.unsubscribe` is synchronous, so a
 * revocation can begin and finish inside that window. A grant that existed
 * before the await is not authority to reveal a topic's roster or history
 * after it was taken away - and the posture itself can tighten in the same
 * window, because `'strict'` latches at runtime and has to judge the decisions
 * already in flight. Both are why this reads the arming and the grant set
 * fresh rather than reusing what the pre-hook check saw.
 *
 * A legitimate revoke-then-re-grant is invisible here, as it should be: the
 * topic is back in the set, so the connection holds it again.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {{ requireGrant?: boolean } | undefined} lane
 * @param {boolean} hasUserHook - the reading taken before the hook ran
 * @returns {boolean}
 */
function observerGrantLost(ws, topic, lane, hasUserHook) {
	if (!lane || !lane.requireGrant || !subscribeAuth.enabled) return false;
	return deniesUngrantedObserve(
		true,
		hasUserHook && !subscribeAuth.strict,
		confirmedGrants(ws, topic),
		topic
	);
}

/** Read as a grant set by an observer lane whose grant is unconfirmed. */
const NO_GRANTS = new Set();

/**
 * The connection's grants as a grant read may use them for `topic`: its
 * subscriptions, unless the membership for `topic` is still waiting to be
 * judged, in which case none.
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {Set<string>}
 */
function confirmedGrants(ws, topic) {
	return grantUnconfirmed(ws, topic) ? NO_GRANTS : heldSubscriptions(ws);
}


/**
 * Lazily built LRU of scoped topic helpers, bound to this platform's publish.
 * Built on first use because it closes over `platform.publish`, which does not
 * exist until the object literal below is complete.
 * @type {((name: string) => any) | null}
 */
let topicHelperCache = null;

/**
 * Whether the membership a connection holds for `topic` is still waiting on
 * an attempt in flight. See membershipUnconfirmed in utils/ws-symbols.js.
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {boolean}
 */
function grantUnconfirmed(ws, topic) {
	try {
		return membershipUnconfirmed(ws.getUserData(), topic);
	} catch {
		return false;
	}
}

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
async function runSubscribeGate(ws, topic, verdict, lane) {
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
	// The server-grant gate, decided BEFORE the verdict short-circuit below so
	// the wire batch lane is judged by it too. A verdict is the app hook's
	// answer, and under `'strict'` the grant is a second authority no hook can
	// speak for - reading the verdict first would let the batch spelling of a
	// request succeed where the single spelling of it is refused.
	//
	// Read fresh, never snapshotted: `subscribeAuth.enabled` latches false ->
	// true at runtime, so a gate armed while a frame was parked in its hook
	// must judge that frame armed.
	// ONE reading of the app's hook set for this whole decision. The arming and
	// the strict latch are read fresh at every check below, because both only
	// ever tighten and a frame parked in a hook must be judged by the posture in
	// force when it lands. The hook set is different: it is a module binding
	// that can change in either direction, and a decision that starts under the
	// gate's authority and finishes under the app's - or the reverse - is one
	// request judged by two models.
	const userHook = hasUserSubscribeHook();
	if (subscribeAuth.enabled) {
		// Strict is conjunctive: the grant is required even when a hook exists,
		// so the hook stops standing the gate aside.
		const hookDecides = userHook && !subscribeAuth.strict;
		const grants = heldSubscriptions(ws);
		if (lane && lane.fromWire) {
			if (deniesWireSubscribePreHook({
				armed: true,
				hasUserHook: hookDecides,
				// A grant, which a membership installed inside an attempt's await
				// window is not until an attempt confirms it: read as one, a
				// client re-sending its subscribe would mint authority from an
				// install nobody authorized - a revoked attempt's own, say.
				held: grants.has(topic) && !grantUnconfirmed(ws, topic),
				topic
			})) {
				return 'FORBIDDEN';
			}
		} else if (lane && lane.requireGrant) {
			// The OBSERVER lane: "may this connection see what it already
			// holds?" It has no landing re-check behind it, so it carries no
			// carve-out - the gate here IS the whole gate.
			// A membership still waiting to be judged is not a grant here either.
			if (deniesUngrantedObserve(true, hookDecides, grantUnconfirmed(ws, topic) ? NO_GRANTS : grants, topic)) {
				return 'FORBIDDEN';
			}
		}
	}
	// A verdict the wire batch path already obtained from `subscribeBatch` for
	// THIS topic, so one `subscribe-batch` frame costs one hook call rather
	// than one per entry.
	if (verdict !== undefined) return normalizeSubscribeVerdict(verdict, topic, 'subscribeBatch');
	// `subscribeBatch` takes precedence over `subscribe` when both exist,
	// matching the family, and it is consulted HERE rather than only on the
	// wire batch path. Skipping it for single subscribes left
	// `platform.subscribe` - the spelling the docs call the safe one -
	// running no gate at all for an app that gates with the batch hook.
	if (typeof wsModule.subscribeBatch === 'function') {
		const verdicts = await runBatchGate(ws, [topic]);
		const decided = normalizeSubscribeVerdict(verdicts.get(topic), topic, 'subscribeBatch');
		if (decided === null && observerGrantLost(ws, topic, lane, userHook)) return 'FORBIDDEN';
		return decided;
	}
	const hook = wsModule.subscribe;
	if (typeof hook !== 'function') return null;
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
		const decided = normalizeSubscribeVerdict(
			await hook(ws, topic, { platform: hookPlatform }),
			topic,
			'subscribe'
		);
		if (decided === null && observerGrantLost(ws, topic, lane, userHook)) return 'FORBIDDEN';
		return decided;
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

/**
 * The platform members EVERY build has, WebSocket handler or not.
 *
 * A build with no realtime tier has no realtime platform for a route to reach
 * through, and these are documented as being on every instance - which is the
 * whole point of them: an app can serve a scrape or health route without
 * configuring a realtime tier at all. So a request on such a build is
 * prototype-linked to THIS object (see `requestPlatform`), and the realtime
 * platform takes the same members from it rather than declaring copies that
 * could drift apart.
 */
export const httpPlatform = {
	/**
	 * The metrics registry this instance writes to, for an app that wants to
	 * register instruments of its own: `platform.metrics.counter('orders_total',
	 * 'orders placed').inc({ tier })`. They land in the same document
	 * `metricsSnapshot()` renders, after the adapter's own.
	 *
	 */
	get metrics() {
		projectMetrics();
		return metricsRegistry;
	},

	/**
	 * This instance's metrics as a Prometheus text document. Serve it from an
	 * ordinary route:
	 *
	 *     export async function GET({ platform }) {
	 *       return new Response(await platform.metricsSnapshot(), {
	 *         headers: { 'content-type': 'text/plain; version=0.0.4' }
	 *       });
	 *     }
	 *
	 * The adapter's own counters are projected from the runtime's authoritative
	 * state when this is called, so nothing is emitted on a hot path and the two
	 * numbers cannot drift. The pressure-derived gauges are as fresh as the last
	 * sampler tick, which `pressure_sample_timestamp_seconds` states outright.
	 *
	 * @returns {Promise<string>}
	 */
	metricsSnapshot() {
		return metricsSnapshot();
	},

	/**
	 * Per-category count of framework invariant violations in this process,
	 * keyed by category string. Empty on a healthy server; a non-zero entry is
	 * a defect in the adapter or a plugin, and the
	 * `[lantean/diagnostic source=svelte-adapter-bunserve component=runtime.assertion event=invariant.violated ...]`
	 * line logged with each violation carries the context needed to reproduce
	 * it. The Map is live and owned by the runtime - read it, do not modify it.
	 *
	 * @returns {Map<string, number>}
	 */
	get assertions() {
		return readAssertionCounts();
	}
};

function admitBatchEgress(messages, sharedRecipients) {
	/** @type {Map<string, number>} */
	const perTopic = new Map();
	for (let i = 0; i < messages.length; i++) {
		perTopic.set(messages[i].topic, (perTopic.get(messages[i].topic) || 0) + 1);
	}
	/** @type {Map<string, { m: number, d: number, topic: string }> | null} */
	const perTenant = egressGate.tenantArmed ? new Map() : null;
	for (const [t, c] of perTopic) {
		const recipients = sharedRecipients === null ? (getServer().subscriberCount(nativeTopic(t))) : sharedRecipients;
		const deliveries = c * recipients;
		if (!egressGate.account.admitTopic(t, c, deliveries)) return false;
		if (perTenant === null) continue;
		const ten = resolvePublishTenant(t);
		if (ten === null) continue;
		const agg = perTenant.get(ten);
		if (agg === undefined) perTenant.set(ten, { m: c, d: deliveries, topic: t });
		else { agg.m += c; agg.d += deliveries; }
	}
	if (perTenant !== null) {
		for (const [ten, agg] of perTenant) {
			if (!egressGate.account.admitTenant(ten, agg.topic, agg.m, agg.d)) return false;
		}
	}
	return true;
}

function collapseByCoalesceKey(messages) {
	let hasCoalesce = false;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].coalesceKey !== undefined) { hasCoalesce = true; break; }
	}
	if (!hasCoalesce) return messages;
	/** @type {Map<string, number>} */
	const lastByKey = new Map();
	for (let i = 0; i < messages.length; i++) {
		const key = messages[i].coalesceKey;
		if (key !== undefined) lastByKey.set(key, i);
	}
	const out = [];
	for (let i = 0; i < messages.length; i++) {
		const key = messages[i].coalesceKey;
		if (key === undefined || lastByKey.get(key) === i) {
			out.push(messages[i]);
		}
	}
	return out;
}


registerGameIngress();

/** The per-process hybrid logical clock behind platform.hlc(), created on first read. */
let processHlc;

/**
 * Forget the clock, so the next read builds one from the then-current random
 * source. The sim drives this platform for many seeds in one process, and a
 * clock kept from an earlier seed would carry its node id and logical count
 * into the next.
 */
export function _resetHlcForSim() {
	processHlc = undefined;
}

export const platform = {
	authorizeDelivery(callback, options) { deliveryAuthorization.configure(callback, options); },
	[WS_RELEASE_MEMBERSHIP](ws, ud, topic) {
		try { ws.unsubscribe(topic); } catch { return null; }
		return removeLogicalSubscription(ud[WS_SUBSCRIPTIONS], topic);
	},
	// trackedSubscribe / trackedUnsubscribe join and leave this server's shared
	// cohorts through these slots, so a plugin's server-side membership on a
	// shared topic is served the cohort-split publish. Symbol-keyed: invisible
	// to Object.keys and JSON, unreachable from wire input. One server
	// per runtime instance, so the base platform is the server's own. See
	// WS_COHORT_JOIN in utils/ws-symbols.js.
	[WS_COHORT_JOIN](/** @type {any} */ ws, /** @type {any} */ ud, /** @type {string} */ topic) {
		const capability = sharedTopics.get(topic);
		if (capability !== undefined) joinSharedCohort(ws, ud, topic, capability);
	},
	[WS_COHORT_LEAVE](/** @type {any} */ ws, /** @type {any} */ ud, /** @type {string} */ topic) {
		if (sharedTopics.has(topic)) leaveSharedCohort(ws, ud, topic);
	},
	// A deny-unwind outside the runtime - the observer lane of
	// svelte-adapter-uws's copy of the subscription helpers - runs the app's
	// unsubscribe hook through this server-owned slot.
	// See WS_REVOKED_UNSUBSCRIBE in utils/ws-symbols.js.
	[WS_REVOKED_UNSUBSCRIBE](/** @type {any} */ ws, /** @type {string} */ topic, /** @type {any} */ ud) {
		dispatchServerUnsubscribeHook(ws, topic, true, ud);
	},

	/**
	 * Publish to every client subscribed to `topic`, wrapped in the
	 * `{ topic, event, data }` envelope the client store understands. A no-op
	 * when nobody is subscribed, so it is safe to call unconditionally.
	 *
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {{ seq?: boolean | number, jitterMs?: number, compress?: boolean }} [options]
	 * @returns {boolean} whether the frame reached at least one local
	 *   subscriber. A subscriber under backpressure counts: the frame is queued
	 *   for its socket rather than discarded, and reporting that as "nobody got
	 *   it" is what makes an app send it a second time.
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
		if (deliveryAuthorization.deciding) {
			assertStampableSeq(seqOpt);
			const captured = { seq: seqOpt, jitterMs: jitterOpt, compress: compressOpt };
			if (options?.[EGRESS_ADMITTED]) captured[EGRESS_ADMITTED] = true;
			deliveryAuthorization.deferOperation(() => platform.publish(topic, event, data, captured));
			return getServer().subscriberCount(nativeTopic(topic)) > 0;
		}
		const deliveryOperation = deliveryAuthorization.begin();
		try {
			// The egress decision comes BEFORE the stamp: a refused publish must
			// leave no trace - no counter draw, no mark, no frame - or the refusal
			// itself would poison the seq lane it protected. Recipients are read
			// at the instant of the publish, which is the charge law's quantity,
			// and getServer moving up here keeps every refusal ahead of every
			// record exactly as the comment below requires.
			const server = getServer();
			const recipients = server.subscriberCount(nativeTopic(topic));
			const egressTenant = resolvePublishTenant(topic);
			if (egressGate.armed && !options?.[EGRESS_ADMITTED] && !admitPublishEgress(topic, egressTenant, 1, recipients)) return false;
			const body = envelopePrefix(topic, event) + envelopeData(data);
			const seq = stampSeqValue(seqOpt, topic);
			// Authority is decided from the same single read the stamp consumed.
			const authoritative = typeof seqOpt === 'number';
			// A de-herd window is carried verbatim so each client rolls its own
			// delay. Rolling one server-side offset instead would defer every
			// subscriber of this frame by the SAME amount, which is the stampede
			// the option exists to prevent.
			const jitterMs = typeof jitterOpt === 'number' && jitterOpt > 0 ? jitterOpt : null;
			const envelope = completeSerializedEnvelope(body, seq, jitterMs);
			// A zero-length frame at a send site would broadcast garbage to every
			// subscriber - unrecoverable framing corruption. One length guard.
			fatal(envelope.length > 0, 'envelope.empty', null);
			// Everything that can still refuse this publish is resolved above this
			// line: the egress ceilings and getServer above, stampSeq on a seq the
			// wire cannot carry, completeEnvelope on a payload JSON cannot
			// represent. Only then is anything recorded.
			//
			// The MARK is the load-bearing half. It is the resume dedup floor, so
			// raising it for a frame that never went out makes the next gap-fill
			// window discard the republished frame as already-seen - a silent gap.
			// The count is the visible half: `publishCount` is documented as
			// "publishes since boot" and drifts upward on the app's own bug in the
			// one case where nothing was delivered to notice it by.
			if (seq !== null) notePublishedSeq(topic, seq, authoritative);
			wsCounters.publishCount++;
			wsCounters.publishCountWindow++;
			chargePublishEgress(
				topic, egressTenant, 1, recipients, envelope.length,
				envelopeWireBytes(envelope, recipients, egressGate.bytesArmed)
			);
			const compress = ws_compression_on && compressOpt !== false;
			// A connection still gap-filling this topic (resume cutover in
			// flight) is not yet subscribed to live, so hold the envelope it
			// would have received; it flushes once its membership installs. One
			// guarded size check on the path every publish takes.
			if (resumeBuffers.size > 0) {
				captureResumeFrame(topic, seq, envelope, compress, null, authoritative);
			}
			const result = deliveryAuthorization.armed
				? publishAuthorized(server, wsConnections, topic, envelope, false, compress)
				: server.publish(nativeTopic(topic), envelope, compress);
			const reached = publishReached(result);
			wsCounters.transportMetricHooks?.publishOutcome(reached);
			return reached;
		} finally {
			deliveryAuthorization.finish(deliveryOperation);
		}
	},

	/**
	 * Send to one connection, in the same envelope shape as publish().
	 *
	 * `options.seq` stamps an EXPLICIT sequence number onto the envelope - the
	 * gap-fill channel a resume hook replays history through, so the frames it
	 * sends carry the per-frame seqs the client keys its watermark off instead
	 * of an unmarked body. Number and bigint only, the same validation and
	 * safe-integer range the publish lanes' explicit authority takes; `false`,
	 * `null` and absent mean no seq - today's frame, byte-identical. `true`
	 * throws: this lane has no counter to draw, and gap-fill replays history
	 * that is ALREADY accounted, which is why an explicitly-seq'd send stays
	 * side-effect-free - no counter advance, no max-seen record, no resume
	 * capture. The send lanes touch no shared state, and that is load-bearing.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {{ compress?: boolean, seq?: number | bigint | false | null }} [options]
	 * @returns {0 | 1 | 2} 0 enqueued behind backpressure, 1 sent, 2 dropped
	 */
	send(ws, topic, event, data, options) {
		// The explicit gap-fill seq, resolved BEFORE the socket is touched so an
		// invalid spelling throws whatever the connection's state - the refusal
		// is about the call, not the connection.
		const seq = resolveSendSeq(options != null ? options.seq : undefined);
		const payload = completeEnvelope(envelopePrefix(topic, event), data, seq);
		assert(payload.length > 0, 'envelope.send-empty', null);
		const compress = ws_compression_on && (!options || options.compress !== false);
		// Callers routinely reach here after an await that outlasted the
		// socket. The facade throws; report DROPPED so callers can pattern-match
		// a single failure value without having to distinguish closed from
		// backpressure-dropped, and count it in the closed lane so the two
		// remain separable in telemetry.
		try {
			const result = deliveryAuthorization.armed
				? deliveryAuthorization.send(ws, payload, false, compress)
				: ws.send(payload, false, compress);
			// Queued and written frames count; dropped or throwing sends do not.
			if (result !== SEND_DROPPED) bumpOut(ws, payload);
			return result;
		} catch {
			wsCounters.closedWsAborts++;
			return SEND_DROPPED;
		}
	},

	/**
	 * Send to one connection with coalesce-by-key semantics: each (ws, key)
	 * holds at most one pending message, and a newer one for the same key
	 * replaces it in place before it reaches the wire - latest value wins,
	 * first insertion order kept. For latest-value streams where the values in
	 * between are noise (cursor positions, presence, price ticks); use `send`
	 * or `publish` for delivery of every value.
	 *
	 * Serialization waits for the flush, so a key overwritten a thousand times
	 * before one drain pays for one JSON.stringify. The flush runs now and
	 * again on every drain; backpressure stops it until the next one. A value
	 * JSON cannot carry throws from this call when it flushes at once, as
	 * `send` would; one flushed later from a drain is dropped and reported. A
	 * topic or event name the envelope cannot carry always throws here, before
	 * anything is queued.
	 *
	 * @param {any} ws
	 * @param {{ key: unknown, topic: string, event: string, data?: unknown }} message
	 */
	sendCoalesced(ws, { key, topic, event, data }) {
		let userData;
		try {
			userData = ws.getUserData();
		} catch {
			wsCounters.closedWsAborts++;
			return;
		}
		// Validate before touching the queue, after the closed-socket guard.
		const prefix = envelopePrefix(topic, event);
		let pending = userData[WS_COALESCED];
		if (!pending) {
			pending = new Map();
			userData[WS_COALESCED] = pending;
		}
		assert(pending instanceof Map, 'coalesce.userdata-pending-type', null);
		// At the cap with a new key: the oldest pending value goes. Latest
		// value wins by contract, so it is the most stale one to lose.
		if (pending.size >= MAX_COALESCED_KEYS_PER_CONNECTION && !pending.has(key)) {
			const oldest = pending.keys().next().value;
			pending.delete(oldest);
		}
		const entry = { topic, event, data, prefix };
		pending.set(key, entry);
		flushCoalescedFor(ws, entry);
	},

	/**
	 * Send to every connection whose userData the filter accepts. Returns the
	 * number of non-throwing sends, including frames the socket drops.
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
		// The filter pass runs WHOLE before the first frame: the egress
		// decision needs the target count, and the charge law's decision point
		// is before delivery, not during it. The filter was always documented
		// synchronous, so nothing observable moves between the two passes but
		// the sends themselves.
		const targets = [];
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
			targets.push(ws);
		}
		if (targets.length === 0) return 0;
		const egressTenant = resolvePublishTenant(topic);
		if (
			egressGate.armed &&
			!admitPublishEgress(topic, egressTenant, 1, targets.length)
		) {
			return 0;
		}
		const envelopeCache = deliveryAuthorization.cache();
		const deliveryOperation = deliveryAuthorization.begin();
		try {
			let count = 0;
			for (const ws of targets) {
				let result;
				try {
					result = deliveryAuthorization.send(ws, envelope, false, compress, null, envelopeCache);
				} catch {
					wsCounters.closedWsAborts++;
					continue;
				}
				if (result !== SEND_DROPPED) bumpOut(ws, envelope);
				count++;
			}
			// Charge every non-throwing send, including a dropped status, once.
			// Direct fan-out does not feed the publish-family runaway stats.
			if (count > 0) {
				chargeDirectEgress(
					topic, egressTenant, count,
					envelopeWireBytes(envelope, count, egressGate.bytesArmed)
				);
			}
			return count;
		} finally {
			deliveryAuthorization.finish(deliveryOperation);
		}
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
		if (deliveryAuthorization.deciding) {
			assertStampableSeq(seqOpt);
			const captured = { seq: seqOpt, compress: compressOpt, excludeWs: excludeOpt };
			if (options?.[EGRESS_ADMITTED]) captured[EGRESS_ADMITTED] = true;
			deliveryAuthorization.deferOperation(() => platform.publishWire(topic, event, data, wire, captured));
			return getServer().subscriberCount(nativeTopic(topic)) > 0;
		}
		const deliveryOperation = deliveryAuthorization.begin();
		try {
			// The egress decision first, as in publish() and for the same reason:
			// a refused publish leaves no trace. An exclusion discounts a
			// recipient only when the excluded socket actually holds the topic.
			// EGRESS_ADMITTED marks a call whose batch already took this decision
			// for all its entries at once; it still charges below.
			const server = getServer();
			const recipients =
				server.subscriberCount(nativeTopic(topic)) - (excludedRecipient(excludeOpt, topic) ? 1 : 0);
			const egressTenant = resolvePublishTenant(topic);
			if (
				egressGate.armed &&
				!(options != null && options[EGRESS_ADMITTED]) &&
				!admitPublishEgress(topic, egressTenant, 1, recipients)
			) {
				return false;
			}
			const seq = stampSeqValue(seqOpt, topic);
			// Authority is decided from the same single read the stamp consumed.
			const authoritative = typeof seqOpt === 'number';
			const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq);
			fatal(envelope.length > 0, 'envelope.empty', null);
			// Past every refusal point before the mark or the count moves, as in
			// publish() above and for the same reasons.
			if (seq !== null) notePublishedSeq(topic, seq, authoritative);
			wsCounters.publishCount++;
			wsCounters.publishCountWindow++;
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
				// The one egress charge for this logical publish: every recipient
				// gets the JSON envelope here.
				chargePublishEgress(
					topic, egressTenant, 1, recipients, envelope.length,
					envelopeWireBytes(envelope, recipients, egressGate.bytesArmed)
				);
				const result = deliveryAuthorization.armed
				? publishAuthorized(server, wsConnections, topic, envelope, false, compress)
				: server.publish(nativeTopic(topic), envelope, compress);
				return publishReached(result);
			}

			const seqOnWire = seq == null ? 0 : seq;
			const envelopeCache = deliveryAuthorization.cache();

			// Stateful codec (per-connection dictionary / delta baselines): the
			// encoded payload depends on the recipient's state, so
			// encode-once-send-many no longer holds for the binary recipients -
			// each capable connection is encoded against its own state.
			// Connections whose onAttach returned null (an older client that
			// negotiated the stateless schema) share one encode at
			// `wire.schemaVersion`, memoized by topic-id, so a mixed room keeps
			// the single-encode fan-out for those clients.
			if (wire.state) {
				// The one egress charge for this logical publish. A stateful
				// codec's frames are recipient-specific (each connection's
				// dictionary shapes its own bytes), so the JSON envelope is the
				// charged per-recipient size for this lane - the stable serialized
				// form every degraded recipient actually receives.
				chargePublishEgress(
					topic, egressTenant, 1, recipients, envelope.length,
					envelopeWireBytes(envelope, recipients, egressGate.bytesArmed)
				);
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
						delivered = wireEnvelopeSend(ws, envelope, compress, envelopeCache) || delivered;
						continue;
					}
					const state = ensureWireState(ws, ud, wire);
					if (state == null) {
						// A poisoned capability is served exactly like a caps-less
						// connection: the shared JSON envelope, never binary.
						// Checked only on this null-state branch so the
						// per-connection hot path pays nothing for it.
						if (wireStatePoisoned(ud, wire.capability)) {
							delivered = wireEnvelopeSend(ws, envelope, compress, envelopeCache) || delivered;
							continue;
						}
						// Shared encode-once at the codec's baseline schema version.
						if (!sharedEncoded) {
							sharedPayload = wire.encode(event, data, null);
							if (sharedPayload != null && !isUint8Array(sharedPayload)) {
								throw new TypeError('wire.encode must return Uint8Array or null');
							}
							sharedEncoded = true;
						}
						if (sharedPayload == null) {
							delivered = wireEnvelopeSend(ws, envelope, compress, envelopeCache) || delivered;
							continue;
						}
						const id = ensureWireId(ws, ud, topic);
						if (id === -1) {
							// Dropped wire-id announce: the client can never resolve
							// this topic's numeric id, so binary for this capability
							// is permanently undecodable here. JSON for this frame,
							// and poison.
							poisonWireState(ws, ud, wire.capability);
							delivered = wireEnvelopeSend(ws, envelope, compress, envelopeCache) || delivered;
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
							if (deliveryAuthorization.send(ws, frame, true, compress, topic) !== SEND_DROPPED || deliveryAuthorization.armed) delivered = true;
						} catch {
							wsCounters.closedWsAborts++;
						}
					} else {
						// Per-connection encode against this connection's state,
						// stamped with the schema version that state negotiated.
						const payload = wire.encode(event, data, state);
						if (payload != null && !isUint8Array(payload)) {
							throw new TypeError('wire.encode must return Uint8Array or null');
						}
						if (payload == null) {
							delivered = wireEnvelopeSend(ws, envelope, compress, envelopeCache) || delivered;
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
							delivered = wireEnvelopeSend(ws, envelope, compress, envelopeCache) || delivered;
							continue;
						}
						const frame = buildBinaryFrame(sv, id, seqOnWire, payload);
						let result;
						try {
							result = deliveryAuthorization.send(ws, frame, true, compress, topic);
						} catch {
							wsCounters.closedWsAborts++;
							continue;
						}
						if (result !== SEND_DROPPED || deliveryAuthorization.armed) delivered = true;
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
			const payload = wire.encode(event, data);
			if (payload != null && !isUint8Array(payload)) {
				throw new TypeError('wire.encode must return Uint8Array or null');
			}
			if (payload == null) {
				// A declined frame serves everyone the envelope, whichever
				// sub-branch delivers it.
				chargePublishEgress(
					topic, egressTenant, 1, recipients, envelope.length,
					envelopeWireBytes(envelope, recipients, egressGate.bytesArmed)
				);
				if (excludeWs === null) {
					const result = deliveryAuthorization.armed
				? publishAuthorized(server, wsConnections, topic, envelope, false, compress)
				: server.publish(nativeTopic(topic), envelope, compress);
					return publishReached(result);
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
						if (deliveryAuthorization.send(ws, envelope, false, compress, null, envelopeCache) !== SEND_DROPPED || deliveryAuthorization.armed) delivered = true;
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
				// The one egress charge for this logical publish, split by cohort:
				// the binary cohort is charged its 0x03 frame, everyone else the
				// envelope. The binary-cohort size is the shared wire-id refcount
				// (one reference per cohorted socket), so the split is exact
				// without a walk or a native read.
				// The binary cohort exists only if a capable client joined it (its
				// announce succeeded); otherwise this shared topic currently has
				// only JSON subscribers and skips the binary fan-out entirely.
				// Resolved BEFORE the charge, because the id is part of what the
				// frame costs: it is a varint, so the 128th shared topic onward
				// spends a second byte on every frame it sends.
				const id = getSharedWireId(topic);
				{
					const binCount = Math.min(sharedWireIdRefs(topic), recipients);
					chargePublishEgress(
						topic, egressTenant, 1, recipients, envelope.length,
						binaryFrameChargeBytes(payload.length, seqOnWire, id ?? 0) * binCount +
							envelopeWireBytes(envelope, recipients - binCount, egressGate.bytesArmed)
					);
				}
				let binBytes = 0;
				if (id !== undefined) {
					binBytes = publishAuthorized(server, wsConnections, bin, buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload), true, compress, topic);
				}
				const jsonBytes = publishAuthorized(server, wsConnections, json, envelope, false, compress);
				// Either cohort reaching anyone is a delivery. `binBytes` stays 0
				// when no binary cohort exists, which is the same "nobody" the
				// runtime reports for an empty topic.
				return publishReached(binBytes) || publishReached(jsonBytes);
			}

			// The one egress charge for this logical publish. Once a live
			// connection advertises this codec's capability, the walk's encoded
			// form is the binary frame and the charge reflects it for every
			// recipient (a mixed room's JSON-degraded members ride at the same
			// charged size - the documented approximation that keeps the charge
			// O(1)); with no capable connection the walk exists only for the
			// exclusion and every recipient gets the envelope.
			chargePublishEgress(
				topic, egressTenant, 1, recipients, envelope.length,
				capCounts.has(wire.capability)
					// Topic ids are PER CONNECTION here, so there is no one id this
					// O(1) charge could read - the charge is taken before the walk
					// that would learn them. Charged at the one-byte id every
					// connection's first 127 topics use, which is the same
					// approximation the mixed-room case above already takes.
					? binaryFrameChargeBytes(payload.length, seqOnWire, 1) * recipients
					: envelopeWireBytes(envelope, recipients, egressGate.bytesArmed)
			);
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
						delivered = wireEnvelopeSend(ws, envelope, compress, envelopeCache) || delivered;
						continue;
					}
					let frame = frameById.get(id);
					if (!frame) {
						frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload);
						frameById.set(id, frame);
					}
					try {
						if (deliveryAuthorization.send(ws, frame, true, compress, topic) !== SEND_DROPPED || deliveryAuthorization.armed) delivered = true;
					} catch {
						wsCounters.closedWsAborts++;
					}
				} else {
					delivered = wireEnvelopeSend(ws, envelope, compress, envelopeCache) || delivered;
				}
			}
			return delivered;
		} finally {
			deliveryAuthorization.finish(deliveryOperation);
		}
	},

	/**
	 * Multi-entry fan-out via a stateful plugin codec: one tick's same-event
	 * updates delivered as ONE binary frame per capable connection (the
	 * codec's `<event>-batch` form) and as the per-entry JSON envelopes -
	 * byte-identical to N publishWire calls - for everyone else. Each entry
	 * may carry its own `excludeWs` (per-entry author suppression); an entry
	 * is withheld from its excluded socket on every delivery path.
	 *
	 * A call-level `{ excludeWs }` is the DEFAULT exclusion for every entry -
	 * the author of a tick's updates is one socket for the whole batch, which
	 * is the exclusion's whole use - and it applies on this lane and on the
	 * stateless reroute alike. An entry carrying its own overrides it for that
	 * entry; a `null` entry exclusion is ABSENT and inherits. Unlike a
	 * call-level seq, one exclusion IS one-per-entry: it says the same thing
	 * about every entry, so it is honoured rather than refused.
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
	 * The counter is unaffected, whether it was asked for with `{ seq: true }`
	 * or simply left as the default: it increments per entry, which is already
	 * one seq per entry.
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
	 * @param {{ seq?: boolean, compress?: boolean, excludeWs?: any }} [options] -
	 *   the counter is the default, here as everywhere: absent options stamp one
	 *   per entry, `false` stamps none, and a number is the refused batch-level
	 *   form. `excludeWs` withholds every entry from that socket unless the
	 *   entry names its own.
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
		// Both spellings of the explicit authority, because they are one value:
		// a bigint batch-level seq is the same "one number for N entries" the
		// number spelling cannot satisfy.
		if (options && (typeof options.seq === 'number' || typeof options.seq === 'bigint')) {
			throwBatchExplicitSeq(topic, options.seq);
		}
		// And the same fail-fast for a batch-level seq that is not a seq option
		// at all. Refused here rather than on the first entry that reaches the
		// counter lane, so a batch is whole or nothing in this direction too.
		if (options) assertSeqOption(options.seq, topic);
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
			// The call-level exclusion, read once with the other options above.
			// It is the DEFAULT for every entry - the author of a tick's updates
			// is one socket for the whole batch, which is the exclusion's whole
			// use - and an entry carrying its own overrides it for that entry.
			//
			// A null entry exclusion is ABSENT, so it INHERITS. Reading it as
			// "this entry opts back in" would make `{ data, excludeWs: null }`
			// mean something here that it means nowhere else in the family, and
			// an app relying on it could not move to the adapter this one
			// mirrors.
			const optionExclude = options ? options.excludeWs : undefined;
			for (let i = 0; i < n; i++) {
				const e = entries[i];
				// ONE read of the accessor. Two reads let a getter answer
				// "defined" to the test and something else to the value, which
				// is the whole reason this pre-pass exists.
				const own = e.excludeWs;
				const ownExclude = own !== undefined && own !== null;
				records[i] = {
					data: e.data,
					excludeWs: ownExclude ? own : optionExclude,
					ownExclude,
					// The entry lane speaks the same table as the options lane:
					// number and bigint are the explicit authority, `true` the
					// counter, `false` and `null` no-seq - each an OVERRIDE of
					// the batch options for this entry - `undefined` inherits,
					// and anything else refuses the whole batch here, before the
					// first entry fans out.
					seq: entrySeq(e.seq, topic, i)
				};
			}
			entries = records;
		}
		if (deliveryAuthorization.deciding) {
			deliveryAuthorization.deferOperation(() => platform.publishWireBatch(topic, event, entries, wire, options));
			return getServer().subscriberCount(nativeTopic(topic)) > 0;
		}
		const deliveryOperation = deliveryAuthorization.begin();
		try {
			// The egress decision, taken ONCE for the whole batch: N logical
			// publishes, admitted whole or refused whole. Nothing has been stamped
			// yet - the pre-pass above only validated - so a refused batch leaves
			// no trace beyond the per-entry explicit-seq validation it already
			// paid. Per-entry recipients are read here at the instant of the
			// decision, each entry's exclusion discounted only when the excluded
			// socket actually holds the topic.
			const server = getServer();
			const baseRecipients = server.subscriberCount(nativeTopic(topic));
			const entryRecipients = new Array(n);
			let egressDeliveries = 0;
			for (let i = 0; i < n; i++) {
				const r = baseRecipients - (excludedRecipient(entries[i].excludeWs, topic) ? 1 : 0);
				entryRecipients[i] = r;
				egressDeliveries += r;
			}
			const egressTenant = resolvePublishTenant(topic);
			if (egressGate.armed) {
				if (!admitPublishEgress(topic, egressTenant, n, egressDeliveries)) return false;
				// The stateless reroute below hands each entry to publishWire, and
				// each of those calls must charge its own weight without deciding
				// again - the decision above covered them all. The symbol survives
				// the per-entry option spreads.
				options = { ...(options || {}), [EGRESS_ADMITTED]: true };
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
					// ownExclude, not the effective value: an entry that inherited
					// the call-level exclusion already gets it from `options`, so the
					// per-entry object is allocated only for a real override.
					if (entry.ownExclude || entry.seq !== undefined) {
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
				// Every form but `undefined` is an OVERRIDE of the batch options for
				// this entry: a number is its explicit authority, `true` draws the
				// counter for it alone, `false` publishes it seq-less. The booleans
				// go back through the shared stamp so the entry lane and the options
				// lane cannot answer them differently.
				const own = entry.seq;
				const seq = own === undefined
					? stampSeq(options, topic)
					: (typeof own === 'number' ? own : stampSeqValue(own, topic));
				// Only a NUMBER is authoritative: a counter draw is a different
				// sequence space and no-seq has no value to be authoritative about.
				// The pre-pass accepted it or threw, so there is no
				// refused-but-published case left to tell apart, and no way for a
				// toJSON run by an earlier iteration's completeEnvelope to swap in a
				// value the pre-pass never saw.
				authoritative[i] = typeof own === 'number';
				seqs[i] = seq;
				envs[i] = completeEnvelope(envelopePrefix(topic, event), entry.data, seq);
				fatal(envs[i].length > 0, 'envelope.empty', null);
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
			for (let i = 0; i < n; i++) {
				// Never authoritative on the else-branch: a numeric batch-level
				// seq threw above, so the captured options can only say counter
				// (true) or nothing - and a counter seq only keeps the topic
				// recent, it never writes the authoritative mark.
				if (authoritative[i]) notePublishedSeq(topic, seqs[i], true);
				else if (seqs[i] !== null) notePublishedSeq(topic, seqs[i], false);
			}
			wsCounters.publishCount += n;
			wsCounters.publishCountWindow += n;
			// One topic, one charge: the whole admitted batch, its envelope sizes
			// summed once. The wire bytes take the stateful lane's rule - the
			// envelope is the charged per-recipient size, each entry weighted by
			// its own recipients as read at the decision.
			{
				let batchEnvelopeSize = 0;
				let batchWireBytes = 0;
				for (let i = 0; i < n; i++) {
					batchEnvelopeSize += envs[i].length;
					batchWireBytes += envelopeWireBytes(envs[i], entryRecipients[i], egressGate.bytesArmed);
				}
				chargePublishEgress(topic, egressTenant, n, egressDeliveries, batchEnvelopeSize, batchWireBytes);
			}
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

			const jsonCaches = deliveryAuthorization.armed ? envs.map(() => deliveryAuthorization.cache()) : null;
			const sendJson = (ws, list, caches) => {
				for (let i = 0; i < list.length; i++) {
					try {
						if (deliveryAuthorization.send(ws, list[i], false, compress, null, caches === null ? null : caches[i]) !== SEND_DROPPED || deliveryAuthorization.armed) delivered = true;
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
					const r = publishAuthorized(server, wsConnections, topic, envs[i], false, compress);
					if (publishReached(r)) anyBytes = true;
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
				let cacheList = jsonCaches;
				let seqList = seqs;
				let lastSeq = seqs[n - 1];
				if (anyExclude) {
					list = [];
					envList = [];
					if (jsonCaches !== null) cacheList = [];
					seqList = [];
					for (let i = 0; i < n; i++) {
						if (entries[i].excludeWs === ws) continue;
						list.push(entries[i]);
						envList.push(envs[i]);
						if (cacheList !== null) cacheList.push(jsonCaches[i]);
						seqList.push(seqs[i]);
						lastSeq = seqs[i];
					}
					if (list.length === 0) continue;
				}
				const caps = ud[WS_CAPS];
				if (!caps || !caps.has(wire.capability)) {
					sendJson(ws, envList, cacheList);
					continue;
				}
				// A poisoned capability reads a null state and is served JSON,
				// exactly like publishWire's null-state branch.
				const state = ensureWireState(ws, ud, wire);
				if (state == null) {
					sendJson(ws, envList, cacheList);
					continue;
				}
				const updates = new Array(list.length);
				for (let i = 0; i < list.length; i++) updates[i] = list[i].data;
				const sv =
					typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
				const payload = wire.encode(event + '-batch', { updates }, state);
				if (payload != null && !isUint8Array(payload)) {
					throw new TypeError('wire.encode must return Uint8Array or null');
				}
				if (payload == null) {
					// The codec declined the batch (older codec, unrepresentable
					// entry): per-entry encodes with per-entry JSON fallback - the
					// N publishWire bodies this call replaces.
					for (let i = 0; i < list.length; i++) {
						const p = wire.encode(event, list[i].data, state);
						if (p != null && !isUint8Array(p)) {
							throw new TypeError('wire.encode must return Uint8Array or null');
						}
						if (p == null) {
							try {
								if (deliveryAuthorization.send(ws, envList[i], false, compress, null, cacheList === null ? null : cacheList[i]) !== SEND_DROPPED || deliveryAuthorization.armed) delivered = true;
							} catch {
								wsCounters.closedWsAborts++;
								break;
							}
							continue;
						}
						const id = ensureWireId(ws, ud, topic);
						if (id === -1) {
							poisonWireState(ws, ud, wire.capability);
							sendJson(ws, envList.slice(i), cacheList === null ? null : cacheList.slice(i));
							break;
						}
						// 0 is the wire's "no seq" (see sendWire); the null lives only
						// in seqs, where the resume capture can still read it.
						const frame = buildBinaryFrame(sv, id, seqList[i] ?? 0, p);
						let result;
						try {
							result = deliveryAuthorization.send(ws, frame, true, compress, topic);
						} catch {
							wsCounters.closedWsAborts++;
							break;
						}
						if (result !== SEND_DROPPED || deliveryAuthorization.armed) delivered = true;
						if (result === SEND_DROPPED) {
							poisonWireState(ws, ud, wire.capability);
							sendJson(ws, envList.slice(i + 1), cacheList === null ? null : cacheList.slice(i + 1));
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
					sendJson(ws, envList, cacheList);
					continue;
				}
				const frame = buildBinaryFrame(sv, id, lastSeq ?? 0, payload);
				let result;
				try {
					result = deliveryAuthorization.send(ws, frame, true, compress, topic);
				} catch {
					wsCounters.closedWsAborts++;
					continue;
				}
				if (result !== SEND_DROPPED || deliveryAuthorization.armed) delivered = true;
				// The encode mutated the dictionaries for a frame the client
				// never saw - JSON until reconnect.
				if (result === SEND_DROPPED) poisonWireState(ws, ud, wire.capability);
			}
			return delivered;
		} finally {
			deliveryAuthorization.finish(deliveryOperation);
		}
	},

	/**
	 * Single-target send via a plugin-declared binary wire codec. The target
	 * receives a `0x03` frame when it advertised `wire.capability` and the
	 * codec can encode this frame; otherwise it receives the JSON envelope
	 * `send()` would have sent. `options.seq` takes the same explicit gap-fill
	 * authority `send()` takes, and rides the binary frame's seq slot and the
	 * JSON fallback identically; absent, the frame carries the 0 sentinel.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @param {string} event
	 * @param {any} data
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any }} wire
	 * @param {{ compress?: boolean, seq?: number | bigint | false | null }} [options] - `{ compress: true }` opts this
	 *   low-frequency binary frame into permessage-deflate when a compressor is
	 *   configured (binary frames are uncompressed by default).
	 * @returns {0 | 1 | 2} the send tri-state, or 2 on a closed socket
	 */
	sendWire(ws, topic, event, data, wire, options) {
		// Resolved before the freed-handle guard, for the reason `send` resolves
		// it first. Rides the binary frame's seq slot and the JSON fallback
		// envelope identically, so the client keys one watermark whichever form
		// this connection negotiates.
		const seq = resolveSendSeq(options != null ? options.seq : undefined);
		if (deliveryAuthorization.deciding) {
			const captured = { seq: seq === null ? false : seq, compress: options?.compress };
			deliveryAuthorization.deferOperation(() => platform.sendWire(ws, topic, event, data, wire, captured));
			return 0;
		}
		const deliveryOperation = deliveryAuthorization.begin();
		try {
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
					payload = wire.encode(event, data, state);
					if (state != null && typeof state.schemaVersion === 'number') {
						schemaVersion = state.schemaVersion;
					}
				} else {
					payload = wire.encode(event, data);
				}
			}
			if (payload == null) {
				return wireJsonSend(ws, topic, event, data, compress, seq);
			}
			if (!isUint8Array(payload)) throw new TypeError('wire.encode must return Uint8Array or null');
			const id = ensureWireId(ws, ud, topic);
			if (id === -1) {
				// Dropped wire-id announce: the client can never resolve this
				// topic's numeric id, so binary for this capability is permanently
				// undecodable here. JSON for this frame, and poison so every later
				// frame takes the JSON path too.
				poisonWireState(ws, ud, wire.capability);
				return wireJsonSend(ws, topic, event, data, compress, seq);
			}
			// 0 is the frame's "no seq" sentinel, which is what an unseq'd send means.
			const frame = buildBinaryFrame(schemaVersion, id, seq ?? 0, payload);
			let result;
			try {
				result = deliveryAuthorization.send(ws, frame, true, compress, topic);
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
		} finally {
			deliveryAuthorization.finish(deliveryOperation);
		}
	},

	/**
	 * Multi-entry single-target send via a stateful plugin codec: one tick's
	 * same-event updates for ONE subscriber as a single binary frame (the
	 * codec's `<event>-batch` form), or the per-entry JSON envelopes when the
	 * connection has no capability / is poisoned. The per-subscriber twin of
	 * publishWireBatch, for culled per-viewer delivery walks. No seq is stamped -
	 * one value cannot be the one-per-entry a batch carries, which is the same
	 * reason publishWireBatch refuses a batch-level one - so the binary frame
	 * carries the 0 sentinel and the JSON entries omit the field.
	 *
	 * Degradation: a declined batch falls back to per-entry encodes, a
	 * per-entry null to that entry's JSON envelope, and a dropped stateful
	 * frame poisons the capability to JSON until reconnect. A stateless codec
	 * sends per-entry JSON envelopes. Codec errors propagate to the caller.
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
		if (deliveryAuthorization.deciding) {
			const captured = entries.map((entry) => ({ data: entry.data }));
			const capturedOptions = { compress: options?.compress };
			deliveryAuthorization.deferOperation(() => platform.sendWireBatch(ws, topic, event, captured, wire, capturedOptions));
			return 0;
		}
		const deliveryOperation = deliveryAuthorization.begin();
		try {
			let ud;
			try {
				ud = ws.getUserData();
			} catch {
				wsCounters.closedWsAborts++;
				return SEND_DROPPED;
			}
			const caps = ud[WS_CAPS];
			const compress = ws_compression_on && !!(options && options.compress === true);
			const count = entries.length;
			// `prior` is the status of the send this continues from, so a call whose
			// last frame was dropped, with nothing left to send, still reports it.
			const sendJsonFrom = (i, source, prior = 1) => {
				let result = prior;
				for (; i < count; i++) {
					const data = source === null ? entries[i].data : source[i];
					result = wireJsonSend(ws, topic, event, data, compress);
					if (result === SEND_DROPPED && ws._closed) return SEND_DROPPED;
				}
				return result;
			};
			if (!caps || !caps.has(wire.capability) || wireStatePoisoned(ud, wire.capability) || !wire.state) {
				return sendJsonFrom(0, null);
			}
			const state = ensureWireState(ws, ud, wire);
			if (state == null) return sendJsonFrom(0, null);
			// Pin each payload once before calling application code. Every fallback
			// uses the same references the batch encode saw, even if that encode
			// replaces entries or their data accessors return another value later.
			const datas = new Array(count);
			for (let i = 0; i < count; i++) datas[i] = entries[i].data;
			const schemaVersion =
				typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
			const payload = wire.encode(event + '-batch', { updates: datas }, state);
			if (payload != null && !isUint8Array(payload)) {
				throw new TypeError('sendWireBatch: wire.encode must return Uint8Array or null');
			}
			if (payload == null) {
				// The codec declined the batch (older codec, unrepresentable
				// entry): the N sendWire bodies this call replaces.
				let result = 1;
				for (let i = 0; i < count; i++) {
					const p = wire.encode(event, datas[i], state);
					if (p != null && !isUint8Array(p)) {
						throw new TypeError('sendWireBatch: wire.encode must return Uint8Array or null');
					}
					if (p == null) {
						result = wireJsonSend(ws, topic, event, datas[i], compress);
						if (result === SEND_DROPPED && ws._closed) return SEND_DROPPED;
						continue;
					}
					const id = ensureWireId(ws, ud, topic);
					if (id === -1) {
						poisonWireState(ws, ud, wire.capability);
						return sendJsonFrom(i, datas);
					}
					const frame = buildBinaryFrame(schemaVersion, id, 0, p);
					try {
						result = deliveryAuthorization.send(ws, frame, true, compress, topic);
					} catch {
						wsCounters.closedWsAborts++;
						return SEND_DROPPED;
					}
					if (result !== SEND_DROPPED) bumpOut(ws, frame);
					if (result === SEND_DROPPED) {
						poisonWireState(ws, ud, wire.capability);
						return sendJsonFrom(i + 1, datas, SEND_DROPPED);
					}
				}
				return result;
			}
			const id = ensureWireId(ws, ud, topic);
			if (id === -1) {
				// Dropped wire-id announce; the batch encode already advanced this
				// connection's dictionaries - the desync the poisoning exists for.
				poisonWireState(ws, ud, wire.capability);
				return sendJsonFrom(0, datas);
			}
			const frame = buildBinaryFrame(schemaVersion, id, 0, payload);
			let result;
			try {
				result = deliveryAuthorization.send(ws, frame, true, compress, topic);
			} catch {
				wsCounters.closedWsAborts++;
				return SEND_DROPPED;
			}
			if (result !== SEND_DROPPED) bumpOut(ws, frame);
			if (result === SEND_DROPPED) poisonWireState(ws, ud, wire.capability);
			return result;
		} finally {
			deliveryAuthorization.finish(deliveryOperation);
		}
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
	 * @returns {number} completed advisory attempts, including dropped frames. A send
	 *   or requested close that throws is not counted. A non-positive
	 *   whole-millisecond window performs no sends or closes.
	 */
	adviseReconnect(options) {
		const windowMs = options && typeof options.windowMs === 'number' && options.windowMs > 0
			? Math.floor(options.windowMs) : 0;
		// A non-positive window means suppressed (legacy behavior): nothing to advise.
		if (windowMs <= 0) return 0;
		const afterMs = options && typeof options.afterMs === 'number' && options.afterMs > 0
			? Math.floor(options.afterMs) : 0;
		const doClose = !options || options.close !== false;
		const filter = options && typeof options.filter === 'function' ? options.filter : null;
		const frame = afterMs > 0
			? '{"type":"reconnect","afterMs":' + afterMs + ',"windowMs":' + windowMs + '}'
			: '{"type":"reconnect","windowMs":' + windowMs + '}';
		const compress = ws_compression_on && !!(options && options.compress === true);
		// Snapshot the registry before filtering so side effects and closes cannot
		// change the candidate set. Settle every filter verdict before the first frame.
		const targets = [];
		for (const ws of [...wsConnections]) {
			let userData;
			try { userData = ws.getUserData(); }
			catch { wsCounters.closedWsAborts++; continue; }
			if (filter) {
				const decision = filter(userData);
				// An async filter cannot be evaluated synchronously; fail-closed (do not
				// advise), matching sendTo.
				if (decision && typeof decision.then === 'function') continue;
				if (!decision) continue;
			}
			targets.push(ws);
		}
		let count = 0;
		for (const ws of targets) {
			try {
				// Close after attempting the advisory; only accepted frames count.
				const result = deliveryAuthorization.control(ws, frame, compress);
				if (result !== SEND_DROPPED) bumpOut(ws, frame);
				if (doClose) deliveryAuthorization.end(ws, 1001, 'Server draining');
			} catch { wsCounters.closedWsAborts++; continue; }
			count++;
		}
		// The advisory is operator-lane egress: it carries no topic and no
		// tenant, so it lands in the worker egress window but sits outside
		// every ceiling - a drain command must not be refusable by a budget.
		if (count > 0) chargeDirectEgress(null, null, count, envelopeWireBytes(frame, count, egressGate.bytesArmed));
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
	 * counter once, and runs the hook once. A topic held only through an
	 * install still waiting on an attempt in flight is judged again rather
	 * than acked.
	 *
	 * Two parameters, matching the server subscription contract. Batch verdicts
	 * and recovery state travel through the private subscribeWithVerdict entry.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @returns {Promise<string | null>} null on success, else a denial reason
	 */
	async subscribe(ws, topic) {
		const result = await subscribeWithVerdict(ws, topic, undefined, undefined);
		return result === 'CLOSED' ? null : result;
	},

	/**
	 * Run the app's subscribe authorization hook without subscribing.
	 *
	 * Server callers may authorize system topics through the application hook.
	 *
	 * `requireGrant` is the OBSERVER-LANE mode: "may this connection see what
	 * it already holds?" With the grant gate armed and no app hook deciding,
	 * the topic must already be in that connection's grant set; under
	 * `'strict'` the grant is required even when an app hook exists. With the
	 * gate unarmed it falls through to the ordinary app gate, which is what
	 * keeps the snapshot lanes working for apps that never armed anything.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @param {any} [options]
	 * @returns {Promise<string | null>} a denial reason, or null to allow
	 */
	async checkSubscribe(ws, topic, options) {
		// Observer topics come from client snapshot frames and share the wire alphabet.
		if (!isValidWireTopic(topic, options && options.requireGrant ? allow_non_ascii_topics : true)) return 'INVALID_TOPIC';
		return runSubscribeGate(ws, topic, undefined, {
			requireGrant: !!(options && options.requireGrant)
		});
	},

	/**
	 * Arm wire-subscribe authorization for this worker, the programmatic
	 * spelling of `websocket.authorizeWireSubscribe`.
	 *
	 * Once armed, a CLIENT-initiated `subscribe` / `subscribe-batch` frame is
	 * honoured only for a topic the server already authorized for that
	 * connection through `platform.subscribe`, unless the app exports its own
	 * `subscribe` / `subscribeBatch` hook, which then decides. `'strict'`
	 * requires BOTH the server grant and an application-hook allow.
	 *
	 * For a framework whose subscriptions are all server-initiated: call once
	 * at startup, before connections arrive. Idempotent, and it only ever
	 * raises - strict is latched and a later no-argument call cannot downgrade
	 * it, because a gate that can be disarmed at runtime is not a gate.
	 *
	 * Worker-wide, not process-wide in any shared sense: call it from each
	 * worker's startup rather than expecting one worker's call to reach
	 * another's JavaScript realm.
	 *
	 * @param {'legacy' | 'strict'} [mode]
	 * @returns {'legacy' | 'strict'} the posture in force after the call
	 */
	authorizeWireSubscribe(mode) {
		if (mode !== undefined && mode !== 'legacy' && mode !== 'strict') {
			throw new TypeError(
				`platform.authorizeWireSubscribe() takes 'legacy' or 'strict' - got ${
					typeof mode === 'string' ? `'${mode}'` : String(mode)
				}. It gates who may subscribe, so a mode it cannot read is refused ` +
				'rather than treated as the weaker one.'
			);
		}
		subscribeAuth.enabled = true;
		if (mode === 'strict') subscribeAuth.strict = true;
		return subscribeAuth.strict ? 'strict' : 'legacy';
	},

	/** Publish compatible events in a shared frame when all subscribers opt in. */
	publishBatched(messages, options) {
		if (!Array.isArray(messages) || messages.length === 0) return;

		// Opt-in compression for the whole batch (default off). A batched frame
		// mixes event types, so the safe default is uncompressed; pass
		// { compress: true } to deflate. Applied uniformly to the fast (shared
		// frame) AND slow (per-event) paths so the two are consistent. No-op
		// while websocket.compression is off (the default).
		const compressOptIn = !!(options && options.compress === true);

		// Coalesce-by-key dedup runs first. Events that carry a
		// `coalesceKey` collapse so only the latest value per key
		// survives; events without a key pass through unchanged. This
		// is the same latest-value-wins primitive sendCoalesced offers
		// for streaming sends, lifted into the batched path so a single
		// publishBatched call carrying 100 cursor positions for the
		// same user delivers only the latest.
		messages = collapseByCoalesceKey(messages);
		if (messages.length === 0) return;
		// Validate the WHOLE batch before one event can mutate counters or reach a
		// subscriber. A mixed safe/unsafe batch must fail atomically rather than
		// partially publishing its prefix. One read per field, snapshotted: the
		// value judged here is the value the stamp and the relay decision use
		// below, so a stateful accessor cannot pass this atomic pre-pass and
		// then hand the fast path an authoritative number it would relay.
		const msgSeqs = new Array(messages.length);
		const msgRelays = new Array(messages.length);
		const msgJitters = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const o = messages[i].options;
			const seqOption = o != null ? o.seq : undefined;
			const relayOption = o != null ? o.relay : undefined;
			msgJitters[i] = o != null ? o.jitterMs : undefined;
			// And the value, for the same reason batch() asks it: the topology
			// check short-circuits on a single worker, so without this the
			// stamping loop below is where a bad value surfaces - after earlier
			// entries have advanced the topic counter and written the max-seen
			// map for a batch that puts nothing on any wire. The counter would
			// then skip a number no client ever sees, and a republish of it
			// after the payload is fixed reads as already-seen.
			assertStampableSeq(seqOption);
			msgSeqs[i] = seqOption;
			msgRelays[i] = relayOption;
		}

		if (deliveryAuthorization.deciding) {
			const captured = messages.map((message, i) => ({ topic: message.topic, event: message.event, data: message.data,
				options: { seq: msgSeqs[i], relay: msgRelays[i], jitterMs: msgJitters[i] } }));
			deliveryAuthorization.deferOperation(() => platform.publishBatched(captured, { compress: compressOptIn }));
			return;
		}
		const deliveryOperation = deliveryAuthorization.begin();
		try {
			// Batch only when every interested subscriber sees the same event slice.
			// Mixed membership or missing capabilities fall back to per-event publish.
			const firstTopic = messages[0].topic;
			let allSameTopic = true;
			for (let i = 1; i < messages.length; i++) {
				if (messages[i].topic !== firstTopic) { allSameTopic = false; break; }
			}

			// Combined detection pass: walk the subscriber set once to
			// determine whether the batch qualifies for the fast path
			// (single-topic or all-see-all) AND whether every interested
			// connection has advertised the 'batch' capability. We need
			// both: the shared-frame fast path is only safe when every
			// recipient can decode the {type:'batch',...} envelope.
			let allSeeAll = true;
			let everyoneCapable = true;
			/** @type {Set<string> | null} */
			let batchTopics = null;
			if (!allSameTopic) {
				batchTopics = new Set();
				for (let i = 0; i < messages.length; i++) batchTopics.add(messages[i].topic);
			}
			for (const ws of wsConnections) {
				const ud = ws.getUserData();
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || subs.size === 0) continue;
				let touchesAny = false;
				if (allSameTopic) {
					touchesAny = subs.has(firstTopic);
				} else {
					let touchesAll = true;
					for (const t of /** @type {Set<string>} */ (batchTopics)) {
						if (subs.has(t)) touchesAny = true;
						else touchesAll = false;
					}
					if (touchesAny && !touchesAll) { allSeeAll = false; break; }
				}
				if (!touchesAny) continue;
				const caps = ud[WS_CAPS];
				if (!caps || !caps.has('batch')) { everyoneCapable = false; break; }
			}

			// Slow-path fallback: per-event publish() so the caller pays
			// no penalty on small / disjoint shapes. Also the safe
			// degradation when any interested subscriber is non-cap-able -
			// they would otherwise receive an unparseable batch frame.
			if ((!allSameTopic && !allSeeAll) || !everyoneCapable) {
				// The batch is atomic on this path too: admitting per event would
				// deliver a prefix and refuse the tail, which is the mid-batch
				// shedding the budget forbids. Each topic carries its own
				// recipient count here (the paths differ only in dispatch), and a
				// tenant decides once on everything it owns in the batch.
				if (egressGate.armed && !admitBatchEgress(messages, null)) return;
				for (let i = 0; i < messages.length; i++) {
					const m = messages[i];
					// The snapshot, not a spread of the live object: publish() consumes
					// exactly these fields, and the values it stamps must be the ones
					// the atomic pre-pass above already judged.
					platform.publish(m.topic, m.event, m.data, ({ [EGRESS_ADMITTED]: true,
						seq: msgSeqs[i],
						relay: msgRelays[i],
						jitterMs: msgJitters[i],
						compress: compressOptIn
					}));
				}
				return;
			}

			// Egress admission for the whole fast-path batch, before anything is
			// stamped. In all-see-all every interested subscriber holds every batch
			// topic, so the dispatch topic's tracked count IS the recipient set for
			// every topic in the batch; a mixed-topic batch admits each distinct
			// topic's own share and pools each tenant's, and one refusal refuses
			// the whole batch (its atomicity contract). The slow path above takes
			// the same decision through the same helper, reading each topic's own
			// count, and marks its events so they charge without re-deciding.
			const recipients = getServer().subscriberCount(nativeTopic(messages[0].topic));
			const gateArmed = egressGate.armed;
			let egressTenant = null;
			if (gateArmed) {
				if (allSameTopic) {
					egressTenant = resolvePublishTenant(firstTopic);
					if (!admitPublishEgress(firstTopic, egressTenant, messages.length, messages.length * recipients)) return;
				} else if (!admitBatchEgress(messages, recipients)) return;
			}
			// Fast path: build per-event envelopes (also stamps seq + charges the
			// per-event egress), wrap into a shared batch frame, and hand
			// fanout through Bun's native topic tree. In all-see-all
			// every interested subscriber is subscribed to every batch
			// topic, so dispatching on any one of them reaches them all.
			/** @type {Array<{ topic: string, env: string, seq: number | null }>} */
			const events = new Array(messages.length);
			// A later serialization failure refuses the whole shared frame. Prepare
			// every body before any entry advances its topic's sequence or seen mark.
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				const topic = m.topic;
				events[i] = { topic, env: envelopePrefix(topic, m.event) + envelopeData(m.data), seq: null };
			}
			for (let i = 0; i < events.length; i++) {
				const entry = events[i];
				wsCounters.publishCount++;
				wsCounters.publishCountWindow++;
				const seq = stampSeqValue(msgSeqs[i], entry.topic);
				// Track the highest observed seq per topic (see platform.publish): the
				// compare-free record for the monotonic in-memory counter, the
				// monotone-max guard for an explicit numeric seq.
				if (seq !== null) {
					if (typeof msgSeqs[i] === 'number' || typeof msgSeqs[i] === 'bigint') notePublishedSeq(entry.topic, seq, true);
					else notePublishedSeq(entry.topic, seq, false);
				}
				const env = completeSerializedEnvelope(entry.env, seq);
				entry.env = env;
				entry.seq = seq;
				// One egress charge per logical publish: each batched event is one,
				// priced at its own envelope's UTF-8 bytes times the shared
				// recipient set. The batch frame's wrapper bytes are uncharged
				// overhead, so a tenant pays the same for N events whether the
				// runtime batches them or not.
				chargePublishEgress(entry.topic,
					gateArmed ? (allSameTopic ? egressTenant : resolvePublishTenant(entry.topic)) : null,
					1, recipients, env.length, envelopeWireBytes(env, recipients, egressGate.bytesArmed));
			}

			// Resume cutover in flight: a caps-less resuming connection receives these
			// events as per-event JSON (the slow path this fast path stands in for), so
			// hold each per-event envelope for any open buffer - NOT the wrapped batch
			// frame, which a caps-less connection never decodes and which can span topics.
			if (resumeBuffers.size > 0) {
				for (let i = 0; i < events.length; i++) captureResumeFrame(events[i].topic, events[i].seq, events[i].env, compressOptIn);
			}

			// Build the shared batch frame once.
			const slice = new Array(events.length);
			for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
			const sharedBatchEnv = wrapBatchEnvelope(slice);
			assert(sharedBatchEnv.length > 0, 'envelope.batch-empty', { events: events.length });
			// Hand fanout to Bun's native topic tree. Any batch topic works
			// as the dispatch channel because every interested subscriber
			// is subscribed to every batch topic in the all-see-all case
			// (single-topic is the trivial sub-case).
			const fanoutTopic = allSameTopic ? firstTopic : messages[0].topic;
			const result = publishAuthorized(getServer(), wsConnections, fanoutTopic, sharedBatchEnv, false, ws_compression_on && compressOptIn);
			wsCounters.transportMetricHooks?.publishOutcome(publishReached(result));
		} finally {
			deliveryAuthorization.finish(deliveryOperation);
		}
	},

	/**
	 * Grant a connection the right to publish to `topic` via the client-driven
	 * relay (`game`) lane - the trusted server-side dual of `platform.subscribe`.
	 * A client `game` frame carries NO topic; the server derives it from this
	 * binding, so a client can only publish to a room it was granted (typically
	 * at join, from the framework's authorization gate). This is the general
	 * publish-authorization primitive; a game session is its first consumer.
	 *
	 * Single-valued per connection (one room per socket, mirroring the native
	 * daemon's per-socket grant): a second call re-binds to the new topic. Pass a
	 * different topic to move the binding; call `revokePublish` to clear it.
	 *
	 * @param {any} ws
	 * @param {string} topic
	 * @returns {boolean} `true` on success, `false` if the socket had already closed
	 * @throws {Error} when sockets span more than one I/O worker and no single
	 *   authoritative game-lane home exists
	 */
	grantPublish(ws, topic) {
		// The per-room seq and sender-excluding walk are worker-local. Refuse the
		// first grant in a multi-I/O-worker topology instead of authorizing a lane
		// that would silently omit remote participants and fork its sequence.
		assertGameLaneClusterSafe();
		let ud;
		try { ud = ws.getUserData(); } catch { wsCounters.closedWsAborts++; return false; }
		ud[WS_PUBLISH_GRANT] = topic;
		return true;
	},

	/**
	 * Clear a connection's client-publish binding - the dual of `unsubscribe`.
	 * After this the connection's `game` frames are denied (`game-denied`
	 * `FORBIDDEN`) until re-granted. Idempotent.
	 *
	 * @param {any} ws
	 * @returns {boolean} `true` if a binding was cleared, `false` if there was none
	 */
	revokePublish(ws) {
		let ud;
		try { ud = ws.getUserData(); } catch { return false; }
		if (ud[WS_PUBLISH_GRANT] === undefined) return false;
		ud[WS_PUBLISH_GRANT] = undefined;
		return true;
	},

	/**
	 * The topic a connection is currently bound to publish to via the `game`
	 * lane, or `null` when it holds no grant. Read-only introspection.
	 *
	 * @param {any} ws
	 * @returns {string | null}
	 */
	publishGrant(ws) {
		let ud;
		try { ud = ws.getUserData(); } catch { return null; }
		return ud[WS_PUBLISH_GRANT] ?? null;
	},

	/**
	 * Relay a client-originated `game` frame to a topic's local subscribers,
	 * EXCLUDING the sender (echo suppression - the sender already holds its own
	 * input and predicts locally) and echoing the sender's client `id` for
	 * input ordering / prediction-reconcile on the other receivers. The server
	 * stamps a monotonic per-room seq (the session-home sequencer), so a globally
	 * ordered relay sequence is this home worker's counter.
	 *
	 * Trusted server path (explicit topic): the wire-level `game` handler resolves
	 * the topic from the sender's `WS_PUBLISH_GRANT` and gates on it before calling
	 * this. Fan-out takes the per-subscriber walk (native topic broadcast cannot skip a
	 * socket); this is the conformance ORACLE behavior, not the perf path - the
	 * native daemon does the same fan-out with `publish_wire`/`exclude_ws`. Local
	 * only: cross-worker / cross-edge home relay is a separate mechanism. Game
	 * frames are sent uncompressed (the 60 Hz input path, like the cursor lane).
	 *
	 * @param {any} senderWs  the publishing socket, excluded from the fan-out
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {number | string} [id]  the sender's client input id, echoed to the other receivers
	 * @returns {{ seq: number | null, delivered: number }}
	 * @throws {Error} when sockets span more than one I/O worker
	 */
	publishGame(senderWs, topic, event, data, id) {
		// Server-authored frames can bypass grantPublish, so guard this primitive
		// independently as well. One I/O worker plus any number of compute workers
		// is safe; more than one socket-owning worker needs an external authority.
		assertGameLaneClusterSafe();
		if (deliveryAuthorization.deciding) {
			deliveryAuthorization.deferOperation(() => platform.publishGame(senderWs, topic, event, data, id));
			return { seq: null, delivered: 0 };
		}
		// Egress: the sender is subscribed to its own room in the ordinary case
		// and is excluded from the walk, so it is not a recipient. The game lane
		// is the one publish with a socket in hand - its tenant is the SENDER's
		// frozen attribution, never the topic resolver: the client relaying
		// through this lane is the party whose budget the fan-out spends.
		let recipients = getServer().subscriberCount(nativeTopic(topic));
		if (excludedRecipient(senderWs, topic)) recipients--;
		let egressTenant = null;
		if (egressGate.armed) {
			if (egressGate.account !== null && egressGate.account.tenantEnabled) {
				let att = null;
				try { att = senderWs.getUserData()[WS_ATTRIBUTION] ?? null; } catch { att = null; }
				egressTenant = att !== null && typeof att.tenantId === 'string' ? att.tenantId : null;
			}
			// A refusal delivers nothing and stamps nothing; { seq: null,
			// delivered: 0 } is this lane's refusal shape.
			if (!admitPublishEgress(topic, egressTenant, 1, recipients)) return { seq: null, delivered: 0 };
		}
		wsCounters.publishCountWindow++;
		const seq = stampSeqValue(undefined, topic);
		if (seq !== null) notePublishedSeq(topic, seq, false);
		const envelope = completeGameEnvelope(envelopePrefix(topic, event), data, seq, id);
		fatal(envelope.length > 0, 'envelope.empty', null);
		// The one egress charge for this logical publish. Compact-binary
		// recipients are charged the envelope size too: the 0x03 form is
		// per-capability and encoded lazily inside the walk, and forcing the
		// encode on every publish just to price it would tax the 60 Hz lane.
		chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, envelopeWireBytes(envelope, recipients, egressGate.bytesArmed));
		// Fan out to the topic's LOCAL subscribers, skipping the sender. The single
		// native topic fan-out cannot skip a socket, so the exclusion forces the
		// per-subscriber walk (the same shape publishWire uses for excludeWs).
		//
		// Compact fan-out (PROTOCOL.md 6.7): a subscriber that negotiated
		// `game.fanout:1` receives the value-codec `0x03` frame; everyone else
		// gets the JSON envelope, byte-identical to before. The compact payload is
		// stateless (sender-independent), so it is encoded ONCE and framed per
		// connection by its wire-id - exactly the stateless publishWire path. The
		// walk is mandatory here regardless of that, because the sender must be
		// excluded. capCounts short-circuits the whole binary path to zero cost
		// when no connected client advertised the capability.
		// Resume cutover in flight: hold the JSON game envelope a caps-less resuming
		// subscriber would receive (compact-binary subscribers recover via their own
		// wire-id announce on join, not this buffer). One guarded size check.
		if (resumeBuffers.size > 0) captureResumeFrame(topic, seq, envelope, false);
		const wantBinary = capCounts.has(GAME_FANOUT_CAP);
		const seqOnWire = seq == null ? 0 : seq;
		/** @type {Uint8Array | null} */
		let sharedPayload = null;
		let sharedEncoded = false;
		/** @type {Map<number, Uint8Array> | null} */
		let sharedFrameById = null;
		const envelopeCache = deliveryAuthorization.cache();
		const deliveryOperation = deliveryAuthorization.begin();
		try {
			let delivered = 0;
			for (const ws of wsConnections) {
				if (ws === senderWs) continue;
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				const caps = wantBinary ? ud[WS_CAPS] : null;
				if (caps && caps.has(GAME_FANOUT_CAP) && !wireStatePoisoned(ud, GAME_FANOUT_CAP)) {
					if (!sharedEncoded) {
						sharedPayload = encodeGameFanoutPayload(event, data, id);
						sharedEncoded = true;
						sharedFrameById = new Map();
					}
					const wid = ensureWireId(ws, ud, topic);
					if (wid === -1) {
						// Dropped wire-id announce: the client can never resolve this
						// topic's numeric id, so binary is undecodable here from now on.
						// JSON for this frame + poison to JSON until reconnect.
						poisonWireState(ws, ud, GAME_FANOUT_CAP);
						try { const result = deliveryAuthorization.send(ws, envelope, false, false, null, envelopeCache); if (result !== 2) bumpOut(ws, envelope); delivered++; }
						catch { wsCounters.closedWsAborts++; }
						continue;
					}
					let frame = sharedFrameById.get(wid);
					if (!frame) {
						frame = buildBinaryFrame(GAME_FANOUT_SCHEMA_VERSION, wid, seqOnWire, /** @type {Uint8Array} */ (sharedPayload));
						sharedFrameById.set(wid, frame);
					}
					// A dropped shared frame needs no poisoning: the payload carries no
					// per-connection state, so the client decoder stays in sync.
					try { const result = deliveryAuthorization.send(ws, frame, true, false, topic); if (result !== 2) bumpOut(ws, frame); delivered++; }
					catch { wsCounters.closedWsAborts++; }
					continue;
				}
				try { const result = deliveryAuthorization.send(ws, envelope, false, false, null, envelopeCache); if (result !== 2) bumpOut(ws, envelope); delivered++; }
				catch { wsCounters.closedWsAborts++; }
			}
			return { seq, delivered };
		} finally {
			deliveryAuthorization.finish(deliveryOperation);
		}
	},

	/**
	 * The seq-space generation for one topic: its override when something
	 * minted one, else this process's own. The value that rides the topic's
	 * `subscribed` ack, so an app comparing a client's `lastSeenEpochs` entry
	 * against it is asking the same question the client will.
	 *
	 * Opaque and equality-only, like every epoch on this wire: a different
	 * value means the topic's seq space changed and a client's stored offsets
	 * are no longer meaningful.
	 *
	 * @param {string} topic
	 * @returns {number}
	 */
	topicEpoch(topic) {
		return topicEpochValue(topic);
	},

	/**
	 * Mint a fresh generation for one topic, repudiating every offset clients
	 * recorded under the old one.
	 *
	 * The explicit-seq lane is single-authority per topic: the max-seen mark is
	 * monotone and no seq carries the identity of the counter that issued it,
	 * so one publish from a different authority pins that mark for the life of
	 * the process and every later resume dedups against a floor from the wrong
	 * sequence space. An app that CHANGES a topic's authority - counter to an
	 * external allocator, a different partition, a reset store - calls this, and
	 * the old offsets die at their next resume through the ordinary
	 * epoch-mismatch answer rather than silently deduping against the poison.
	 *
	 * @param {string} topic
	 * @returns {number} the installed epoch
	 */
	bumpTopicEpoch(topic) {
		return mintTopicEpoch(topic);
	},

	/**
	 * Whether `request` is a synthetic boot-warmup render rather than a real
	 * client request.
	 *
	 * Tagged by object IDENTITY, never a header, so a real client cannot forge
	 * one. An app's hooks use it to skip the side effects a real visit would
	 * incur - analytics, rate counting, an audit log entry - for a render
	 * nobody asked for.
	 *
	 * @param {Request} request
	 * @returns {boolean}
	 */
	isWarmupRequest(request) {
		return isWarmupRequest(request);
	},

	/**
	 * Remove a held membership or cancel an in-flight subscribe.
	 * Server revocations dispatch every app teardown without a client flood limit.
	 * @param {any} ws
	 * @param {string} topic
	 * @returns {boolean} whether membership was removed or an attempt cancelled
	 */
	unsubscribe(ws, topic) {
		return unsubscribeMembership(ws, topic, dispatchServerUnsubscribeHook);
	},

	/** Live connections on THIS instance. */
	get connections() {
		return wsConnections.size;
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
		return getServer().subscriberCount(nativeTopic(topic));
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
			return ws.getBufferedAmount() + deliveryAuthorization.pendingBytes(ws);
		} catch {
			return 0;
		}
	},

	/** Sends/subscribes refused because the socket had already closed. */
	get closedWsAborts() {
		return wsCounters.closedWsAborts;
	},

	/**
	 * The live pressure snapshot: what the 1 Hz sampler last measured. This is
	 * the LIVE singleton, mutated in place each sample and never copied - a
	 * held reference always reads the latest sample, and `onPressure`
	 * callbacks receive the same object. Fields: `active`, `value` (0..1
	 * worst-of saturation), `reason` ('NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS'
	 * | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY'), `subscriberRatio`,
	 * `publishRate`, `memoryMB` (rss), `maxBufferedBytes`,
	 * `backpressuredConnections`, `psi` / `cpuThrottle` (kernel readings,
	 * null off-Linux), `topPublishers`.
	 */
	get pressure() {
		return pressureSnapshot;
	},

	/**
	 * The protection posture level: 'normal' | 'elevated' | 'siege'. Reads
	 * 'normal' when no posture machine is configured - the zero-config
	 * posture, and the only one this adapter currently runs (the
	 * `websocket.protection` option is a recorded parity gap).
	 */
	get protection() {
		return wsCounters.activePosture !== null ? wsCounters.activePosture.level : 'normal';
	},

	/**
	 * Subscribe to pressure-reason transitions. The callback fires at most
	 * once per sample, only when `reason` CHANGED, with the live snapshot
	 * (the same object `platform.pressure` returns). A throwing callback is
	 * contained and logged; the remaining callbacks still run.
	 *
	 * @param {(snapshot: any) => void} cb
	 * @returns {() => void} unsubscribe
	 */
	onPressure(cb) {
		pressureListeners.add(cb);
		return () => pressureListeners.delete(cb);
	},

	/**
	 * Subscribe to per-topic runaway-publisher reports. The callback fires
	 * once per sample window that had over-threshold topics, with
	 * `[{ topic, messagesPerSec, bytesPerSec }]`. Registering at least one
	 * callback replaces the default throttled console warning - the app owns
	 * the surface at that point.
	 *
	 * @param {(over: Array<{ topic: string, messagesPerSec: number, bytesPerSec: number }>) => void} cb
	 * @returns {() => void} unsubscribe
	 */
	onPublishRate(cb) {
		publishRateListeners.add(cb);
		return () => publishRateListeners.delete(cb);
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
				(topic, event, data, options) => platform.publish(topic, event, data, options)
			);
		}
		return topicHelperCache(name);
	},

	/**
	 * Determinism seams. App and plugin code reads wall clock, monotonic time,
	 * and randomness through the platform; the platform reads them through the
	 * runtime seam (../runtime.js), which is the ONE place a deterministic
	 * simulation substitutes all three - no globals are ever patched.
	 */
	now() {
		return wallEpoch();
	},

	monotonic() {
		return processMonotonicNow();
	},

	/**
	 * Hybrid logical clock stamp: a non-decreasing wall value with a logical
	 * tiebreaker and a per-process node id. Read only when an event needs a
	 * causal stamp, never on the per-publish hot path.
	 */
	hlc() {
		// Allocate the node identity on first use so unused clocks consume no RNG.
		processHlc ??= createHlc();
		return processHlc();
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
		float: () => randomFloat(),
		u32: () => randomU32(),
		uuid: () => randomUuid(),
		/** @param {number} n */
		bytes: (n) => new Uint8Array(randomOctets(n))
	}
};

// The members every build has, mixed in rather than restated. Descriptors, not
// a spread: `metrics` is an accessor, and a spread would copy the value it
// answered with at module-init time and quietly stop being the same member as
// the one a build with no realtime tier serves.
Object.defineProperties(platform, Object.getOwnPropertyDescriptors(httpPlatform));

/**
 * The `platform` one request gets.
 *
 * ONE PLACE DECIDES THIS, because the choice is not obvious and getting it wrong
 * is silent: with a realtime tier the request is prototype-linked to the
 * realtime platform, and without one to the members that do not need a tier -
 * where linking to nothing at all left a documented member throwing
 * `platform.metricsSnapshot is not a function` on a whole class of build. The
 * clone is per request and carries only the identity; every method still
 * resolves to the shared singleton behind it.
 *
 * @param {string} requestId
 * @returns {any}
 */
export function requestPlatform(requestId) {
	return Object.assign(Object.create(ws_options ? platform : httpPlatform), { requestId });
}


/**
 * Answer a refusal from the landing, settling the attempt as denied: a
 * membership standing with no authority behind it, judged by its last attempt,
 * is unwound before the answer goes out.
 *
 * @param {any} ws
 * @param {any} userData
 * @param {Set<string>} subs
 * @param {string} topic
 * @param {number} token
 * @param {any} recoverCapture - the recover lane's open live-frame buffer, if any
 * @param {string} reason
 * @param {{ fromWire?: boolean }} [lane]
 * @returns {string}
 */
function refuseLanding(ws, userData, subs, topic, token, recoverCapture, reason, lane) {
	if (recoverCapture) discardResumeCapture(recoverCapture);
	if (settleDeniedSubscribe(userData, topic, token, subs.has(topic)) === 'deny-unwind') {
		unwindRevokedSubscribe(ws, topic, userData, lane);
	}
	return reason;
}

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
 * @param {{ allowSystemTopic?: boolean, recover?: { offset: number, epoch?: number } }} [options] -
 *   `recover` asks for a gap-fill from that offset before the subscription lands
 * @param {unknown} [verdict] - from a batch gate already run for this frame
 * @param {{ fromWire?: boolean, pendingToken?: number }} [lane] - which
 *   authority is exercised, and the batch lane's own in-flight stamp for the
 *   topic when it has one
 * @returns {Promise<string | null>} null on success, else a denial reason
 */
export async function subscribeWithVerdict(ws, topic, options, verdict, lane) {
	// A stamp the batch lane took before its own gate. Every exit from here on
	// settles it, and none takes a second one.
	const carried = lane && typeof lane.pendingToken === 'number' ? lane.pendingToken : undefined;
	// Server-side callers are trusted past the always-illegal bytes: an app
	// using non-ASCII topic names must not be blocked at this layer. The batch
	// lane's topics already passed the stricter wire check, so a carried stamp
	// never reaches these two refusals; it is settled anyway rather than left
	// counting against the connection until close.
	if (!isValidWireTopic(topic, true)) return releaseCarried(ws, topic, carried, 'INVALID_TOPIC', lane);
	// System-topic restrictions belong to the wire boundary. Server callers
	// delegate authorization to the app hook, including plugin-owned channels.
	if (lane?.fromWire && !options?.allowSystemTopic && isSystemTopic(topic) && !isPluginOwnedTopic(topic)) {
		return releaseCarried(ws, topic, carried, 'INVALID_TOPIC', lane);
	}
	let userData;
	try {
		userData = ws.getUserData();
	} catch {
		if (options?.preparedRecovery?.capture) discardResumeCapture(options.preparedRecovery.capture);
		wsCounters.closedWsAborts++;
		return 'CLOSED';
	}
	const subs = userData[WS_SUBSCRIPTIONS];
	// The subscription slot is assigned a Set once at open and never reassigned;
	// a non-Set on a live connection is unrecoverable corruption. In production
	// fatal() has only scheduled the exit, so the same test then answers the
	// caller rather than letting `subs.has` throw out of a platform method.
	fatal(subs instanceof Set, 'subs.shape', null);
	if (!(subs instanceof Set)) return releaseCarried(ws, topic, carried, 'CLOSED', lane);
	let token = carried;
	// Admit an attempt that brings no stamp of its own: the held short-circuit,
	// the independent landed and pending-attempt caps, and the stamp. Written here rather than as a helper:
	// a function this size is past the bytecode cost JavaScriptCore's optimizing
	// tier inlines, so as a helper every subscribe paid a real call for it.
	if (token === undefined) {
		// NOT when a gap-fill was asked for. Live membership carries no HISTORY, so
		// acking a held topic here left a caller that asked to recover from an
		// offset subscribed and believing itself caught up, with the tail between
		// its last-seen seq and now silently missing - and under an armed gate,
		// where held is exactly what granted means, that is every legal recover the
		// wire can ask for. Falls through to the recover lane instead, which acks
		// through the already-subscribed branch below once the gap is filled.
		const wantsGapFill = wantsRecover({
			hasResumeHook: wsModule.resume,
			recover: options && options.recover
		});
		// Nor when the membership is still waiting to be judged - installed inside
		// an attempt's await window, by that attempt's own hook: acked on sight, it
		// could be unwound a moment later under an ack that said it stood. That one
		// enrols and is judged like any attempt, and an allow recorded on its
		// landing is the authority the other attempts' landings then read.
		if (!(lane && lane.fromWire) && subs.has(topic) && !wantsGapFill && !membershipUnconfirmed(userData, topic)) return null;
		// Landed membership and in-flight attempts have independent bounds.
		if (
			exceedsSubscriptionCap({
				held: subs.has(topic),
				size: subs.size,
				max: MAX_SUBSCRIPTIONS_PER_CONNECTION
			})
		) {
			return 'RATE_LIMITED';
		}

		// A permanent authorization refusal wins over a transient retry signal.
		if (lane?.fromWire && deniesWireSubscribePreHook({
			armed: subscribeAuth.enabled,
			hasUserHook: hasUserSubscribeHook() && !subscribeAuth.strict,
			held: subs.has(topic) && !membershipUnconfirmed(userData, topic),
			topic
		})) return 'FORBIDDEN';

		if (pendingSubscribeTotal(userData) >= MAX_PENDING_SUBSCRIBES_PER_CONNECTION) return 'RATE_LIMITED';

		token = beginPendingSubscribe(userData, topic, subs.has(topic));
	}
	let recoverCapture = options?.preparedRecovery?.capture ?? null;
	let denial = null;
	// A batch entry with no batch verdict runs the per-topic hook here. One a
	// revocation already cancelled is not run at all: there is nothing its
	// answer could change, and the hook is app work the client's frame would be
	// buying for nothing.
	const skipGate = lane && lane.pendingToken !== undefined && verdict === undefined
		&& isPendingSubscribeCancelled(userData, topic, token);
	if (!skipGate) {

		try {
			denial = await runSubscribeGate(ws, topic, verdict, lane);
		} catch (err) {
			refuseLanding(ws, userData, subs, topic, token, recoverCapture, 'INTERNAL_ERROR', lane);
			throw err;
		}
	}
	// Recover gap-fill, only after the gate ALLOWED: a topic's replay history
	// must never be served ahead of a refusal. The barrier opens BEFORE the
	// resume await so a publish landing inside the hook's window is held, and
	// the pending entry stays in flight across the await so an unsubscribe
	// landing mid-resume still cancels the install below.
	let recoverCovered = options?.preparedRecovery?.covered;
	const recover = options && options.recover;
	if (
		(denial === null || denial === undefined) &&
		recover &&
		// The same rule the wire lane applies, for a caller reaching this
		// through the platform API rather than through a subscribe frame: an
		// offset the server could not have issued is not a recover, and
		// subscribing plainly beats gap-filling from a fabricated cursor.
		isValidResumeSeq(recover.offset) &&
		typeof wsModule.resume === 'function' &&
		// Replay history is served BEFORE the subscription lands, so the ways a
		// grant can be absent have to be asked here rather than at the landing
		// below - by then the frames are already on the socket. Membership is
		// read first, so a revoke followed by a legitimate re-grant inside one
		// await window is served rather than acked with the replay silently
		// dropped.
		//
		// The grant term is scoped to the WIRE lane. Server-initiated recovery
		// is the server subscribing a topic it is granting in the same call, so
		// judging it against a grant that by definition has not landed yet
		// would make an armed worker unable to gap-fill anything at all. The
		// cancellation term is not scoped: an unsubscribe that landed mid-gate
		// means the client left, and it left on either lane.
		!recoverIsRevoked({
			// Held only as the landing would ack it: a revoked attempt whose own
			// hook installed the membership reads as held, and would be served
			// the history before its landing refused it.
			held: subs.has(topic) && heldLandingWouldAck(userData, topic, token),
			wireAuthz:
				Boolean(lane && lane.fromWire) &&
				subscribeAuth.enabled &&
				(subscribeAuth.strict || !hasUserSubscribeHook()),
			cancelled: isPendingSubscribeCancelled(userData, topic, token),
			topic
		})
	) {
		// The pending attempt remains counted throughout recovery.
		recoverCapture = beginResumeCapture([topic], ws);
		try {
			recoverCovered = await wsModule.resume(ws, {
					sessionId: userData[WS_SESSION_ID],
					lastSeenSeqs: { [topic]: recover.offset },
					lastSeenEpochs: isValidResumeEpoch(recover.epoch) ? { [topic]: recover.epoch } : undefined,
					platform: userData[WS_PLATFORM] || platform
			});
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
	// Explicit nullish test, NOT truthiness. checkSubscribe classifies any
	// string the hook returns as a denial reason, including the empty
	// string - which a hook produces naturally from a lookup miss
	// (`DENY_REASONS[topic] ?? ''`). Under truthiness that denial fell
	// through to the install below and the client got a `subscribed` ack for
	// a topic the app meant to refuse. The app's answer outranks membership:
	// a refusal it gave is not overruled by the connection happening to hold
	// the topic now.
	if (denial !== null && denial !== undefined) return refuseLanding(ws, userData, subs, topic, token, recoverCapture, denial, lane);

	// MEMBERSHIP FIRST, asked before the cancellation mark for the reason the
	// recover lane asks in that order too: the mark only ever rises, so reading
	// it alone cannot see a revoke followed by a legitimate re-grant inside one
	// await window - which is the shape of an ordinary permission refresh. But
	// held is not enough on its own either: a revocation removes the membership
	// when it cancels, so a topic held at a revoked landing was installed inside
	// the await window, either by a fresh attempt whose authorization completed
	// (current authority, ack) or by this attempt's own hook (the install the
	// cancellation exists to defeat). settleHeldSubscribe reads which. Any
	// frames held for a recover would be duplicates of what the connection is
	// already live for - discard them either way.
	if (subs.has(topic)) {
		if (recoverCapture) discardResumeCapture(recoverCapture);
		const held = settleHeldSubscribe(userData, topic, token);
		if (held === 'ack') return null;
		if (held === 'deny-unwind') unwindRevokedSubscribe(ws, topic, userData, lane);
		return 'FORBIDDEN';
	}
	// Recheck landed capacity after authorization because other attempts may land.
	// The grant gate re-checked where the subscription LANDS. `subscribeAuth`
	// is runtime-mutable and latches false -> true, so a wire subscribe that
	// entered unarmed - or before `'strict'` was latched - has to be judged
	// under the posture in force now rather than the one it started under.
	// Both ends read it fresh for that reason. Reaching here means the topic is
	// not held, so an armed worker with no hook deciding has no grant to
	// honour. Scoped to the wire lane: the server's own `platform.subscribe` IS
	// the grant, and judging it against a grant that has not landed yet would
	// leave an armed worker unable to authorize anything.
	if (
		lane && lane.fromWire &&
		deniesWireSubscribeLanding({
			armed: subscribeAuth.enabled,
			hasUserHook: hasUserSubscribeHook() && !subscribeAuth.strict,
			held: false,
			topic
		})
	) {
		return refuseLanding(ws, userData, subs, topic, token, recoverCapture, 'FORBIDDEN', lane);
	}
	if (exceedsSubscriptionCap({ held: false, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
		return refuseLanding(ws, userData, subs, topic, token, recoverCapture, 'RATE_LIMITED', lane);
	}
	// Settled LAST, after every refusal above, and marked as authority: this
	// attempt is about to install the membership on the current epoch, so a
	// revoked sibling landing after it reads the grant as current. Marking it
	// before a refusal would hand that sibling authority nobody exercised.
	if (!settlePendingSubscribe(userData, topic, token, true)) {
		if (recoverCapture) discardResumeCapture(recoverCapture);
		return 'FORBIDDEN';
	}
	try {
		ws.subscribe(topic);
	} catch {
		if (recoverCapture) discardResumeCapture(recoverCapture);
		wsCounters.closedWsAborts++;
		return 'CLOSED';
	}
	addLogicalSubscription(subs, topic);
	// Live membership is installed: flush any frames held during the resume
	// window, in order, skipping what the resume already covered, before the
	// caller sends the ack.
	//
	// The flush closes the connection when a gap-fill it could not complete is
	// also one it could not report. `CLOSED` is what the ack lane already
	// understands as "there is nobody left to answer", so it sends nothing - and
	// the cohort join below is skipped, which would otherwise take a shared
	// wire-id reference for a connection that is on its way out.
	if (
		recoverCapture &&
		flushResumeTopic(recoverCapture, topic, coveredSeqFor(recoverCovered, topic))
	) {
		return 'CLOSED';
	}
	// A topic already running shared binary fan-out cohorts its joiners at
	// subscribe time; the first shared publish cohorted whoever preceded it.
	const sharedCap = sharedTopics.get(topic);
	if (sharedCap !== undefined) joinSharedCohort(ws, userData, topic, sharedCap);
	return null;
}

/**
 * Settle a carried batch stamp on an exit that refuses before the landing, and
 * answer with `reason`. A no-op without one.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {number | undefined} token
 * @param {string} reason
 * @param {{ fromWire?: boolean }} [lane]
 * @returns {string}
 */
function releaseCarried(ws, topic, token, reason, lane) {
	if (token === undefined) return reason;
	let userData;
	try {
		userData = ws.getUserData();
	} catch {
		// Closed: the close dropped the whole record.
		return reason;
	}
	if (settleDeniedSubscribe(userData, topic, token, heldSubscriptions(ws).has(topic)) === 'deny-unwind') {
		unwindRevokedSubscribe(ws, topic, userData, lane);
	}
	return reason;
}

/**
 * Undo a membership a revoked subscribe attempt installed from its own hook -
 * the 'deny-unwind' answer of the landing's provenance reads - and run the
 * app's `unsubscribe` hook for it. Application promises never delay revocation.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {any} userData
 * @param {{ fromWire?: boolean }} [lane]
 */
function unwindRevokedSubscribe(ws, topic, userData, lane) {
	unwindRevokedMembership(ws, topic);
	const dispatchHook = lane?.fromWire ? dispatchUnsubscribeHook : dispatchServerUnsubscribeHook;
	dispatchHook(ws, topic, true, userData);
}

/** Authorize all batch entries before serving one combined recovery request. */
export async function prepareBatchRecovery(ws, topics, tokens, verdicts, recover) {
	let userData;
	try { userData = ws.getUserData(); }
	catch { return topics.map(() => ({ denial: 'CLOSED', capture: null })); }
	const subs = userData[WS_SUBSCRIPTIONS];
	const entries = [];
	for (let i = 0; i < topics.length; i++) {
		const topic = topics[i];
		const denial = isPendingSubscribeCancelled(userData, topic, tokens[i])
			? null : await runSubscribeGate(ws, topic, verdicts[i], { fromWire: true });
		entries.push({ denial, capture: null, covered: undefined });
	}
	const lastSeenSeqs = {};
	const lastSeenEpochs = {};
	for (let i = 0; i < topics.length; i++) {
		const topic = topics[i];
		const input = recover[topic];
		if (entries[i].denial !== null || !wantsRecover({ hasResumeHook: wsModule.resume, recover: input })) continue;
		if (recoverIsRevoked({
			held: subs.has(topic) && heldLandingWouldAck(userData, topic, tokens[i]),
			wireAuthz: subscribeAuth.enabled && (subscribeAuth.strict || !hasUserSubscribeHook()),
			cancelled: isPendingSubscribeCancelled(userData, topic, tokens[i]), topic
		})) continue;
		lastSeenSeqs[topic] = input.offset;
		if (isValidResumeEpoch(input.epoch)) lastSeenEpochs[topic] = input.epoch;
		entries[i].capture = beginResumeCapture([topic], ws);
	}
	if (Object.keys(lastSeenSeqs).length === 0) return entries;
	try {
		const covered = await wsModule.resume(ws, {
			sessionId: userData[WS_SESSION_ID], lastSeenSeqs,
			lastSeenEpochs: Object.keys(lastSeenEpochs).length ? lastSeenEpochs : undefined,
			platform: userData[WS_PLATFORM] || platform
		});
		if (covered !== null && typeof covered === 'object') {
			for (const entry of entries) entry.covered = covered;
		}
	} catch (err) {
		const { log } = recoverThrewThrottle();
		if (log) console.error('[ws] recover-on-subscribe hook threw:', err);
		for (let i = 0; i < entries.length; i++) {
			if (entries[i].capture) markResumeTruncated(entries[i].capture, topics[i]);
		}
	}
	return entries;
}


/** Release a client-requested membership and invoke its teardown hook. */
export function unsubscribeFromWire(ws, topic) {
	return unsubscribeMembership(ws, topic, dispatchUnsubscribeHook, true);
}

function unsubscribeMembership(ws, topic, dispatchHook, releaseUntracked = false) {
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
	const cancelledPending = tombstonePendingSubscribe(userData, topic);
	// Release the taps a plugin derived from this topic (a roster channel, a
	// cursor channel) before the membership check: revoking a topic takes
	// them away whether or not the base membership is still present.
	releaseDerivedSubscriptions(ws, topic);
	if (userData[WS_PUBLISH_GRANT] === topic) userData[WS_PUBLISH_GRANT] = undefined;
	const subs = userData[WS_SUBSCRIPTIONS];
	assert(subs instanceof Set, 'subs.shape-unsubscribe', null);
	if (!(subs instanceof Set)) return cancelledPending;
	const wasHeld = subs.has(topic);
	if (!wasHeld && !releaseUntracked) return cancelledPending;
	try {
		// Bun cannot hold an empty native topic and rejects its removal.
		// The wire release still clears grants and invokes application teardown.
		if (topic !== '') ws.unsubscribe(topic);
	} catch {
		// The native membership is already gone with the socket; the
		// bookkeeping below still has to run or the counter leaks.
		wsCounters.closedWsAborts++;
	}
	if (wasHeld) removeLogicalSubscription(subs, topic);
	// A shared topic's cohort membership travels with the logical
	// subscription; leaving releases the wire-id ref this connection held.
	if (sharedTopics.has(topic)) leaveSharedCohort(ws, userData, topic);
	if (!wasHeld) return cancelledPending;
	dispatchHook(ws, topic, true, userData);
	return true;
}
