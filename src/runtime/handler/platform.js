/**
 * The `platform` object handed to every WebSocket hook and to server-side app
 * code. This is the JSON realtime surface: topic fan-out, per-connection send,
 * brokered subscribe/unsubscribe, and the observability getters.
 *
 * What is deliberately NOT here yet: the binary wire members
 * (publishWire/sendWire and their batch variants, the codec registry, cohort
 * split, resume/seq buffers) and the pressure/protection surface. Those are
 * their own slices. They are omitted rather than stubbed - a zero stub reports
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
import {
	MAX_SUBSCRIPTIONS_PER_CONNECTION,
	WS_PLATFORM,
	WS_SUBSCRIPTIONS,
	beginPendingSubscribe,
	getServer,
	hasGateHeadroom,
	pendingSubscribeTopics,
	settlePendingSubscribe,
	withGateCounted,
	stampSeq,
	tombstonePendingSubscribe,
	wsConnections,
	wsCounters
} from './ws-state.js';
import { allow_unauthenticated_subscribe, ws_compression_on, ws_options } from './config.js';

/** Throws from the app's subscribe hook, throttled with decay. */
const subscribeThrewThrottle = createLogThrottle(() => performance.now());

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
 * Anything else is UNREADABLE and fails closed. Allowing it instead is the
 * fail-open this reached for first: a hook written
 * `return allowed[topic] ? null : 403`, or one that returns a lookup promise
 * without `await`, denies nothing and hands the client every topic it can
 * name. The batch lane has always refused those values, so the identical hook
 * logic denied through `subscribeBatch` and allowed through `subscribe`;
 * `isReadableVerdict` is now the one answer both lanes get.
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
		wsCounters.publishCount++;
		const seq = stampSeq(options, topic);
		// A de-herd window is carried verbatim so each client rolls its own
		// delay. Rolling one server-side offset instead would defer every
		// subscriber of this frame by the SAME amount, which is the stampede
		// the option exists to prevent.
		const jitterMs = options && typeof options.jitterMs === 'number' && options.jitterMs > 0
			? options.jitterMs
			: null;
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq, jitterMs);
		const compress = ws_compression_on && (!options || options.compress !== false);
		const result = getServer().publish(topic, envelope, compress);
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
		// gets the close: this used to return before the loop, so
		// `adviseReconnect({ close: true })` was a silent no-op - zero advised,
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
		return true;
	},

	/** Live connections on THIS instance. */
	get connections() {
		return wsConnections.size;
	},

	/**
	 * Sum of every live connection's subscription count on this instance.
	 *
	 * Maintained on the subscribe/unsubscribe/close paths, so it was being paid
	 * for on a hot path with nothing able to read it until this getter existed.
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
	 * close-hook fallback: their hook still ran, but if it did not perform the
	 * teardown, nothing else will.
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
 * able to supply one can install a subscription the app never authorized. Every
 * previous spelling put it somewhere a caller could reach: a string key on the
 * options bag, then a Symbol on the same bag (forgeable by a Proxy with a
 * catch-all `get`), then a fourth positional parameter of `platform.subscribe`
 * itself - where `topics.map(platform.subscribe.bind(platform, ws))` supplied
 * the array as a verdict and quietly allowed every topic.
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
	// it - correct for what can install, useless as a bound on app work.
	// Before this existed, a socket repeating one topic opened a fresh gate
	// call per frame with nothing to stop it.
	if (!hasGateHeadroom(ws)) return 'RATE_LIMITED';

	const token = beginPendingSubscribe(userData, topic);
	let denial;
	try {
		denial = await withGateCounted(ws, () => runSubscribeGate(ws, topic, verdict));
	} catch (err) {
		settlePendingSubscribe(userData, topic, token);
		throw err;
	}
	const stillWanted = settlePendingSubscribe(userData, topic, token);
	// Explicit nullish test, NOT truthiness. checkSubscribe classifies any
	// string the hook returns as a denial reason, including the empty
	// string - which a hook produces naturally from a lookup miss
	// (`DENY_REASONS[topic] ?? ''`). Under truthiness that denial fell
	// through to the install below and the client got a `subscribed` ack for
	// a topic the app meant to refuse.
	if (denial !== null && denial !== undefined) return denial;
	if (!stillWanted) return 'CANCELLED';

	// Re-check after the await: a duplicate subscribe may have landed and
	// completed while this one was in the gate.
	if (subs.has(topic)) return null;
	// And re-check the cap, for the same reason it counts in-flight above:
	// this gate entered when there was headroom, and any number of others
	// may have landed while it was awaiting. The pre-gate check bounds how
	// many hooks run at once; this one bounds what actually installs.
	if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
	try {
		ws.subscribe(topic);
	} catch {
		wsCounters.closedWsAborts++;
		return 'CLOSED';
	}
	subs.add(topic);
	wsCounters.totalSubscriptions++;
	return null;
}