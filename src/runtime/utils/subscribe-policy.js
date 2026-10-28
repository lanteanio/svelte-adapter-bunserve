/**
 * The wire-subscribe authorization decisions, as pure functions of explicit
 * inputs.
 *
 * WHY THIS MODULE EXISTS. The grant model answers the same question from four
 * places - the single subscribe lane, the batch lane, the recover fall-through
 * and the observer gate behind `platform.checkSubscribe({ requireGrant })` -
 * and the four do not agree by construction. Spelling each one inline is how
 * they come to disagree about one topic: the lanes differ in what they have
 * already done to the subscription set by the time they ask, so the same
 * intent reads as `!isNew` in one and `subs.has(topic)` in another, and
 * nothing states what they should agree on.
 *
 * A decision here is a pure function of named inputs: no socket, no userData,
 * no I/O, nothing to mock. Each lane still owns its own effects, but none of
 * them invents its own answer.
 *
 * The predicates are the ones svelte-adapter-uws decides these lanes with, in
 * its spelling, so an app moving between the two adapters is judged the same
 * way. Adding a decision here is cheap; re-deriving one inline in a lane is
 * the defect this module exists to make impossible.
 */


const OWNED_PREFIXES_KEY = Symbol.for('adapter-uws.plugin-owned-topic-prefixes');
if (!Object.hasOwn(globalThis, OWNED_PREFIXES_KEY)) {
 Object.defineProperty(globalThis, OWNED_PREFIXES_KEY, { value: new Set(), configurable: true });
}
const pluginOwnedPrefixes = globalThis[OWNED_PREFIXES_KEY];

/** Register a bounded system-topic namespace owned by an application plugin. */
export function registerPluginOwnedPrefix(prefix) {
 if (typeof prefix !== 'string') throw new TypeError('Plugin topic prefix must be a string');
 if (prefix.length < 4 || prefix.length > 64 || !/^__[A-Za-z][A-Za-z0-9_-]*:$/.test(prefix)) {
  throw new Error('Plugin topic prefix must be __<namespace>:, between 4 and 64 characters');
 }
 pluginOwnedPrefixes.add(prefix);
}

/** Whether a shared plugin registry owns this system topic. */
export function isPluginOwnedTopic(topic) {
 if (typeof topic !== 'string') return false;
 for (const prefix of pluginOwnedPrefixes) if (topic.startsWith(prefix)) return true;
 return false;
}

/**
 * The registry key a hook carries to say it observes a subscribe rather than
 * deciding it.
 *
 * Spelled with the family's `adapter-uws` prefix deliberately, and not renamed
 * for this package: `Symbol.for` reads one process-wide registry, and the
 * marking is done by the PLUGIN, not by the adapter it happens to be running
 * on. A presence or groups plugin marks its own exported `subscribe` once, and
 * both adapters have to recognize that one key or the mark is invisible to
 * whichever of them chose a different string.
 */
export const HOOK_SIDE_EFFECT_ONLY = Symbol.for('adapter-uws.hook.side-effect-only');

/**
 * Whether `fn` is a hook that can make an authorization DECISION, as opposed to
 * a plugin side effect that merely observes the subscribe.
 *
 * The grant gate stands aside for an app that exports its own subscribe hook,
 * on the reasoning that an app which took over the topic decision owns it. A
 * PLUGIN hook is not that: a presence `subscribe` joins a roster and returns no
 * opinion on every path, so it denies nothing - yet exporting it, which is the
 * documented wiring, would satisfy the same test and disarm the very gate the
 * plugin's own observer lane relies on. Arming the gate and following the
 * plugin's README would then give no enforcement at all.
 *
 * A marked hook still RUNS, exactly as before; it just does not count as the
 * app taking over authorization. An app that WRAPS a plugin hook in its own
 * function is deliberately not marked - the wrapper is app code that may
 * decide, so the gate steps aside as documented.
 *
 * @param {unknown} fn
 * @returns {boolean}
 */
export function isAuthorizationHook(fn) {
	return typeof fn === 'function' && /** @type {any} */ (fn)[HOOK_SIDE_EFFECT_ONLY] !== true;
}

/**
 * Whether a wire `subscribe` must be refused BEFORE the app's hook chain runs.
 *
 * `armed` is the grant gate; `held` is "this connection was already authorized
 * for this topic by the server", which under the grant model is the whole
 * question. An app that exports its own subscribe hook decides every topic
 * itself, so the gate stands aside for it - unless strict mode is latched, in
 * which case the caller passes `hasUserHook: false` and both authorities are
 * required.
 *
 * The plugin-owned carve-out is safe only because
 * {@link deniesWireSubscribeLanding} re-tests real membership when the hook
 * lands. Do not copy this exemption into a lane with no landing re-check
 * behind it.
 *
 * @param {object} input
 * @param {boolean} input.armed - `authorizeWireSubscribe` is on
 * @param {boolean} input.hasUserHook - the app exports its own subscribe hook
 * @param {boolean} input.held - the connection already holds this topic
 * @param {string} input.topic
 * @returns {boolean} true when the frame must be refused before any hook runs
 */
export function deniesWireSubscribePreHook({ armed, hasUserHook, held, topic }) {
	if (!armed || hasUserHook) return false;
	if (held) return false;
	if (isPluginOwnedTopic(topic)) return false;
	return true;
}

/**
 * Whether a wire `subscribe` must be refused when its authorization LANDS.
 *
 * Deliberately carries no plugin-owned carve-out. This is the second line of
 * defence that makes the pre-hook exemption safe, so exempting a namespace
 * here too would leave the exemption as the entire gate: a plugin that
 * authorizes a topic without actually subscribing the socket is refused here.
 *
 * The grant can also disappear underneath an in-flight subscribe - a revoke
 * landing while the app's hook is awaited - so the question is asked again
 * against the set as it stands after the awaits, not as it stood before them.
 *
 * @param {object} input
 * @param {boolean} input.armed
 * @param {boolean} input.hasUserHook
 * @param {boolean} input.held - the connection holds the topic NOW, after the awaits
 * @param {string} input.topic
 * @returns {boolean}
 */
export function deniesWireSubscribeLanding({ armed, hasUserHook, held, topic }) {
	if (isPluginOwnedTopic(topic)) return !held;
	if (!armed || hasUserHook) return false;
	return !held;
}

/**
 * Whether this frame asked for a gap-fill the server can actually serve.
 *
 * Load-bearing beyond its size: a socket that turns out to be subscribed while
 * its authorization was parked is NOT caught up, because live membership
 * carries no history.
 *
 * @param {object} input
 * @param {unknown} input.hasResumeHook - the app exports a `resume` hook
 * @param {any} input.recover - the frame's `recover` member
 * @returns {boolean}
 */
export function wantsRecover({ hasResumeHook, recover }) {
	return Boolean(hasResumeHook)
		&& Boolean(recover) && typeof recover === 'object'
		&& Number.isInteger(recover.offset) && recover.offset >= 0;
}

/**
 * A subscribe asking for HISTORY with no way to receive the answer.
 *
 * The family's ack policy is deliberate silence for a ref-less subscribe - the
 * client said it would not listen - but the recover lane is the one request
 * whose reply the client MUST correlate: a caller replaying an offset and
 * assuming it took, when the gate or a denial swallowed it, resumes into a
 * silent gap. The family client refs every path, so this is reachable only by a
 * third-party client, and a third-party client asking for history without a
 * correlation handle is a bug worth failing loudly. Refused with the
 * uncorrelatable-error shape ({@link recoverRequiresRefFrame}) BEFORE any gate
 * or hook can swallow it.
 *
 * Only when recover would actually engage: with no resume hook there is no
 * history to miss, and a malformed recover object is ignored exactly as
 * {@link wantsRecover} ignores it on the recover lane itself.
 *
 * @param {{ hasResumeHook: unknown, recover: unknown, ref: number | string | null }} args
 * @returns {boolean}
 */
export function deniesRefLessRecover({ hasResumeHook, recover, ref }) {
	return ref === null && wantsRecover({ hasResumeHook, recover });
}

/** Refuse any recoverable batch entry without a correlation ref. */
export function deniesRefLessRecoverBatch({ hasResumeHook, recover, ref }) {
 return ref === null && recover !== null && typeof recover === 'object'
  && Object.values(recover).some(entry => wantsRecover({ hasResumeHook, recover: entry }));
}

/**
 * The uncorrelatable error frame answering a ref-less recover subscribe, in the
 * established shape for frames that answer for no correlatable request (the
 * control-frame-limit refusal is the pattern). Carries the topic so a developer
 * reading a client log can see which request died.
 *
 * @param {string | null} topic
 * @returns {string}
 */
export function recoverRequiresRefFrame(topic) {
	return '{"type":"error","code":"RECOVER_REQUIRES_REF","topic":' + JSON.stringify(topic) + '}';
}

/**
 * Whether the recover lane must refuse to serve a topic's replay history.
 *
 * MEMBERSHIP FIRST. A revocation mark only ever rises, so consulting it alone
 * can never see a revoke followed by a legitimate re-grant inside one await
 * window: the gap-fill would be refused forever while the subscription was
 * acked, which is a positive ack with a silently dropped replay. Reading the
 * mark only when the socket does NOT hold the topic makes the re-grant
 * visible, because a re-grant is exactly what puts the topic back.
 *
 * Reached before the landing check, so a plugin-owned topic whose hook did not
 * actually join must be stopped here too - otherwise it receives replay
 * history and is only then denied.
 *
 * @param {object} input
 * @param {boolean} input.held - the connection holds the topic now
 * @param {boolean} input.wireAuthz - armed AND no app subscribe hook deciding
 * @param {boolean} input.cancelled - a revocation bumped this subscribe's mark
 * @param {string} input.topic
 * @returns {boolean} true when the history must NOT be served
 */
export function recoverIsRevoked({ held, wireAuthz, cancelled, topic }) {
	return !held && (isPluginOwnedTopic(topic) || wireAuthz || cancelled);
}

/**
 * Whether a per-connection subscription cap refuses this subscribe.
 *
 * Scoped to a topic the socket does not already hold: the recover fall-through
 * can reach the cap check with the topic already a membership, and refusing
 * there answers RATE_LIMITED to a connection that is not growing at all.
 *
 * @param {object} input
 * @param {boolean} input.held
 * @param {number} input.size - current subscription count, plus whatever the
 *   caller counts against the cap beside it
 * @param {number} input.max
 * @returns {boolean}
 */
export function exceedsSubscriptionCap({ held, size, max }) {
	if (held) return false;
	// A missing or non-numeric cap REFUSES. Every comparison against `undefined`
	// is false, so a bare `size >= max` answers "not at the cap" for a caller
	// that forgot the argument - silently removing the per-connection limit
	// rather than failing. Refusing is loud and survivable; admitting without a
	// bound is neither.
	if (typeof max !== 'number' || Number.isNaN(max)) return true;
	return size >= max;
}

/**
 * Whether an observer-lane gate (`platform.checkSubscribe` with
 * `requireGrant`) must refuse `topic` before the app's hook chain is even
 * consulted.
 *
 * The `hasUserHook` term mirrors the wire gate exactly. An app that exports
 * its own subscribe hook is documented as deciding every topic itself, so
 * hard-denying before that hook runs would break the snapshot lanes for
 * precisely the apps that took control of authorization.
 *
 * NO plugin-owned exemption here, deliberately. This predicate answers for
 * lanes that have no second line of defence - the observer gate and the
 * client-named resume filter, where the filter IS the gate. Exempting a
 * prefix here would serve a private namespace's buffered history to any
 * client that simply named it: refused on the live-subscribe path and served
 * on the history path, same server, same connection, same topic. Nothing is
 * lost by the omission, because a client a plugin legitimately admitted is in
 * the subscription set by then and passes the grant test on its own.
 *
 * @param {boolean} armed - the grant gate is on
 * @param {boolean} hasUserHook - app exports a subscribe / subscribeBatch hook
 * @param {unknown} grants - the connection's subscription set
 * @param {string} topic
 * @returns {boolean} true when the gate must deny
 */
export function deniesUngrantedObserve(armed, hasUserHook, grants, topic) {
	if (!armed || hasUserHook) return false;
	return !(grants instanceof Set) || !grants.has(topic);
}

export function carriesPreParsedEnvelope(parsed) {
	return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
}

export function deniesWireSystemTopicSubscribe({ allowSystem, topic }) {
	if (allowSystem || typeof topic !== 'string') return false;
	if (topic.charCodeAt(0) !== 95 || topic.charCodeAt(1) !== 95) return false;
	return !isPluginOwnedTopic(topic);
}

export function exceedsPendingSubscribeCap({ pending, max }) {
	// Fail closed on a missing cap, same reasoning as exceedsSubscriptionCap.
	if (typeof max !== 'number' || Number.isNaN(max)) return true;
	// The count too, unlike the landed cap's `size`: that one reads a Set the
	// callers already guard, while this one reads a userData slot reachable
	// through its published `Symbol.for` key. A non-numeric value would make
	// every comparison false and silently remove the bound.
	if (typeof pending !== 'number' || Number.isNaN(pending)) return true;
	return pending >= max;
}
