// The per-connection subscription slots and the helpers that move them.
//
// svelte-adapter-uws keeps the same slots and helpers in its own
// utils/ws-symbols.js, and this module follows its layout: the in-flight
// subscribe record is the same Map of the same entries, and its running total
// sits on a slot of its own. A plugin that carries its own copy of either
// module's helpers reads and writes these records directly, so the shapes are
// part of the contract, not an implementation detail.
//
// The slots are keyed by Symbol.for, under svelte-adapter-uws's names, for the
// same reason. A plugin package gets its own instance of these helpers - a
// copy of this module, or of svelte-adapter-uws's - while the runtime holds
// another, and a plain Symbol(description) is a new value per module instance:
// the plugin would write a slot the runtime never reads. With Symbol.for every
// copy resolves the same key. The trade-off is that user code calling
// Symbol.for('adapter-uws.ws.*') can reach these slots too, and an accessor
// installed on Object.prototype for one could swallow a write; the runtime
// declares them as own properties at open for that reason (see
// declareConnectionSlots). Slots no other copy needs stay module-private
// Symbols in handler/ws-state.js.
//
// It holds no state of its own beyond three process-wide slots on globalThis -
// the accounting sink, the settled-registry mark and the derived-topic prefixes
// - which every copy of these helpers has to share. No clock, no IO, no import of the runtime's
// configuration, so the ordering can be tested without a socket and the module
// can be loaded by code that never builds a server.

import { MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_SUBSCRIBES_PER_CONNECTION } from './caps.js';
import { exceedsSubscriptionCap, exceedsPendingSubscribeCap, HOOK_SIDE_EFFECT_ONLY, isPluginOwnedTopic } from './subscribe-policy.js';
export { registerPluginOwnedPrefix, isPluginOwnedTopic, isAuthorizationHook } from './subscribe-policy.js';
export const WS_INGRESS_BINDINGS = Symbol.for('adapter-uws.ws.ingress-bindings');
export const WS_CAPS = Symbol.for('adapter-uws.ws.caps');
export const WS_ATTRIBUTION = Symbol.for('adapter-uws.ws.attribution');
export const WS_SESSION_ID = Symbol.for('adapter-uws.ws.session-id');
// A family plugin can carry a publish binding even when this runtime exposes
// no game-publish lane. Rollback must clear that shared binding with membership.
export const WS_PUBLISH_GRANT = Symbol.for('adapter-uws.ws.publish-grant');

/**
 * The connection's logical subscriptions, a `Set<topic>` created at open. What
 * the close hook's `subscriptions` snapshot is taken from, what
 * `forEachSubscriber` and the binary publish walk deliver by (native membership
 * is not enumerable from JS), and what the worker's subscription total counts.
 */
export const WS_SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');

/**
 * The connection's platform: a per-connection clone prototype-linked to the
 * runtime's base platform, carrying the connection's request id. Symbol-keyed
 * members of the base platform are reached through it, which is how the
 * helpers below find the cohort slots of the server that owns the connection.
 */
export const WS_PLATFORM = Symbol.for('adapter-uws.ws.platform');

/**
 * Per-connection `Map<topic, { epoch: number, inflight: number, granted: boolean }>` tracking
 * subscribes currently IN FLIGHT: a wire `subscribe` frame parked in its
 * (possibly async) authorization-hook await, or a `platform.subscribe` in the
 * same window. A revocation (`platform.unsubscribe`) landing mid-await cannot
 * remove a subscription that does not exist yet, so it bumps the topic's
 * REVOCATION EPOCH instead; a landing whose captured epoch no longer matches
 * discards its grant rather than subscribing (revocation TOCTOU).
 *
 * Without it the landing installs a subscription the client already left after
 * sending its cancellation, so it may never ask to leave again. An ex-member
 * of a room keeps receiving it: a confidentiality failure, not merely counter
 * drift. A post-await `subs.has(topic)` re-check cannot detect it, because the
 * topic is absent from the set in both the never-subscribed case and the
 * just-unsubscribed case, and those demand opposite outcomes.
 *
 * A monotonic epoch rather than a plain tombstone flag, because a flag has one
 * slot per topic and a client can send the same `subscribe` frame twice: with
 * a flag, the second frame's arrival RE-ARMS the marker, so the first
 * (already-revoked) subscribe lands to find itself apparently un-revoked and
 * installs the grant, while the second is denied. The epoch is per-attempt and
 * only ever increases, so neither confusion is possible.
 *
 * `granted` records whether live authority backs the topic's membership: seeded
 * from the membership when the entry is created, set by an attempt that lands
 * on the current epoch, cleared by every revocation. The held-at-landing and
 * denial reads below decide by it whether a membership found standing may stay.
 *
 * Allocated lazily, and an entry is dropped once its last in-flight attempt
 * settles, so it holds nothing for an idle connection. The close path drops
 * the whole record: Bun keeps a socket's data reachable for as long as anything
 * holds the socket, so it is not left for the collector.
 */
export const WS_PENDING_SUBSCRIBES = Symbol.for('adapter-uws.ws.pending-subscribes');

/**
 * Per-connection count of subscribe attempts currently in flight - the sum of
 * every entry's `inflight` in {@link WS_PENDING_SUBSCRIBES}. Maintained at the
 * begin/settle choke points in this module ONLY, so it cannot drift from the
 * map: every path that changes an entry's `inflight` lives here. Kept as a
 * running total rather than summed on demand, because a bound that reads it on
 * every subscribe would otherwise make the pipelined case quadratic.
 */
export const WS_PENDING_SUBSCRIBES_TOTAL = Symbol.for('adapter-uws.ws.pending-subscribes-total');

/**
 * Every per-connection slot keyed by a registered Symbol, which is every slot
 * another copy of the subscription helpers can name.
 *
 * The runtime writes these with plain assignments, and a plain assignment is a
 * `[[Set]]`: it walks the prototype chain, and an accessor installed for the
 * key anywhere on it takes the value and creates NO own property. The userData
 * object is a plain object whose chain reaches `Object.prototype`, and the
 * keys are reachable by construction - they are `Symbol.for` - so an
 * application or a preload that puts an accessor on one silences the write.
 * Every site is a lazy init or a transition behind a falsy guard, so the guard
 * never closes: the subscription Set is rebuilt empty, the in-flight record
 * restarts on every subscribe and never cancels anything.
 */
export const SHARED_CONNECTION_SLOTS = Object.freeze([
	WS_INGRESS_BINDINGS,
	WS_CAPS,
	WS_ATTRIBUTION,
	WS_SESSION_ID,
	WS_SUBSCRIPTIONS,
	WS_PENDING_SUBSCRIBES,
	WS_PENDING_SUBSCRIBES_TOTAL,
	WS_PUBLISH_GRANT,
	WS_PLATFORM
]);

/**
 * Declare every shared slot as an own property of `userData`, so the
 * runtime's own writes land on it rather than on an inherited accessor. A
 * `[[Set]]` that finds an own data property writes it in place and never
 * consults the chain, so every later assignment stays a plain assignment and
 * pays nothing.
 *
 * Called once at open, before anything reads or writes a slot. A slot that is
 * ALREADY an own property is left exactly as it is: on a re-entrant open the
 * platform slot still holds the live connection's platform, which is the
 * evidence `ws.platform-double-init` reads to refuse the duplicate.
 * Overwriting it with `undefined` here would answer that guard's question
 * before it asked.
 *
 * @param {any} userData - `ws.getUserData()`
 */
export function declareConnectionSlots(userData) {
	if (!Object.hasOwn(userData, WS_INGRESS_BINDINGS)) defineSlot(userData, WS_INGRESS_BINDINGS, undefined);
	if (!Object.hasOwn(userData, WS_CAPS)) {
		Object.defineProperty(userData, WS_CAPS, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
	if (!Object.hasOwn(userData, WS_ATTRIBUTION)) {
		Object.defineProperty(userData, WS_ATTRIBUTION, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
	if (!Object.hasOwn(userData, WS_SESSION_ID)) {
		Object.defineProperty(userData, WS_SESSION_ID, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
	if (!Object.hasOwn(userData, WS_SUBSCRIPTIONS)) {
		Object.defineProperty(userData, WS_SUBSCRIPTIONS, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
	if (!Object.hasOwn(userData, WS_PENDING_SUBSCRIBES)) {
		Object.defineProperty(userData, WS_PENDING_SUBSCRIBES, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
	if (!Object.hasOwn(userData, WS_PENDING_SUBSCRIBES_TOTAL)) {
		Object.defineProperty(userData, WS_PENDING_SUBSCRIBES_TOTAL, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
	if (!Object.hasOwn(userData, WS_PUBLISH_GRANT)) {
		Object.defineProperty(userData, WS_PUBLISH_GRANT, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
	if (!Object.hasOwn(userData, WS_PLATFORM)) {
		Object.defineProperty(userData, WS_PLATFORM, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
}

/**
 * The connection's current in-flight subscribe attempt count.
 *
 * @param {any} ud - the connection's userData
 * @returns {number}
 */
export function pendingSubscribeTotal(ud) {
	return ud[WS_PENDING_SUBSCRIBES_TOTAL] ?? 0;
}

/**
 * Open an in-flight subscribe for `topic`, returning the token the landing
 * must present to {@link settlePendingSubscribe}. The token is the topic's
 * current revocation epoch.
 *
 * `held` seeds the entry's authority flag: a topic ALREADY held when the
 * first attempt enrols is backed by a completed authorized path, so a later
 * denial must answer the frame without evicting it. Only the FIRST enrolment
 * seeds it - a topic that became held after the entry opened was installed
 * inside the await window (a plugin join from a hook), which is precisely the
 * membership {@link settleDeniedSubscribe} exists to unwind, so a later
 * attempt arriving while that is standing must not mistake it for authority.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {boolean} [held] - whether the connection already holds `topic`
 * @returns {number} token to hand back on landing
 */
export function beginPendingSubscribe(ud, topic, held = false) {
	let pending = ud[WS_PENDING_SUBSCRIBES];
	if (!pending) pending = ud[WS_PENDING_SUBSCRIBES] = new Map();
	let entry = pending.get(topic);
	if (!entry) {
		entry = { epoch: 0, inflight: 0, granted: held === true };
		pending.set(topic, entry);
	}
	entry.inflight++;
	ud[WS_PENDING_SUBSCRIBES_TOTAL] = (ud[WS_PENDING_SUBSCRIBES_TOTAL] ?? 0) + 1;
	return entry.epoch;
}

/**
 * Close the in-flight subscribe opened with `token`. Returns `true` when the
 * grant may be installed, `false` when a revocation landed mid-await and the
 * grant must be discarded.
 *
 * A settle that finds no entry - the record was dropped at close, or the same
 * token is settled twice - returns false and leaves the total alone, so a stale
 * settle can never hand the connection headroom it has not earned.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @param {boolean} [granted] - pass true on a landing that INSTALLS or
 * confirms fresh membership: it records this attempt as post-revocation
 * authority, so a revoked sibling landing afterwards still reads the grant
 * as current (see {@link settleHeldSubscribe})
 * @returns {boolean}
 */
export function settlePendingSubscribe(ud, topic, token, granted = false) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	if (!pending) return false;
	const entry = pending.get(topic);
	if (!entry) return false;
	if (granted && entry.epoch === token) entry.granted = true;
	if (--entry.inflight <= 0) pending.delete(topic);
	ud[WS_PENDING_SUBSCRIBES_TOTAL] = (ud[WS_PENDING_SUBSCRIBES_TOTAL] ?? 1) - 1;
	return entry.epoch === token;
}

/**
 * Settle an in-flight subscribe whose landing found the topic ALREADY held,
 * answering whether the held membership may be acked.
 *
 * The plain settle cannot answer this branch: it reports only 'was this
 * attempt revoked', but a held membership has a provenance the landing must
 * respect. platform.unsubscribe removes the membership when it tombstones,
 * so a topic held at the landing was installed DURING the await window, by
 * one of two authors:
 *
 * - a fresh post-revoke attempt (a wire/batch subscribe or a
 *   platform.subscribe) whose own authorization completed - current
 *   authority. That attempt marks the topic granted on its way out (the
 *   'granted' flag on the entry, reset by every tombstone), and this
 *   landing must ack; or
 * - the revoked attempt's OWN hook - a plugin join installing tracked
 *   membership in the middle of the authorization the tombstone cancelled.
 *   The tombstone was meant to defeat exactly this, so the membership must
 *   not stand.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @returns {'ack' | 'deny' | 'deny-unwind'}
 *   'ack' - the attempt survived, or a fresh grant was minted after the
 *   revocation; the membership is current authority.
 *   'deny' - the attempt was revoked, but another in-flight attempt still
 *   owns the membership's fate (its own landing re-validates); answer the
 *   denial but leave the membership alone.
 *   'deny-unwind' - the attempt was revoked and no live authority backs
 *   the membership; unwind it ({@link unwindRevokedMembership} plus the app's
 *   unsubscribe hook) before answering the denial.
 */
export function settleHeldSubscribe(ud, topic, token) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	const entry = pending?.get(topic);
	// Unreachable from a lane that enrolled: the entry lives until the last
	// in-flight attempt settles, and this settle is such an attempt. Held
	// membership with no record is current authority, not a revocation.
	if (!entry) return 'ack';
	if (entry.epoch === token) {
		// A live attempt confirmed this membership; record it so a revoked
		// sibling landing afterwards still reads it as current authority.
		entry.granted = true;
		if (--entry.inflight <= 0) pending.delete(topic);
		ud[WS_PENDING_SUBSCRIBES_TOTAL] = (ud[WS_PENDING_SUBSCRIBES_TOTAL] ?? 1) - 1;
		return 'ack';
	}
	const granted = entry.granted === true;
	const last = entry.inflight <= 1;
	if (--entry.inflight <= 0) pending.delete(topic);
	ud[WS_PENDING_SUBSCRIBES_TOTAL] = (ud[WS_PENDING_SUBSCRIBES_TOTAL] ?? 1) - 1;
	if (granted) return 'ack';
	return last ? 'deny-unwind' : 'deny';
}

/**
 * Whether a membership standing for `topic` now is still waiting to be judged:
 * an attempt for the topic is in flight and none has recorded authority. Such a
 * membership was installed inside an attempt's own await window - by its hook
 * (a plugin join), revoked or not - and that attempt's landing, or a sibling's
 * refusal, may still unwind it.
 *
 * Until an attempt confirms it, it is not authority for anything. A subscribe
 * for a held topic must not ack it on sight, or the client is told it holds a
 * membership that may be removed a moment later; and no grant read - the wire
 * gate, the observer lane, the resume filter - may count it, or a client frame
 * mints authority from an install nobody authorized.
 *
 * A topic held when its first attempt enrolled is seeded as authority (see
 * {@link beginPendingSubscribe}), so an ordinary re-subscribe of a settled
 * membership is not caught by this.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @returns {boolean}
 */
export function membershipUnconfirmed(ud, topic) {
	const entry = ud[WS_PENDING_SUBSCRIBES]?.get(topic);
	return entry !== undefined && entry.granted !== true;
}

/**
 * What {@link settleHeldSubscribe} would answer 'ack' to, asked WITHOUT
 * settling: the attempt opened with `token` survived, or a fresh grant was
 * recorded after the revocation, or there is no record at all.
 *
 * The recover lane asks it before serving a topic's replay history. Membership
 * alone cannot answer there: a revoked attempt whose own hook installed the
 * membership would read as held and be served the history, and only then be
 * refused at its landing.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @returns {boolean}
 */
export function heldLandingWouldAck(ud, topic, token) {
	const entry = ud[WS_PENDING_SUBSCRIBES]?.get(topic);
	if (!entry) return true;
	return entry.epoch === token || entry.granted === true;
}

/**
 * Settle an in-flight subscribe whose own authorization DENIED it, answering
 * whether a membership the connection currently holds must be unwound.
 *
 * The denial exit needs its own reading for the same reason the held-ack branch
 * does. {@link settleHeldSubscribe} defers to a sibling attempt ('deny' rather
 * than 'deny-unwind') on the grounds that the sibling's landing re-validates the
 * membership - which is true only of the sibling's SUCCESS path. A sibling whose
 * hook denies returns from here, and if this exit settled blindly, the LAST
 * attempt would leave the tree with a membership installed mid-window by a
 * revoked attempt's own hook still standing, every attempt answered with a
 * denial and nothing left in flight to judge it.
 *
 * Unlike the held-ack branch this never acks and never marks the entry granted -
 * a denied attempt is not authority for anything. The reading is 'does any live
 * authority back this membership', NOT 'was I revoked': the attempt whose hook
 * denies is typically a FRESH post-revocation attempt, so its own token still
 * matches the current epoch while the membership standing was installed by the
 * revoked one. Testing the epoch here would answer 'not revoked' and leave that
 * membership behind.
 *
 * A topic the connection already held when the first attempt enrolled carries
 * that authority on the entry (see {@link beginPendingSubscribe}), so an app
 * hook denying a re-subscribe answers the frame without evicting the standing
 * subscription.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @param {boolean} held - whether the connection currently holds the topic;
 * `false` short-circuits to 'deny' (nothing exists to unwind)
 * @returns {'deny' | 'deny-unwind'}
 *   'deny' - answer the denial and leave membership alone: either nothing is
 *   held, live authority backs the membership, or another attempt is still in
 *   flight to judge it.
 *   'deny-unwind' - the membership is held, this is the last attempt to leave,
 *   and no live authority backs it; unwind before answering the denial.
 */
export function settleDeniedSubscribe(ud, topic, token, held) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	const entry = pending?.get(topic);
	if (!entry) return 'deny';
	const granted = entry.granted === true;
	const last = entry.inflight <= 1;
	if (--entry.inflight <= 0) pending.delete(topic);
	ud[WS_PENDING_SUBSCRIBES_TOTAL] = (ud[WS_PENDING_SUBSCRIBES_TOTAL] ?? 1) - 1;
	if (!held || granted || !last) return 'deny';
	return 'deny-unwind';
}

/**
 * Undo a membership a REVOKED subscribe attempt installed from its own hook -
 * the 'deny-unwind' half of {@link settleHeldSubscribe} and
 * {@link settleDeniedSubscribe}.
 *
 * NOT platform.unsubscribe, on purpose. The tracked primitive removes the
 * logical Set entry, the native membership and the cohort, and charges the
 * shared accounting hook exactly once, without re-entering the app-facing
 * unsubscribe hook. What it deliberately does NOT do is run that hook: the
 * caller does that with its own reference to it, because plugin state (a group
 * roster) only unwinds through it.
 *
 * @param {any} ws
 * @param {string} topic
 */
export function unwindRevokedMembership(ws, topic) {
	releaseDerivedSubscriptions(ws, topic);
	trackedUnsubscribe(ws, topic);
}

/**
 * Platform slot carrying the runtime's app unsubscribe-hook runner, for a
 * deny-unwind exit that lives OUTSIDE the runtime: the observer lane of
 * svelte-adapter-uws's own copy of these helpers (`authorizeDerivedSubscribe`,
 * which its presence and cursor plugins use). That copy has no reference to the
 * app's hooks, so after unwinding a membership it calls this slot on the
 * connection's platform clone, and the runtime runs the hook without the
 * client release queue. A slot per platform rather than per process, so
 * a process holding two servers runs each one's own hook.
 *
 * Signature: `(ws, topic, ud)`, with the caller's already-captured userData.
 */
export const WS_REVOKED_UNSUBSCRIBE = Symbol.for('adapter-uws.platform.revoked-unsubscribe');

/**
 * Topic prefixes under which a plugin establishes a DERIVED subscription on a
 * connection's behalf - a presence roster tap, a cursor position tap - which
 * revoking the base topic has to release too. The plugins keep these taps
 * across a participant leave on purpose and drop them only on close, so a
 * revocation that left them standing would keep feeding a kicked client the
 * roster and the positions it was meant to lose.
 *
 * Plugins register their prefixes with their own copy of svelte-adapter-uws's
 * helpers; the registry is one Set on globalThis under that adapter's
 * `Symbol.for` key, so every copy - and this runtime - reads the same one.
 * This runtime ships no plugin and registers nothing itself.
 *
 * @type {Set<string>}
 */
const DERIVED_PREFIXES_KEY = Symbol.for('adapter-uws.derived-topic-prefixes');
const derivedTopicPrefixes = /** @type {any} */ (globalThis)[DERIVED_PREFIXES_KEY] ?? publishGlobalRegistry(DERIVED_PREFIXES_KEY, new Set());

/**
 * Drop every derived subscription this connection holds for `topic`. A no-op
 * when no plugin registered a prefix, which is the default deployment.
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {void}
 */
export function releaseDerivedSubscriptions(ws, topic) {
	if (derivedTopicPrefixes.size === 0) return;
	for (const prefix of derivedTopicPrefixes) {
		// Skip a topic that IS the derived one, so revoking `__cursor:room`
		// directly cannot recurse into `__cursor:__cursor:room`.
		if (topic.startsWith(prefix)) continue;
		trackedUnsubscribe(ws, prefix + topic);
	}
}

/**
 * Publish a module-eval-time global registry under its `Symbol.for` key
 * without a `[[Set]]`: an accessor on the key would swallow the publication,
 * and each copy would then read back `undefined` and build its own.
 *
 * @template T
 * @param {symbol} key
 * @param {T} registry
 * @returns {T}
 */
function publishGlobalRegistry(key, registry) {
	defineSlot(globalThis, key, registry);
	return registry;
}

/**
 * Whether the in-flight subscribe opened with `token` has been cancelled by a
 * revocation - WITHOUT closing it.
 *
 * {@link settlePendingSubscribe} both answers and closes, which is what the
 * landing wants. A lane that runs BETWEEN the hook await and the landing needs
 * the same answer while leaving the in-flight entry open for the landing to
 * settle: the recover lane is such a lane, and it hands the app's resume hook a
 * topic's replay history, so acting on a grant that has already been revoked
 * serves message history the connection is no longer entitled to.
 *
 * Absent state answers "cancelled", matching what `settlePendingSubscribe`
 * would have returned for it - unknown is not permission.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @param {number} token - the value {@link beginPendingSubscribe} returned
 * @returns {boolean}
 */
export function isPendingSubscribeCancelled(ud, topic, token) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	if (!pending) return true;
	const entry = pending.get(topic);
	if (!entry) return true;
	return entry.epoch !== token;
}

/**
 * Revocation side of {@link beginPendingSubscribe}: bump `topic`'s revocation
 * epoch so every subscribe currently in flight for it discards its grant on
 * landing. Returns `true` when at least one in-flight subscribe was actually
 * cancelled - the truthful "a subscription was removed" answer for a revoke
 * that raced the grant.
 *
 * The in-flight total is deliberately NOT decremented here: those gates are
 * still running, still holding an app hook open, and still have to settle.
 * They stop counting when they do.
 *
 * @param {any} ud - the connection's userData
 * @param {string} topic
 * @returns {boolean}
 */
export function tombstonePendingSubscribe(ud, topic) {
	const pending = ud[WS_PENDING_SUBSCRIBES];
	if (!pending) return false;
	const entry = pending.get(topic);
	if (!entry || entry.inflight <= 0) return false;
	entry.epoch++;
	// A tombstone invalidates every grant recorded before it: only an
	// attempt that completes AFTER this revocation re-marks the entry.
	entry.granted = false;
	return true;
}

/**
 * Platform slots carrying the runtime's shared-fan-out cohort join and leave,
 * for {@link trackedSubscribe} / {@link trackedUnsubscribe}. A tracked
 * subscribe to an already-shared topic must join the matching cohort, and a
 * tracked unsubscribe must leave it and release the wire-id reference, or a
 * plugin that establishes membership server-side misses every cohort-split
 * publish. The cohort registry is runtime state this module cannot import, so
 * the runtime assigns both on its BASE platform object and the per-connection
 * clone in `ud[WS_PLATFORM]` reaches them through the prototype chain - the
 * server that owns the connection answers for it. Keyed by `Symbol.for`, with
 * svelte-adapter-uws's names, so a copy of its helpers reads the same slots.
 *
 * Signature: `(ws, ud, topic)`, run after the registry update, with the
 * caller's already-captured userData. A platform without them changes
 * membership only.
 */
export const WS_COHORT_JOIN = Symbol.for('adapter-uws.platform.cohort-join');
export const WS_COHORT_LEAVE = Symbol.for('adapter-uws.platform.cohort-leave');

// Each surface owns its membership accounting. Returns null for a closed
// handle, otherwise whether native/logical membership was removed.
export const WS_RELEASE_MEMBERSHIP = Symbol.for('adapter-uws.platform.release-membership');

// Logical-subscription accounting has a duplicated-bundle constraint: a plugin
// package can carry its own copy of these helpers (svelte-adapter-uws's, or a
// second copy of this module) while every copy mutates the same connection
// Set. One slot on globalThis is one slot however many copies exist, so every
// add/remove charges the worker's single counter. The key is the one
// svelte-adapter-uws uses, so a copy of its helpers charges this runtime's
// counter too.
const SUBSCRIPTION_ACCOUNTING_HOOK = Symbol.for('adapter-uws.subscription-accounting-hook');

/**
 * Development and test sockets do not belong to a production worker's sink.
 * Remember their registries across bundled copies of the tracked helpers.
 * @returns {Set<string>}
 */
export function createUnaccountedSubscriptionRegistry() {
	const subscriptions = new Set();
	registryStates.set(subscriptions, REGISTRY_UNACCOUNTED);
	return subscriptions;
}

/**
 * Install the worker-local logical-subscription delta sink. The runtime
 * supplies the counter update; focused tests can supply their own. The delta
 * always carries the topic it describes, so a sink can keep a per-topic count
 * beside the worker total.
 *
 * The slot is one `Symbol.for` on globalThis, so every copy of this module in
 * the worker addresses the same sink - which is the point, and also the hazard:
 * an install REPLACES whatever was there, and nothing about that is visible.
 * Two runtimes in one worker each register their own counter at module scope,
 * the second silently takes every delta, and from then on one counter is
 * frozen while the other receives releases for memberships it never charged.
 * That reads downstream as a subscription total drifting under its summed
 * bookkeeping on one side and going negative on the other, with nothing naming
 * the cause. So the install says whether it displaced a DIFFERENT sink, and the
 * caller decides what that is worth reporting.
 *
 * @param {((delta: number, topic: string) => void) | null} onChange
 * @returns {boolean} true when this replaced a different, already-installed sink
 */
export function setSubscriptionAccountingHook(onChange) {
	const next = typeof onChange === 'function' ? onChange : null;
	const previous = /** @type {any} */ (globalThis)[SUBSCRIPTION_ACCOUNTING_HOOK];
	// Only a function displacing a DIFFERENT function is a takeover. Clearing to
	// null is how a test releases the slot, and re-installing the same function
	// is idempotent.
	const displaced = typeof previous === 'function' && next !== null && previous !== next;
	// Defined, not assigned, so an accessor on the key cannot take the hook and
	// leave every subscribe unaccounted while the installer reports success.
	defineSlot(globalThis, SUBSCRIPTION_ACCOUNTING_HOOK, next);
	return displaced;
}

/** @param {number} delta @param {string} topic */
function accountSubscriptionDelta(delta, topic) {
	const hook = /** @type {any} */ (globalThis)[SUBSCRIPTION_ACCOUNTING_HOOK];
	if (typeof hook === 'function') hook(delta, topic);
}

// Registries the close path has already settled. The close path charges every
// still-live membership at once and deliberately leaves the Set POPULATED,
// because that Set is the snapshot handed to the app's close hook - so after it
// runs, "the topic is present" no longer answers "the connection still holds a
// charged membership". A release landing after that point (a plugin leave parked
// in an await, a revocation resuming on a socket that is already gone) would
// otherwise find the topic present, remove it, and charge a membership the close
// already released, pushing the per-worker counter below the truth. Once it is
// below the truth it stays there, and every later audit reports a negative total
// or a summed/total gap that no live membership explains.
//
// A WeakMap keyed on the registry itself: one is created fresh per connection at
// open (`userData[WS_SUBSCRIPTIONS] = new Set()`) and is never reused for another
// connection, so a settled registry is settled for good and nothing accumulates.
//
// Held on globalThis under a `Symbol.for` key, for the same duplicated-bundle
// reason as the accounting hook above - and it is load-bearing here rather than
// defensive. The bundler gives a plugin package and the runtime SEPARATE copies
// of this module while every copy mutates the SAME connection Set, so a mark
// kept in one copy's module binding is invisible to the others. The runtime's
// close would settle the registry in its own copy and a plugin's late
// trackedUnsubscribe, reading a different copy, would find no mark and charge
// the membership a second time - exactly the double charge this exists to
// prevent, surviving in the one configuration that matters.
// The same lookup also excludes nonproduction registries from the worker sink.
// An absent entry means an accounted live registry; unaccounted registries still
// transition to settled on close so late release calls see a closed connection.
const REGISTRY_STATES = Symbol.for('adapter-uws.subscription-registry-states');
const REGISTRY_UNACCOUNTED = 1;
const REGISTRY_SETTLED = 2;

/** @type {WeakMap<Set<string>, number>} */
const registryStates = /** @type {any} */ (globalThis)[REGISTRY_STATES] || publishGlobalRegistry(REGISTRY_STATES, new WeakMap());

/**
 * Add one logical topic exactly once and charge accounting only on growth.
 * A registry the close path already settled still grows, but is not charged -
 * its memberships were released as a whole and there is no live connection for
 * the counter to describe.
 * @param {Set<string>} subscriptions
 * @param {string} topic
 * @returns {boolean} true only when the Set grew
 */
export function addLogicalSubscription(subscriptions, topic) {
	if (subscriptions.has(topic)) return false;
	subscriptions.add(topic);
	if (registryStates.get(subscriptions) === undefined) accountSubscriptionDelta(1, topic);
	return true;
}

/**
 * Remove one logical topic exactly once and charge accounting only on removal.
 * A removal against a registry the close path already settled is not charged;
 * see {@link accountClosedLogicalSubscriptions}.
 * @param {Set<string>} subscriptions
 * @param {string} topic
 * @returns {boolean} true only when the Set shrank
 */
export function removeLogicalSubscription(subscriptions, topic) {
	if (!subscriptions.delete(topic)) return false;
	if (registryStates.get(subscriptions) === undefined) accountSubscriptionDelta(-1, topic);
	return true;
}

/**
 * Whether the close path has already settled this registry - its memberships
 * released as a whole, so the cap-accountant counter no longer describes them.
 *
 * A live connection's registry is never settled. A settled one that is STILL
 * enumerable in the live connection set is a connection whose teardown released
 * its memberships but left it behind, and its topics keep contributing to any
 * summed-bookkeeping total while the counter has already given them up. That is
 * indistinguishable from a double-charged membership by the sum alone, which is
 * why the auditor reports the count separately.
 *
 * @param {unknown} subscriptions
 * @returns {boolean}
 */
export function isSettledSubscriptionRegistry(subscriptions) {
	return subscriptions instanceof Set && registryStates.get(subscriptions) === REGISTRY_SETTLED;
}

/**
 * Charge the still-live logical memberships released by one socket close.
 * The Set is intentionally left intact because it is the documented snapshot
 * passed to the app's close hook; the runtime calls this exactly once after
 * that hook returns.
 *
 * Settles the registry, so a release that lands afterwards charges nothing and
 * a second call releases nothing. Both are ordinary under async plugin cleanup,
 * and both used to charge memberships this call had already released.
 * @param {Set<string>} subscriptions
 * @returns {number} number of memberships released by THIS call
 */
export function accountClosedLogicalSubscriptions(subscriptions) {
	// A non-Set slot is unrecoverable corruption that the shape guards report on
	// their own paths. This one must not turn it into a THROW: the close path
	// calls this from a `finally`, so a raised TypeError would escape the close
	// callback entirely and abandon the rest of the connection's teardown -
	// releasing neither its capability counts nor its wire state. There is also
	// nothing here to release, so releasing nothing is the honest answer.
	if (!(subscriptions instanceof Set)) return 0;
	const states = registryStates;
	const state = states.get(subscriptions);
	if (state === REGISTRY_SETTLED) return 0;
	const count = subscriptions.size;
	states.set(subscriptions, REGISTRY_SETTLED);
	// Released per topic rather than as one summed delta, so the sink's
	// per-topic subscriber counts settle with the total. One cold call per
	// held membership, on the close path only.
	if (state !== REGISTRY_UNACCOUNTED) {
		for (const topic of subscriptions) accountSubscriptionDelta(-1, topic);
	}
	return count;
}

/**
 * Subscribe a socket the way the wire-level subscribe path does: the native
 * call PLUS the connection's subscription registry and its exactly-once
 * accounting delta. The registry is what the platform's per-subscriber walks
 * deliver by, so a plugin that subscribes a socket natively but skips the
 * registry is silently excluded from every stateful-codec binary publish on
 * the topic, and the worker's subscription total never hears of it. Plugins
 * establishing server-side membership (a snapshot handshake, a presence join)
 * use this instead of raw `ws.subscribe`.
 *
 * Returns false when the socket is already closed, or when the connection's
 * subscription registry is already at `MAX_SUBSCRIPTIONS_PER_CONNECTION` for a
 * new topic - the cap the wire and `platform.subscribe` lanes enforce, so a
 * plugin lane cannot grow a connection past it. An already-held topic stays
 * idempotent: no growth, no refusal.
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {boolean}
 */
export function trackedSubscribe(ws, topic) {
	let ud;
	try { ud = ws.getUserData(); } catch { return false; }
	const subs = ud[WS_SUBSCRIPTIONS];
	if (subs instanceof Set && exceedsSubscriptionCap({ held: subs.has(topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return false;
	try { ws.subscribe(topic); } catch { return false; }
	try {
		if (subs instanceof Set) addLogicalSubscription(subs, topic);
		// Join the shared fan-out cohort if the topic is already shared.
		ud[WS_PLATFORM]?.[WS_COHORT_JOIN]?.(ws, ud, topic);
	} catch { /* socket died between the calls; close cleanup owns the registry */ }
	return true;
}

/**
 * Unsubscribe counterpart of {@link trackedSubscribe}: native unsubscribe plus
 * registry removal, so the per-subscriber walks stop delivering the moment
 * native membership ends.
 *
 * @param {any} ws
 * @param {string} topic
 * @returns {boolean} false when the socket was already closed
 */
export function trackedUnsubscribe(ws, topic) {
	let ok = true;
	// Tombstone any in-flight subscribe for this topic FIRST, exactly as
	// platform.unsubscribe does. A plugin leave / evict path is a revocation
	// too: a subscribe still parked in its authorization await would otherwise
	// land afterwards and re-install the membership this call just removed,
	// leaving the socket subscribed to a topic it was evicted from. A no-op
	// (returning false) when nothing is in flight, which is the ordinary case.
	try { tombstonePendingSubscribe(ws.getUserData(), topic); }
	catch { /* socket already closed - nothing in flight to cancel */ }
	try { ws.unsubscribe(topic); } catch { ok = false; }
	try {
		const ud = ws.getUserData();
		if (ud[WS_PUBLISH_GRANT] === topic) ud[WS_PUBLISH_GRANT] = undefined;
		const subs = ud[WS_SUBSCRIPTIONS];
		if (subs instanceof Set) removeLogicalSubscription(subs, topic);
		// Leave the shared fan-out cohort (drop both cohort subscriptions and
		// release the wire-id reference) if the topic is shared, so the socket
		// stops receiving cohort publishes.
		ud[WS_PLATFORM]?.[WS_COHORT_LEAVE]?.(ws, ud, topic);
	} catch { /* socket died; close cleanup owns the registry */ }
	return ok;
}

/**
 * Remove admitted membership without cancelling independent subscribe awaits.
 * Framework rollback owns its application cleanup and does not run the app's
 * unsubscribe hook. Explicit revocation still uses trackedUnsubscribe or
 * platform.unsubscribe, which advance the pending attempt's epoch.
 * @param {any} ws
 * @param {string} topic
 * @returns {boolean} whether any membership or publish grant was removed
 */
export function releaseSubscription(ws, topic) {
	let ud;
	try { ud = ws.getUserData(); } catch { return false; }
	const subs = ud[WS_SUBSCRIPTIONS];
	if (!(subs instanceof Set) || isSettledSubscriptionRegistry(subs)) return false;
	let removed = releaseMembership(ws, ud, topic);
	for (const prefix of derivedTopicPrefixes) {
		if (topic.startsWith(prefix)) continue;
		if (releaseMembership(ws, ud, prefix + topic)) removed = true;
	}
	return removed;
}

/** @param {any} ws @param {any} ud @param {string} topic */
function releaseMembership(ws, ud, topic) {
	// Withdraw completed authority without changing the epoch that an
	// independently pending authorization must present when it lands.
	const pending = ud[WS_PENDING_SUBSCRIBES]?.get(topic);
	if (pending) pending.granted = false;
	const release = ud[WS_PLATFORM]?.[WS_RELEASE_MEMBERSHIP];
	let removed;
	if (typeof release === 'function') {
		removed = release(ws, ud, topic);
		if (removed === null) return false;
	} else {
		try { ws.unsubscribe(topic); } catch { return false; }
		removed = removeLogicalSubscription(ud[WS_SUBSCRIPTIONS], topic);
	}
	if (ud[WS_PUBLISH_GRANT] === topic) {
		ud[WS_PUBLISH_GRANT] = undefined;
		removed = true;
	}
	ud[WS_PLATFORM]?.[WS_COHORT_LEAVE]?.(ws, ud, topic);
	return removed;
}

/**
 * Write a slot onto an object the application can reach, without consulting
 * the prototype chain. For the one-off targets - `globalThis`, a hook function
 * the app supplied - where the write happens once per process or once per
 * registration.
 *
 * Own, writable, enumerable and configurable: the same shape a plain
 * assignment would have produced, so nothing downstream that copies, spreads
 * or enumerates the target sees a different object than before.
 *
 * @param {object | Function} target
 * @param {string | symbol} key
 * @param {unknown} value
 */
export function defineSlot(target, key, value) {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

export async function authorizeDerivedSubscribe(ws, topic, authorize) {
	let ud;
	try { ud = ws.getUserData(); } catch { return false; }
	const subs = ud[WS_SUBSCRIPTIONS];
	// Bounded like every other lane that parks in authorization. This one is
	// client-triggered too (a presence sync or cursor snapshot frame runs the
	// app's authorization chain through it), so leaving it unbounded would
	// keep the whole budget bypassable - and because it shares the counter,
	// an unbounded derived lane would also starve the connection's own wire
	// subscribes. Refusing the tap is the established failure here: every
	// other refusal on this path returns false too.
	if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(ud), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) return false;
	const token = beginPendingSubscribe(ud, topic, subs instanceof Set && subs.has(topic));
	let denied = true;
	try {
		denied = Boolean(await authorize());
	} catch {
		denied = true;
	}
	if (denied) {
		if (settleDeniedSubscribe(ud, topic, token, subs instanceof Set && subs.has(topic)) === 'deny-unwind') {
			unwindRevokedMembership(ws, topic);
			ud[WS_PLATFORM]?.[WS_REVOKED_UNSUBSCRIBE]?.(ws, topic, ud);
		}
		return false;
	}
	// Allow path. A topic HELD at this landing closes the enrolment through
	// the held-provenance read instead of the plain settle, for the same
	// reason the surface lanes' held branches do: the plain settle answers
	// only 'was this attempt revoked', and a revoked answer must still decide
	// what happens to the standing membership. settleHeldSubscribe's 'deny'
	// deferral hands that decision to the LAST in-flight attempt - which can
	// be this lane, when a revoked wire sibling's hook installed the
	// membership and its landing deferred here. Settling plain at this exit
	// refused the tap and walked away: revocation honored on paper, socket
	// still subscribed to the base topic until disconnect. An 'ack' means
	// current authority backs the membership (it predates every attempt, or
	// a re-grant landed after the revocation), so the tap may install.
	if (subs instanceof Set && subs.has(topic)) {
		const verdict = settleHeldSubscribe(ud, topic, token);
		if (verdict === 'ack') return true;
		if (verdict === 'deny-unwind') {
			unwindRevokedMembership(ws, topic);
			ud[WS_PLATFORM]?.[WS_REVOKED_UNSUBSCRIBE]?.(ws, topic, ud);
		}
		return false;
	}
	// settlePendingSubscribe closes the enrolment AND reports whether this
	// subscribe survived: false means a revocation bumped the epoch while the
	// authorization was parked.
	return settlePendingSubscribe(ud, topic, token);
}

export function markSideEffectHooks(hooks, names) {
	for (const name of names) {
		if (typeof hooks?.[name] === 'function') defineSlot(hooks[name], HOOK_SIDE_EFFECT_ONLY, true);
	}
	return hooks;
}

export function registerDerivedTopicPrefix(prefix) {
	if (typeof prefix === 'string' && prefix.length > 0) derivedTopicPrefixes.add(prefix);
}

export function heldSubscribeIsAuthorized(ud, topic, token) {
	return !membershipUnconfirmed(ud, topic)
		|| (isPluginOwnedTopic(topic) && heldLandingWouldAck(ud, topic, token));
}
