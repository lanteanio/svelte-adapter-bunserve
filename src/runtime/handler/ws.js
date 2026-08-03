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
 *   {"type":"resume","sessionId":"s","lastSeenSeqs":{"t":N},"lastSeenEpochs":{"t":E}?}
 * Server to client:
 *   {"type":"welcome","sessionId":"..."}
 *   {"type":"subscribed","topic":"t","ref":N,"epoch":E}
 *   {"type":"subscribe-denied","topic":"t","ref":N,"reason":"..."}
 *   {"type":"unsubscribed","topic":"t","ref":N}
 *   {"type":"unsubscribe-denied","topic":"t","ref":N,"reason":"..."}
 *   {"type":"resumed"}
 *   {"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":L,"size":N}
 *   {"type":"error","code":"BATCH_TOO_LARGE","limit":L,"size":N}
 *   {"type":"error","code":"RESUME_TOO_LARGE","limit":L,"size":N}
 *   {"type":"error","code":"INVALID_SESSION_ID"}
 *   {"type":"error","code":"RESUME_RATE_LIMITED"}
 *   {"type":"error","code":"RESUME_FAILED"}
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
 * CHANNEL is budgeted per connection. See handler/control-egress.js and
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
import { bumpIn, closeHookRegistered } from './ws-stats.js';
import { sendControl } from './control-egress.js';
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
import { processMonotonicNow, randomUuid } from '../runtime.js';
import {
	isValidResumeEpoch,
	isValidResumeSeq,
	isValidResumeSessionId
} from '../utils/resume-input.js';
import {
	CONTROL_FLOOD_CLOSE_CODE,
	CONTROL_FRAME_LIMIT,
	INVALID_SESSION_ID_FRAME,
	MAX_BATCH_TOPICS,
	RESUME_FAILED_FRAME,
	RESUME_RATE_LIMITED_FRAME,
	batchTooLargeFrame,
	controlFrameTooLargeFrame,
	isConsumedControlType,
	leaseGrantFrame,
	looksLikeControlFrame,
	resumeTooLargeFrame
} from '../utils/control-frame.js';
import { createLeaseState } from '../utils/lease.js';
import { grantSizeFor } from './pressure-metrics.js';
import { detachWireStates } from './wire-state.js';
import { releaseSharedWireId } from '../utils/shared-wire-id.js';
import {
	WS_CAPS,
	WS_LEASE,
	WS_PENDING_SUBSCRIBES,
	WS_SHARED_COHORTS,
	WS_PLATFORM,
	WS_REQUEST_ID_KEY,
	WS_SESSION_ID,
	WS_STATS,
	WS_SUBSCRIPTIONS,
	beginPendingRelease,
	capCounts,
	clearPendingReleases,
	clearUnsubscribeHooks,
	settlePendingRelease,
	hasGateHeadroom,
	heldSubscriptions,
	pendingReleaseTopics,
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
		throttle = createLogThrottle(() => processMonotonicNow());
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

/** Unsubscribe backlogs, throttled with decay: a client controls how many. */
const unsubOverflowThrottle = createLogThrottle(() => processMonotonicNow());

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
 * Is this topic one the RESUME lane must not hand to the app's hook?
 *
 * Deliberately NOT `isWireTopicRejected`, and the difference is one flag: this
 * lane allows non-ASCII names whatever `allowNonAsciiTopics` says. The wire
 * subscribe lane is stricter, but it is not the only way a connection acquires
 * a topic - `platform.subscribe` is the documented server-side spelling and it
 * trusts non-ASCII past that bound on purpose. Holding resume to the wire lane's
 * charset would therefore drop a topic the app legitimately granted, and this
 * lane's refusal is SILENT: the topic vanishes from the map the hook gap-fills
 * from and the `resumed` ack still tells the client to go live. Being stricter
 * here manufactures the hole the resume machinery exists to prevent, which is
 * the same reason the unsubscribe lane is permissive.
 *
 * `__proto__` is refused even though the adapter's own maps are null-prototype:
 * the hazard is the APP's, whose history lookup is commonly a plain-object
 * allowlist, where `__proto__` reads truthy off `Object.prototype`. The
 * subscribe path refuses it for that exact reason.
 *
 * @param {string} topic
 * @returns {boolean}
 */
function isResumeTopicRejected(topic) {
	if (!isValidWireTopic(topic, true)) return true;
	if (topic === '__proto__') return true;
	return !allow_system_topic_subscribe && isSystemTopic(topic);
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
 * @param {{ offset: number, epoch?: number } | null} [recover] - gap-fill the
 *   missed tail through the app's resume hook before going live
 * @returns {Promise<void>}
 */
async function applySubscribe(ws, topic, ref, recover) {
	if (isWireTopicRejected(topic)) {
		sendSubscribeDenied(ws, topic, ref, 'INVALID_TOPIC');
		return;
	}
	settleSubscribeResult(ws, topic, ref, await gatedSubscribe(ws, topic, undefined, recover));
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
 * @param {{ offset: number, epoch?: number } | null} [recover]
 * @returns {Promise<string | null>}
 */
function gatedSubscribe(ws, topic, verdict, recover) {
	// `subscribeWithVerdict`, NOT `platform.subscribe`. The verdict channel is a
	// parameter of a module-private function precisely so it is not reachable
	// through the platform object: any caller-reachable spelling is forgeable -
	// a key on the options bag (a Proxy with a catch-all `get` answers even a
	// Symbol), or a trailing positional parameter of the public method, where
	// an ordinary `topics.map(platform.subscribe.bind(platform, ws))` passes
	// the array as a verdict and skips the gate entirely.
	return subscribeWithVerdict(
		ws,
		topic,
		{ allowSystemTopic: allow_system_topic_subscribe, recover: recover ?? undefined },
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

		const sessionId = randomUuid();
		userData[WS_SESSION_ID] = sessionId;

		// Per-connection traffic stats exist only to feed a close hook, so an
		// app without one does not carry the counters.
		if (closeHookRegistered) {
			userData[WS_STATS] = {
				openedAt: processMonotonicNow(),
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

				if (msg.type === 'hello' && Array.isArray(msg.caps)) {
					// Capability negotiation. Old clients never send 'hello', so
					// the ABSENCE of the WS_CAPS slot is the safe-default "no
					// opt-in features" signal every capability consumer keys on.
					// The caps list is bounded by the control-frame byte ceiling
					// above; non-string entries are dropped rather than refused,
					// because a partially-understood hello from a newer client
					// must not cost it the caps this server does understand.
					const caps = new Set();
					for (let i = 0; i < msg.caps.length; i++) {
						if (typeof msg.caps[i] === 'string') caps.add(msg.caps[i]);
					}
					let helloUd;
					try {
						helloUd = ws.getUserData();
					} catch {
						return;
					}
					// A re-sent hello REPLACES the prior set, so the live
					// per-capability counts are diffed, not blindly incremented.
					capCounts.adjust(helloUd[WS_CAPS], caps);
					helloUd[WS_CAPS] = caps;
					// First-hello lease arm: a client advertising `lease` opts
					// into flow control. Grant-and-observe, the family
					// semantics: the server never gates its own sends on the
					// window - pacing is enforced client-side - it only sizes
					// windows from its posture and observes saturation on
					// replenish. FIRST hello only: a re-sent hello (a lazy
					// plugin re-advertising caps) must not reset the window or
					// repeat the ack.
					if (caps.has('lease') && !helloUd[WS_LEASE]) {
						const g = grantSizeFor();
						const gate = createLeaseState({ requestCount: g.count, ttlMs: g.ttlMs });
						gate.grant();
						helloUd[WS_LEASE] = { gate, saturation: gate.pressureValue() };
						sendControl(ws, '{"type":"lease-ok"}');
						sendControl(ws, leaseGrantFrame(g.count, g.ttlMs));
					}
					return;
				}

				if (msg.type === 'request-n') {
					// Window replenish. The client's `n` is advisory and
					// deliberately ignored - the server sizes every window from
					// its own posture, so a client cannot ask its way past a
					// tightening worker. No armed window (a request-n from a
					// client that never opted in) is a silent no-op.
					let leaseUd;
					try {
						leaseUd = ws.getUserData();
					} catch {
						return;
					}
					const slot = leaseUd[WS_LEASE];
					if (slot) {
						const g = grantSizeFor();
						slot.gate.requestN(g.count, g.ttlMs);
						sendControl(ws, leaseGrantFrame(g.count, g.ttlMs));
						slot.saturation = slot.gate.pressureValue();
						if (slot.saturation > wsCounters.leaseSaturationPeak) {
							wsCounters.leaseSaturationPeak = slot.saturation;
						}
					}
					return;
				}

				if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
					// A recover offset asks for the missed tail (epoch-checked by
					// the app's resume hook) before going live. Offset and epoch take
					// the SHARED resume-input rules: this lane and the `resume` frame
					// below feed the hook the same two quantities, so a value one lane
					// accepts and the other refuses would make identical client state
					// produce two different gap-fill decisions. Anything else
					// subscribes plainly.
					const recover =
						msg.recover &&
						typeof msg.recover === 'object' &&
						isValidResumeSeq(msg.recover.offset)
							? {
								offset: msg.recover.offset,
								epoch: isValidResumeEpoch(msg.recover.epoch) ? msg.recover.epoch : undefined
							}
							: null;
					await applySubscribe(ws, msg.topic, isEchoableRef(msg.ref) ? msg.ref : null, recover);
					return;
				}

				if (
					msg.type === 'resume' &&
					typeof msg.sessionId === 'string' &&
					msg.lastSeenSeqs &&
					typeof msg.lastSeenSeqs === 'object' &&
					!Array.isArray(msg.lastSeenSeqs)
				) {
					// The client presents its previous session id plus per-topic
					// lastSeenSeqs so the app's resume hook can fill the gap. The
					// hook is optional: without one the ack still goes out so the
					// client can switch to live mode. No recovery barrier here -
					// this frame installs no live membership, so there is no
					// cutover window to bridge; a subscribe carrying a recover
					// offset gets the barrier on that path.
					let resumeUd;
					try {
						resumeUd = ws.getUserData();
					} catch {
						return;
					}
					// The session id is client input the app's hook queries a backend with,
					// so it takes shape rules of its own rather than only a typeof test.
					// Refused rather than filtered: there is no resume to perform without one,
					// and forwarding a value this lane could not vouch for is the whole risk.
					if (!isValidResumeSessionId(msg.sessionId)) {
						sendControl(ws, INVALID_SESSION_ID_FRAME);
						return;
					}
					// One resume frame names at most as many topics as one subscribe-batch
					// carries. The gate below counts FRAMES, not topics, so without a per-frame
					// bound one legal frame opens a backend read per topic it names - the
					// control-frame ceiling alone leaves room for about a thousand short topics -
					// and pipelined frames multiply that by the gate width. Refused WHOLE like an
					// oversized batch rather than truncated to the cap: a truncated gap-fill
					// would still end in `resumed`, and the client has no way to tell which
					// topics were actually covered. (The gate below has its own answer to
					// saturation, and it is NOT this one - see the comment there.)
					const seqTopics = Object.keys(msg.lastSeenSeqs);
					const rawEpochs =
						msg.lastSeenEpochs &&
						typeof msg.lastSeenEpochs === 'object' &&
						!Array.isArray(msg.lastSeenEpochs)
							? msg.lastSeenEpochs
							: undefined;
					const epochTopics = rawEpochs === undefined ? null : Object.keys(rawEpochs);
					// The UNION of the two maps, not the larger of them. Both ride into the
					// same hook, so what this bounds is how many DISTINCT topics one frame
					// can put in front of it - and two disjoint maps of the cap each would
					// name twice the cap between them while each looked compliant.
					const namedTopics =
						epochTopics === null
							? seqTopics.length
							: new Set(seqTopics.concat(epochTopics)).size;
					if (namedTopics > MAX_BATCH_TOPICS) {
						sendControl(ws, resumeTooLargeFrame(namedTopics));
						return;
					}
					// Client-named topics are held to the always-illegal bytes, the
					// `__proto__` guard and the system-topic guard - one predicate for both
					// maps, because a guard written out per loop is a guard that gets fixed
					// on one of them. See isResumeTopicRejected for why this lane is NOT
					// held to the wire subscribe lane's charset rule.
					//
					// Filtered rather than refused whole: a resume names many topics at once
					// and a client legitimately holds most of them.
					/** @type {Record<string, number>} */
					const resumeSeqs = Object.create(null);
					for (const t of seqTopics) {
						if (isResumeTopicRejected(t)) continue;
						// Only a watermark the server could have issued reaches the
						// hook: the value is client input, and the hook queries a
						// backend with it, so a crafted shape must never pass
						// through unchecked. The recover lane holds its offset to the
						// identical rule, from the same module.
						const v = msg.lastSeenSeqs[t];
						if (isValidResumeSeq(v)) resumeSeqs[t] = v;
					}
					// The epoch map rides alongside the watermarks into the same
					// hook, so it gets the SAME treatment - the identical topic
					// predicate, the shared epoch rule, and a null prototype. Forwarding the raw parse handed the hook topics
					// the watermark map had already refused, plus whatever
					// `__proto__` key the client put in it. Absent when the client
					// sends no map at all - that is how the recover lane reports "no
					// epoch known", and the hook sees one contract, not two.
					let lastSeenEpochs;
					if (epochTopics !== null) {
						lastSeenEpochs = Object.create(null);
						for (const t of epochTopics) {
							if (isResumeTopicRejected(t)) continue;
							const e = rawEpochs[t];
							if (isValidResumeEpoch(e)) lastSeenEpochs[t] = e;
						}
					}
					// The resume hook is the most expensive app work a client
					// frame can trigger (a backend history read), and Bun does
					// not await the message handler, so a client can pipeline
					// resume frames to open one concurrent read per frame. Bound
					// it by the same per-connection gate counter the subscribe
					// gates use.
					//
					// Over the bound the frame is REFUSED, not acked. `resumed` is
					// the only frame a resuming client keys on and it has no gap
					// detection, so acking a frame whose hook never ran tells the
					// client it caught up on history nobody read - a silent hole,
					// and a worse one than the partial gap-fill the topic cap above
					// refuses whole to avoid. The sibling recover lane answers the
					// same saturation with RATE_LIMITED, though only when the
					// subscribe carried a `ref` - this lane's refusals are
					// unconditional, because a resume frame has no ref to withhold
					// them on.
					if (typeof wsModule.resume === 'function') {
						if (!hasGateHeadroom(ws)) {
							sendControl(ws, RESUME_RATE_LIMITED_FRAME);
							return;
						}
						try {
							// Awaited so per-topic replay flushes its frames before
							// the ack tells the client to switch to live mode -
							// otherwise live publishes can arrive ahead of gap-fill
							// frames and produce out-of-order events.
							await withGateCounted(ws, () =>
								wsModule.resume(ws, {
									sessionId: msg.sessionId,
									lastSeenSeqs: resumeSeqs,
									lastSeenEpochs,
									platform: resumeUd[WS_PLATFORM]
								})
							);
						} catch (err) {
							// Same rule as saturation, for the same reason: the hook
							// did not finish, so how much of the window it covered is
							// unknown and `resumed` would claim coverage the app never
							// delivered. A DIFFERENT code, because the client's move
							// differs - retrying a hook that threw does not help, and
							// a cold resync does.
							reportHookError('resume', err);
							sendControl(ws, RESUME_FAILED_FRAME);
							return;
						}
					}
					// No hook at all is not a failure: there is no history to serve,
					// so nothing was missed and the ack is honest.
					sendControl(ws, '{"type":"resumed"}');
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
					// would otherwise land 10,000 concurrent app hooks.
					//
					// The two lanes get different guarantees, and the difference
					// is what a client can invent. A held topic is RECORDED as a
					// pending release before the hook is queued, so if the
					// connection dies while the hook is still waiting, the close
					// hook is handed that topic and tears it down instead. The
					// speculative lane gets no such record: its topics were never
					// granted, so recording them would let a client grow the set
					// by naming topics it never held. It yields under pressure,
					// and a release refused there runs no hook at all.
					//
					// That is a real cost, because `wasHeld` is not the same
					// question as "does the app have state for this topic": the
					// extensions' observer lanes subscribe with a bare
					// `ws.subscribe`, which this adapter never records, so their
					// releases arrive on the speculative lane and are dropped
					// while the connection is saturated.
					let unsubUd;
					try {
						unsubUd = ws.getUserData();
					} catch {
						unsubUd = null;
					}
					// Read ONCE and reused for both the record and the dispatch.
					// Reading it twice lets the two disagree if the binding is
					// reassigned in between, and the disagreement that matters is
					// "recorded a debt, then found no hook to discharge it".
					const unsubscribeHook = wsModule.unsubscribe;
					// With no hook exported there is no app teardown to run, so the
					// release must not occupy the deferral queue either: a no-op per
					// release lets a client pipeline past the backlog and be cut
					// with 4429 over hooks that do not exist.
					if (unsubUd && typeof unsubscribeHook === 'function') {
						const releasedTopic = msg.topic;
						// Only a topic the connection genuinely held can be owed a
						// teardown; recording what a client can invent is how the
						// record becomes a memory amplifier.
						if (wasHeld) beginPendingRelease(unsubUd, releasedTopic);
						const outcome = runUnsubscribeHook(
							ws,
							() => {
								// Not callHook: it converts a rejection into a
								// resolution, and whether the hook RESOLVED is
								// exactly what decides if the teardown it was
								// owed has been performed. The guarantees callHook
								// provides are kept - a throw never escapes into an
								// unhandled rejection, and the hook's own promise
								// is returned so the bound measures concurrent
								// hooks rather than concurrent
								// calls-to-a-hook-that-immediately-suspends.
								let settling;
								try {
									settling = unsubscribeHook(
										ws,
										releasedTopic,
										{ platform: unsubUd[WS_PLATFORM] }
									);
									// Inside the try: reading `then` off a thenable
									// runs app code (a getter), and a throw from it
									// has to be reported like any other hook throw
									// rather than escaping unlogged.
									if (!settling || typeof settling.then !== 'function') {
										settlePendingRelease(unsubUd, releasedTopic, true);
										return undefined;
									}
								} catch (err) {
									// Threw before its first await, so it released
									// nothing: the topic stays owed.
									reportHookError('unsubscribe', err);
									return undefined;
								}
								return settling.then(
									() => settlePendingRelease(unsubUd, releasedTopic, true),
									(/** @type {unknown} */ err) => reportHookError('unsubscribe', err)
								);
							},
							wasHeld
						);
						// Even the queue is full, and this release cannot be
						// dropped. Closing is the honest move rather than the harsh
						// one: the topic was recorded as a pending release above, so
						// the close handler hands it to the app's `close` hook and
						// the same state is released by that route. 4429 is the
						// family's throttle code, so the client reconnects with
						// backoff instead of giving up.
						//
						// The one case that route does not cover is a connection
						// that has ALSO filled its pending-release record, which
						// takes thousands of DISTINCT topics whose hook never
						// resolved. Then there is nothing left to hand the close
						// hook. `droppedReleaseRecords` counts every refused
						// record, this case among them - most of what it counts
						// never reaches here, since a refused record does not
						// stop the hook from running.
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
		const teardownTopics = new Set(subscriptions);
		// Plus every topic still owed a teardown. Those are already out of
		// `subscriptions` - the release runs before the hook is queued - so
		// without this the app would never be told to tear them down: the
		// waiting hooks are dropped just below, and the snapshot would not name
		// them. They are NOT added to the counter arithmetic in the `finally`,
		// which is settled against the live set; these were subtracted when they
		// were released.
		//
		// A hook that was mid-await when the socket died can therefore finish AND
		// have its topic named here, so teardown is AT LEAST once. That is the
		// deliberate trade: the alternative is dropping the release whenever the
		// two race, which is the leak this record exists to close. The app's
		// teardown has to be idempotent, and the README says so.
		for (const topic of pendingReleaseTopics(userData)) teardownTopics.add(topic);

		const stats = userData[WS_STATS];
		const closePlatform = userData[WS_PLATFORM];
		const ctx = stats
			? {
				code,
				message,
				platform: closePlatform,
				subscriptions: teardownTopics,
				id: userData[WS_SESSION_ID],
				duration: processMonotonicNow() - stats.openedAt,
				messagesIn: stats.messagesIn,
				messagesOut: stats.messagesOut,
				bytesIn: stats.bytesIn,
				bytesOut: stats.bytesOut
			}
			: { code, message, platform: closePlatform, subscriptions: teardownTopics };

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
			// Release this connection's capability counts. Skipping it would
			// leave the binary fast-path gate answering "someone wants binary"
			// forever after the last capable client left.
			capCounts.adjust(userData[WS_CAPS], null);
			userData[WS_CAPS] = undefined;
			// Drop the send-gate window with the socket; its saturation
			// contribution (if any) decays out of the sampler's peak on the
			// next tick.
			if (userData[WS_LEASE]) userData[WS_LEASE] = undefined;
			// Dispose per-connection wire-codec state (dictionaries, delta
			// baselines) exactly once, via each codec's own onDetach.
			detachWireStates(ws, userData);
			// Release the shared wire-id refs this connection's binary cohorts
			// held. The cohort subscriptions themselves die with the socket
			// natively (probed - subscriberCount decrements on close); the
			// refcount is the only thing Bun cannot release for us.
			const cohorts = userData[WS_SHARED_COHORTS];
			if (cohorts) {
				for (const topic of cohorts) releaseSharedWireId(topic);
				cohorts.clear();
			}
			userData[WS_PENDING_SUBSCRIBES] = undefined;
			// Drop unsubscribe hooks still WAITING. Their topics went into the
			// snapshot above, so the close hook performs their teardown, and
			// draining a per-topic queue against a socket that no longer exists
			// would be duplicate work - the ones already running are left alone,
			// since they hold app state mid-release.
			clearUnsubscribeHooks(userData);
			clearPendingReleases(userData);
			// RELEASE userData last. Up to here the close hook could read it to
			// identify the connection; from here a continuation resuming after
			// its own await gets the throw its rollback is written against.
			ws._markDetached();
		}
	}
};
