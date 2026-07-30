/**
 * The WebSocket connection lifecycle and the built-in JSON control demux.
 *
 * These are the `websocket: { open, message, drain, close }` handlers passed to
 * `Bun.serve`. They do IO and apply decisions; every decision that can be pure
 * is (utils/topic.js, utils/envelope.js, utils/send-result.js), which is what
 * keeps the ordering-sensitive parts testable without a socket.
 *
 * Wire protocol, client to server (all JSON text frames):
 *   {"type":"subscribe","topic":"t","ref":N?}
 *   {"type":"unsubscribe","topic":"t","ref":N?}
 *   {"type":"subscribe-batch","topics":["a","b"],"ref":N?}
 * Server to client:
 *   {"type":"welcome","sessionId":"..."}
 *   {"type":"subscribed","topic":"t","ref":N,"epoch":E}
 *   {"type":"subscribe-denied","topic":"t","ref":N,"reason":"..."}
 *   {"type":"unsubscribed","topic":"t","ref":N}
 *   {"type":"unsubscribe-denied","topic":"t","ref":N,"reason":"..."}
 *   {"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":L,"size":N}
 *   {"type":"error","code":"BATCH_TOO_LARGE","limit":L,"size":N}
 *   {"type":"error","code":"CONTROL_FLOOD","limit":B}
 *
 * A `subscribe-batch` is answered PER ENTRY, with the same `subscribed` /
 * `subscribe-denied` frames a single subscribe produces. That is not an
 * accident: the family client keys its denial store and its per-topic
 * subscription epochs off those frames, and it re-subscribes everything as a
 * batch on every reconnect - so a summary frame it does not recognise silently
 * loses every denial and degrades resume.
 *
 * Per-entry answers ARE an amplifier, so two separate things bound them: the
 * batch itself is refused whole past MAX_BATCH_TOPICS, which stops the frame
 * count scaling with the inbound frame rather than with the limit, and the ack
 * CHANNEL is budgeted per connection. See sendControl and
 * bench/control-egress.mjs.
 *
 * Control frames must carry `type` as the FIRST key. JSON defines no key order,
 * so this is a real requirement rather than an accident of JSON.stringify:
 * recognising a reordered key costs a scan on the path every inbound frame
 * takes, measured at 21-27 ns/frame against 4.1-4.8 ns for the character
 * compare in utils/control-frame.js. See bench/control-frame-prefix.mjs. Every
 * client in the family emits `type` first.
 *
 * Acks are sent only when the client supplied a `ref`. That keeps the frame
 * count at zero for fire-and-forget clients while letting a client that wants
 * confirmation correlate one.
 */

import { wsFacade } from './ws-facade.js';
import { bumpIn, bumpOut, closeHookRegistered } from './ws-stats.js';
import { platform, runBatchGate, subscribeWithVerdict } from './platform.js';
import { wsModule } from '../ws-handler-bridge.js';
import { isSystemTopic, isValidWireTopic } from '../utils/topic.js';
import {
	isEchoableRef,
	subscribeDeniedFrame,
	subscribedFrame,
	unsubscribeDeniedFrame,
	unsubscribedFrame
} from '../utils/ack-frame.js';
import { createLogThrottle } from '../utils/log-throttle.js';
import { SEND_DROPPED } from '../utils/send-result.js';
import {
	CONTROL_FLOOD_CLOSE_CODE,
	CONTROL_FRAME_LIMIT,
	MAX_BATCH_TOPICS,
	batchTooLargeFrame,
	controlFloodFrame,
	controlFrameTooLargeFrame,
	isConsumedControlType,
	looksLikeControlFrame
} from '../utils/control-frame.js';
import {
	WS_PENDING_SUBSCRIBES,
	WS_PLATFORM,
	WS_REQUEST_ID_KEY,
	WS_SESSION_ID,
	WS_STATS,
	MAX_CONTROL_EGRESS_BYTES,
	WS_SUBSCRIPTIONS,
	chargeControlEgress,
	clearUnsubscribeHooks,
	hasGateHeadroom,
	heldSubscriptions,
	runUnsubscribeHook,
	trackCloseHook,
	withGateCounted,
	processEpoch,
	wsConnections,
	wsCounters
} from './ws-state.js';
import { allow_non_ascii_topics, allow_system_topic_subscribe } from './config.js';


/**
 * @param {string} name
 * @param {unknown} err
 */
function reportHookError(name, err) {
	// Throttled: a hook that throws on client-shaped input throws on every
	// frame, and a client can loop that frame. See utils/log-throttle.js.
	let throttle = hookErrorThrottles.get(name);
	if (!throttle) {
		throttle = createLogThrottle(() => performance.now());
		hookErrorThrottles.set(name, throttle);
	}
	const { log, count } = throttle();
	if (!log) return;
	const suffix = count > 1 ? ` (occurrence ${count})` : '';
	console.error(`[ws] the ${name} hook threw; the connection was left open${suffix}:`, err);
}

/** Per-hook throttles. Bounded by the fixed set of hook names. */
const hookErrorThrottles = new Map();

/**
 * Run an app hook so a throw cannot take the connection (or the process) with
 * it. `message` is invoked from an async handler whose promise nothing
 * consumes, so an unguarded throw there surfaces as an unhandled rejection
 * while the same throw from `open` propagates synchronously - identical app
 * code failing two different ways depending on which hook it sat in.
 *
 * Returns the hook's promise when it had one (already guarded against
 * rejection), so a caller that needs to know when the hook actually FINISHED
 * can wait for it. The shutdown drain is the one caller that does.
 *
 * @param {string} name
 * @param {() => any} fn
 * @returns {Promise<void> | undefined}
 */
function callHook(name, fn) {
	try {
		const result = fn();
		if (result && typeof result.catch === 'function') {
			return result.catch((/** @type {unknown} */ err) => reportHookError(name, err));
		}
	} catch (err) {
		reportHookError(name, err);
	}
	return undefined;
}

/**
 * Send a control frame, charging a closed socket to the closed lane. Control
 * frames are never compressed: they are short, and deflating them costs more
 * than it saves.
 * @param {any} ws
 * @param {string} payload
 */
function sendControl(ws, payload) {
	// Per-connection egress budget for the ACK CHANNEL. Per-entry acks are
	// what the family client needs (it keys denials and epochs off them, and
	// it re-subscribes everything as a batch on every reconnect), but they are
	// also unavoidably an amplifier: a short batch entry buys a whole frame,
	// and the entries that answer fastest cost the server nothing. The batch
	// size limit bounds the frame COUNT per inbound frame; this bounds the
	// bytes over time, which is the part a client can still drive by sending
	// many legal frames. Both are needed - see bench/control-egress.mjs, which
	// measures the worst-shaped legal frame as well as the ordinary one.
	if (!chargeControlEgress(ws, Buffer.byteLength(payload))) {
		refuseControlFlood(ws);
		return;
	}
	let result;
	try {
		result = ws.send(payload, false, false);
	} catch {
		wsCounters.closedWsAborts++;
		return;
	}
	// Only bytes that reached the wire, like platform.send. A frame refused
	// past the backpressure limit never went out.
	if (result !== SEND_DROPPED) bumpOut(ws, payload);
}

/**
 * Cut a connection that has blown its control-frame budget.
 *
 * Sent once and directly, bypassing the budget it just exhausted, so the client
 * learns why rather than seeing a bare close. See CONTROL_FLOOD_CLOSE_CODE for
 * why the cut is 4429 rather than the 1008 this reached for first.
 *
 * @param {any} ws
 */
function refuseControlFlood(ws) {
	try {
		if (ws._controlFloodSignalled) return;
		ws._controlFloodSignalled = true;
		ws.send(controlFloodFrame(MAX_CONTROL_EGRESS_BYTES), false, false);
		ws.end(CONTROL_FLOOD_CLOSE_CODE, 'control frame budget exhausted');
	} catch {
		wsCounters.closedWsAborts++;
	}
}

/** Unsubscribe backlogs, throttled with decay: a client controls how many. */
const unsubOverflowThrottle = createLogThrottle(() => performance.now());

/**
 * A connection whose unsubscribe hooks backed up past the queue.
 *
 * Worth a line even though the teardown is not lost: reaching it means the app's
 * `unsubscribe` hook is slower than the rate at which one client releases
 * topics, which is a property of the app rather than of the traffic.
 */
function warnUnsubscribeOverflow() {
	const { log: logIt, count } = unsubOverflowThrottle();
	if (!logIt) return;
	const suffix = count > 1 ? ` (occurrence ${count})` : '';
	console.warn(
		`[ws] a connection queued more unsubscribe hooks than it may hold and was closed${suffix}. ` +
		'Its close hook still runs with the full subscription set, so the app can release ' +
		'everything there. Raise `websocket: { maxConcurrentUnsubscribeHooks }` if the hook is ' +
		'legitimately slow, or make it cheaper.'
	);
}

/**
 * @param {any} ws
 * @param {string} topic
 * @param {number | string | null} ref
 */
function sendSubscribed(ws, topic, ref) {
	if (ref === null) return;
	sendControl(ws, subscribedFrame(topic, ref, processEpoch()));
}

/**
 * @param {any} ws
 * @param {string} topic
 * @param {number | string | null} ref
 * @param {string} reason
 */
function sendSubscribeDenied(ws, topic, ref, reason) {
	if (ref === null) return;
	sendControl(ws, subscribeDeniedFrame(topic, ref, reason));
}

/**
 * Refuse an unsubscribe the wire validation rejected.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {number | string | null} ref
 * @param {string} reason
 */
function sendUnsubscribeDenied(ws, topic, ref, reason) {
	if (ref === null) return;
	sendControl(ws, unsubscribeDeniedFrame(topic, ref, reason));
}


/**
 * Wire-level topic validation, shared by every path that accepts a topic from a
 * client. Cheap and synchronous: it runs before any app work, which is what
 * makes rejections free for the server and therefore worth collapsing in a
 * batch rather than answering one frame at a time.
 *
 * @param {unknown} topic
 * @returns {boolean} true when the topic must be refused
 */
function isWireTopicRejected(topic) {
	if (typeof topic !== 'string') return true;
	if (!isValidWireTopic(topic, allow_non_ascii_topics)) return true;
	if (!allow_system_topic_subscribe && isSystemTopic(topic)) return true;
	return false;
}

/**
 * Apply one subscribe request: validate, authorize, subscribe, ack.
 *
 * The batch path does NOT come through here: it needs the already-held
 * short-circuit and the one-call batch gate, both of which sit above the
 * per-entry work. This is the single-subscribe spelling, so there is no
 * pre-obtained verdict to pass on.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {number | string | null} ref
 * @returns {Promise<void>}
 */
async function applySubscribe(ws, topic, ref) {
	if (isWireTopicRejected(topic)) {
		sendSubscribeDenied(ws, topic, ref, 'INVALID_TOPIC');
		return;
	}
	settleSubscribeResult(ws, topic, ref, await gatedSubscribe(ws, topic));
}

/**
 * Hand one already-wire-validated topic to the platform.
 *
 * ALL the authorization lives behind this call: platform.subscribe owns the
 * cap, the gate, the in-flight epoch that keeps an unsubscribe from being
 * overtaken, and the bookkeeping. The demux owns only wire validation and the
 * reply. Running the batch gate out here instead would put it outside the
 * in-flight accounting, letting one connection open thousands of concurrent
 * gate calls, and outside the already-subscribed short-circuit, so re-
 * subscribing a held topic would re-run the app's gate every time.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {unknown} [verdict] - from a batch gate already run for this frame
 * @returns {Promise<string | null>}
 */
function gatedSubscribe(ws, topic, verdict) {
	// `subscribeWithVerdict`, NOT `platform.subscribe`. The verdict channel is a
	// parameter of a module-private function precisely so it is not reachable
	// through the platform object: every earlier spelling put it somewhere a
	// caller could supply it - a string key on the options bag, then a Symbol on
	// the same bag, then a fourth positional parameter of the public method,
	// where an ordinary `topics.map(platform.subscribe.bind(platform, ws))`
	// passed the array as a verdict and skipped the gate entirely.
	return subscribeWithVerdict(
		ws,
		topic,
		{ allowSystemTopic: allow_system_topic_subscribe },
		verdict
	);
}

/**
 * Answer the client for one settled subscribe.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {number | string | null} ref
 * @param {string | null} result
 */
function settleSubscribeResult(ws, topic, ref, result) {
	if (result === null) {
		sendSubscribed(ws, topic, ref);
		return;
	}
	// The socket went away: there is nobody left to answer.
	if (result === 'CLOSED') return;
	// An unsubscribe overtook this subscribe while it sat in the gate. A late
	// `subscribed` would desynchronize the client, but SILENCE strands it: a
	// client that keys a promise or a timeout map on `ref` never settles the
	// entry and, without a timeout of its own, waits forever. `CANCELLED` as a
	// denial reason tells it the truth - the subscription did not stand - and
	// closes the ref.
	sendSubscribeDenied(ws, topic, ref, result);
}

/**
 * The Bun `websocket` handler set.
 */
export const websocketHandlers = {
	/** @param {any} raw */
	open(raw) {
		const ws = wsFacade(raw);
		// Guarded like every other userData read. A throw out of Bun's open
		// callback would skip `wsConnections.add` below, leaving a live
		// connection invisible to the registry for the rest of its life.
		let userData;
		try {
			userData = ws.getUserData();
		} catch {
			return;
		}
		userData[WS_SUBSCRIPTIONS] = new Set();

		// Promote the upgrade-time request id into a per-connection platform
		// clone, then drop the string slot so userData stays clean for hook
		// code. The clone is prototype-linked, so it costs one object per
		// connection and every method still resolves to the shared platform.
		const wsPlatform = Object.create(platform);
		wsPlatform.requestId = userData[WS_REQUEST_ID_KEY];
		userData[WS_PLATFORM] = wsPlatform;
		delete userData[WS_REQUEST_ID_KEY];

		const sessionId = crypto.randomUUID();
		userData[WS_SESSION_ID] = sessionId;

		// Per-connection traffic stats exist only to feed a close hook, so an
		// app without one does not carry the counters.
		if (closeHookRegistered) {
			userData[WS_STATS] = {
				openedAt: performance.now(),
				messagesIn: 0,
				messagesOut: 0,
				bytesIn: 0,
				bytesOut: 0
			};
		}

		wsConnections.add(ws);
		sendControl(ws, '{"type":"welcome","sessionId":"' + sessionId + '"}');
		callHook('open', () => wsModule.open?.(ws, { platform: wsPlatform }));
	},

	/**
	 * @param {any} raw
	 * @param {string | Buffer} message
	 */
	async message(raw, message) {
		const ws = wsFacade(raw);
		bumpIn(ws, message);

		// Bun selects the frame type from the payload: a text frame arrives as
		// a string, a binary frame as a Buffer. That replaces the donor's
		// explicit isBinary argument, and it means a control frame check never
		// has to decode bytes - only strings can be control frames.
		const isBinary = typeof message !== 'string';

		/** @type {any} */
		let msg;
		if (!isBinary) {
			const text = /** @type {string} */ (message);
			// Prefix test before parsing: control frames start {"type" while
			// data envelopes start {"topic". This skips JSON.parse for the
			// overwhelming majority of application traffic. See the note on
			// looksLikeControlFrame for why it is not a bare index-3 check.
			const looksControl = looksLikeControlFrame(text);
			if (looksControl && Buffer.byteLength(text) >= CONTROL_FRAME_LIMIT) {
				// An oversized frame whose prefix looks like a control frame.
				// The prefix alone is NOT proof - `{"type":...}` is the most
				// common application envelope convention there is - so this
				// checks whether the type is one the demux would actually have
				// consumed before refusing. Getting that wrong would silently
				// eat any large app message beginning `{"ty` and answer it with
				// a protocol error the app never asked for.
				//
				// Measured in BYTES, not String.length: UTF-16 code units would
				// admit up to four times the intended ceiling of attacker text
				// into JSON.parse, and the reported size would not match the
				// dimension enforced.
				if (isConsumedControlType(text)) {
					sendControl(ws, controlFrameTooLargeFrame(Buffer.byteLength(text)));
					return;
				}
				// Not ours. Hand it to the app untouched.
				let oversizeUd;
				try {
					oversizeUd = ws.getUserData();
				} catch {
					return;
				}
				callHook('message', () =>
					wsModule.message?.(ws, { data: message, isBinary, msg: undefined, platform: oversizeUd[WS_PLATFORM] })
				);
				return;
			}
			if (looksControl) {
				/** @type {any} */
				let parsed;
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = undefined;
				}
				if (parsed === null || typeof parsed !== 'object') {
					// Not an object envelope. Forward the raw frame only.
					let rawUd;
					try {
						rawUd = ws.getUserData();
					} catch {
						return;
					}
					callHook('message', () =>
						wsModule.message?.(ws, { data: message, isBinary, msg: undefined, platform: rawUd[WS_PLATFORM] })
					);
					return;
				}
				msg = parsed;

				if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
					await applySubscribe(ws, msg.topic, isEchoableRef(msg.ref) ? msg.ref : null);
					return;
				}

				if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
					const ref = isEchoableRef(msg.ref) ? msg.ref : null;
					// The SAME wire validation the subscribe path applies. This
					// branch drives the app's unsubscribe hook, which fires
					// whether or not the connection held the subscription (see
					// below) - so without these checks a client refused
					// `__presence:room1` on subscribe could still drive plugin
					// teardown for it, and a 4000-char topic or one carrying
					// U+0000 reached the hook and, through it, whatever key
					// space the plugin writes to.
					// NOTE the `true`: release is validated against the same
					// always-illegal bytes `platform.subscribe` uses, NOT against
					// `allowNonAsciiTopics`. Release must never be stricter than
					// grant, or a topic the server legitimately granted through
					// the trusted path (`room:Muller`, non-ASCII, allowed there)
					// could never be given up - the socket keeps receiving a
					// topic nothing consumes, the subscription total drifts, and
					// the app's unsubscribe hook never fires, until the socket
					// closes.
					if (!isValidWireTopic(msg.topic, true)) {
						sendUnsubscribeDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
						return;
					}
					if (!allow_system_topic_subscribe && isSystemTopic(msg.topic)) {
						sendUnsubscribeDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
						return;
					}
					// The RELEASE always happens, ahead of any bound. A throttled
					// unsubscribe that left the subscription installed would do
					// so silently: the family client sends unsubscribe with NO
					// ref and has no branch for a refusal frame, so a page
					// unmounting a hundred stores would leave the tail of them
					// subscribed and still receiving publishes. Releasing is
					// cheap and is exactly the part that must not be skipped.
					const wasHeld = platform.unsubscribe(ws, msg.topic);
					// The app's unsubscribe hook fires whether or not the
					// connection actually held the subscription: plugin state
					// (a presence roster entry, a cursor attachment) can exist
					// independently of native membership, and skipping the hook
					// would leak it until the socket closed.
					//
					// That is also the lane an attacker drives, since it needs no
					// state at all - so the SPECULATIVE case (a topic this
					// connection never held) is the one that yields under
					// pressure, and only it.
					//
					// A real release is DEFERRED, never dropped, and never
					// dispatched unbounded. The subscription cap limits the SET
					// SIZE, not the concurrency, and Bun does not await this
					// handler, so 10,000 held topics released in one read burst
					// would otherwise land 10,000 concurrent app hooks. `wasHeld`
					// is also not the same question as "does the app have state
					// for this topic": the extensions' observer lanes subscribe
					// with a bare `ws.subscribe`, which this adapter never
					// records, so their releases arrive on the speculative lane.
					// The queue is what lets the bound hold without either lane
					// losing its teardown.
					let unsubUd;
					try {
						unsubUd = ws.getUserData();
					} catch {
						unsubUd = null;
					}
					if (unsubUd) {
						const outcome = runUnsubscribeHook(
							ws,
							() =>
								// callHook RETURNS the hook's promise, and returning
								// it is what makes the bound measure concurrent
								// hooks rather than concurrent
								// calls-to-a-hook-that-immediately-suspends.
								callHook('unsubscribe', () =>
									wsModule.unsubscribe?.(ws, msg.topic, { platform: unsubUd[WS_PLATFORM] })
								) ?? Promise.resolve(),
							wasHeld
						);
						// Even the queue is full, and this release cannot be
						// dropped. Closing is the honest move rather than the harsh
						// one: the close handler runs the app's `close` hook with
						// the whole subscription snapshot, which releases the same
						// state this task would have. 4429 is the family's throttle
						// code, so the client reconnects with backoff instead of
						// giving up.
						if (outcome === 'overflow') {
							warnUnsubscribeOverflow();
							try {
								ws.end(CONTROL_FLOOD_CLOSE_CODE, 'unsubscribe backlog');
							} catch {
								wsCounters.closedWsAborts++;
							}
							return;
						}
					}
					// Unconditional ack shape: unsubscribing something you were
					// not subscribed to is not an error, and the client's state
					// converges either way.
					if (ref !== null) sendControl(ws, unsubscribedFrame(msg.topic, ref));
					return;
				}

				if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
					const ref = isEchoableRef(msg.ref) ? msg.ref : null;
					// Refused WHOLE, before any per-entry work, and answered with
					// ONE frame. Answering an oversized batch per entry is what
					// makes the ack channel an amplifier that scales with the
					// inbound frame rather than with the limit: 8 KB of two-byte
					// entries is four thousand of them, and each refusal frame
					// costs ~200 bytes with the ref echoed into it. Every client
					// in the family chunks below this limit, so nothing that is
					// not hand-written reaches the branch at all.
					if (msg.topics.length > MAX_BATCH_TOPICS) {
						// Sent whether or not a ref was supplied: unlike an ack,
						// this is the client learning its frame did nothing.
						sendControl(ws, batchTooLargeFrame(msg.topics.length));
						return;
					}
					// Sequential, not Promise.all: each entry runs the app's
					// authorization hook, and a batch must not become a way to
					// fan one connection's work out concurrently across the
					// gate.
					const accepted = msg.topics;
					// Topics the connection ALREADY holds short-circuit to a plain ack.
					// Letting them reach the headroom test made a full connection answer
					// RATE_LIMITED for a topic it is currently subscribed to, while the
					// single-subscribe spelling of the same request returned success - and
					// the family client re-subscribes everything as a batch on reconnect, so
					// a connection at its ceiling could never re-establish.
					const held = heldSubscriptions(ws);
					/** @type {string[]} */
					const fresh = [];
					for (const topic of accepted) {
						if (isWireTopicRejected(topic)) {
							// The raw value, not String(topic): a client correlating this
							// against what it sent needs the value it actually sent.
							sendSubscribeDenied(ws, topic, ref, 'INVALID_TOPIC');
							continue;
						}
						if (held.has(topic)) {
							sendSubscribed(ws, topic, ref);
							continue;
						}
						fresh.push(topic);
					}
					// Bound the GATE, not just the installs. Two separate limits, because one
					// counter cannot do both jobs: distinct pending topics bounds what can
					// install, and in-flight gate calls bounds concurrent app work. Checked
					// here because the batch gate runs before any per-topic accounting exists.
					if (fresh.length > 0 && !hasGateHeadroom(ws)) {
						for (const topic of fresh) sendSubscribeDenied(ws, topic, ref, 'RATE_LIMITED');
					} else if (fresh.length > 0) {
						// ONE gate call for the whole batch when the app exports
						// `subscribeBatch` - that is the entire reason the hook exists, and
						// calling it per entry would defeat it. Counted as in-flight app work
						// for its whole duration: awaited outside the accounting, pipelined
						// batch frames would open one concurrent gate call each with nothing
						// bounding how many run at once.
						const verdicts = await withGateCounted(ws, () => runBatchGate(ws, fresh));
						for (const topic of fresh) {
							const result = await gatedSubscribe(ws, topic, verdicts.get(topic));
							settleSubscribeResult(ws, topic, ref, result);
						}
					}
					return;
				}
			}
		}

		// Everything else is the app's. `msg` is forwarded when it was already
		// parsed, so a plugin dispatcher does not decode and parse a second
		// time.
		//
		// DELIBERATELY UNBOUNDED, unlike the subscribe and unsubscribe hooks.
		// Those two are adapter-owned verbs with a defined refusal (the client
		// gets RATE_LIMITED and can retry), so bounding them costs nothing an
		// app relies on. `message` is the app's own protocol: the adapter has no
		// idea which frames are expensive, no way to express a refusal in a
		// protocol it does not define, and no ability to pause Bun's read side.
		// A per-frame app handler is client-paced on every WebSocket server
		// there is; the controls that fit are the app's own concurrency limit
		// and Bun's maxPayloadLength / backpressureLimit, both already exposed.
		let ud;
		try {
			ud = ws.getUserData();
		} catch {
			return;
		}
		callHook('message', () =>
			wsModule.message?.(ws, { data: message, isBinary, msg, platform: ud[WS_PLATFORM] })
		);
	},

	/** @param {any} raw */
	drain(raw) {
		const ws = wsFacade(raw);
		let ud;
		try {
			ud = ws.getUserData();
		} catch {
			return;
		}
		callHook('drain', () => wsModule.drain?.(ws, { platform: ud[WS_PLATFORM] }));
	},

	/**
	 * @param {any} raw
	 * @param {number} code
	 * @param {string} message
	 */
	close(raw, code, message) {
		const ws = wsFacade(raw);
		// Deregister FIRST, before anything that could throw. This is the one
		// place where a throw would strand the facade in the live-connection
		// registry permanently - `sendTo` and `forEachSubscriber` would then
		// walk a dead socket on every call for the rest of the process's life,
		// and `connections` would over-report forever.
		wsConnections.delete(ws);
		ws._markClosed();

		// Readable throughout this handler: the socket is closed for WRITES, but
		// userData is not released until `_markDetached()` in the `finally`
		// below, so the app's close hook can still identify what it is tearing
		// down (uWS keeps it valid for the same window).
		const userData = ws._rawUserData();
		if (!userData) return;
		const subscriptions = userData[WS_SUBSCRIPTIONS] || new Set();
		// A SNAPSHOT for the hook, not the live set. `callHook` returns at the
		// hook's first await and the `finally` below then clears the set - so an
		// async close hook doing the documented teardown
		// (`for (const t of ctx.subscriptions) await roster.remove(t)`) iterated
		// ZERO topics and leaked every roster entry for the connection, silently.
		// The clear still has to happen (see the note on it below), so the two
		// requirements are met by handing out a copy.
		const heldSubscriptions = new Set(subscriptions);

		const stats = userData[WS_STATS];
		const closePlatform = userData[WS_PLATFORM];
		const ctx = stats
			? {
				code,
				message,
				platform: closePlatform,
				subscriptions: heldSubscriptions,
				id: userData[WS_SESSION_ID],
				duration: performance.now() - stats.openedAt,
				messagesIn: stats.messagesIn,
				messagesOut: stats.messagesOut,
				bytesIn: stats.bytesIn,
				bytesOut: stats.bytesOut
			}
			: { code, message, platform: closePlatform, subscriptions: heldSubscriptions };

		try {
			// Tracked, not fire-and-forget: the shutdown drain waits on these so
			// an async close hook is not killed mid-flight by process.exit.
			const settling = callHook('close', () => wsModule.close?.(ws, ctx));
			if (settling) trackCloseHook(settling);
		} finally {
			// Runs even if the app's hook threw: a leaked subscription count
			// would skew every later pressure reading.
			wsCounters.totalSubscriptions -= subscriptions.size;
			if (wsCounters.totalSubscriptions < 0) wsCounters.totalSubscriptions = 0;
			// CLEAR the set after settling the counter. Leaving it populated
			// lets a late platform.unsubscribe on this dead connection - an app
			// continuation resuming after its own await - find the topic still
			// present and decrement a SECOND time. That drift is permanent and
			// one-directional, and once it exceeds the live total the clamp
			// above zeroes a count that covers every remaining connection.
			subscriptions.clear();
			userData[WS_PENDING_SUBSCRIBES] = undefined;
			// Drop unsubscribe hooks still WAITING. The close hook above was
			// handed the whole subscription set and performs the same teardown,
			// so draining a per-topic queue afterwards is duplicate work against
			// a socket that no longer exists - and the ones already running are
			// left alone, since they hold app state mid-release.
			clearUnsubscribeHooks(userData);
			// RELEASE userData last. Up to here the close hook could read it to
			// identify the connection; from here a continuation resuming after
			// its own await gets the throw its rollback is written against.
			ws._markDetached();
		}
	}
};
