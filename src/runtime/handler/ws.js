import { deliveryAuthorization } from './delivery-authorization.js';
import { recordBackpressureDrop } from '../utils/backpressure.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
/**
 * The WebSocket connection lifecycle and the built-in JSON control demux.
 *
 * These are the `websocket: { open, message, drain, close }` handlers passed to
 * `Bun.serve`. They do IO and apply decisions; every decision that can be pure
 * is (utils/topic.js, utils/envelope.js, utils/send-result.js), which is what
 * keeps the ordering-sensitive parts testable without a socket.
 *
 * Wire protocol, client to server (all JSON text frames):
 *   {"type":"subscribe","topic":"t","ref":N?,"recover":{"offset":N,"epoch":E?}?}
 *   {"type":"unsubscribe","topic":"t"}
 *   {"type":"subscribe-batch","topics":["a","b"],"ref":N?,"recover":{"a":{"offset":N,"epoch":E?}}?}
 *   {"type":"resume","sessionId":"s","lastSeenSeqs":{"t":N},"lastSeenEpochs":{"t":E}?}
 *   {"type":"request-n","n":N,"queued":N?}
 * Server to client:
 *   {"type":"welcome","sessionId":"..."}
 *   {"type":"subscribed","topic":"t","ref":N,"epoch":E}
 *   {"type":"subscribe-denied","topic":"t","ref":N,"reason":"..."}
 *   {"type":"resumed"}
 *   {"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":L,"size":N}
 *   {"type":"error","code":"RECOVER_REQUIRES_REF","topic":"t"}
 *
 * A `subscribe-batch` is answered PER ENTRY, with the same `subscribed` /
 * `subscribe-denied` frames a single subscribe produces. That is not an
 * accident: the family client keys its denial store and its per-topic
 * subscription epochs off those frames, and it re-subscribes everything as a
 * batch on every reconnect - so a summary frame it does not recognise silently
 * loses every denial and degrades resume.
 *
 * Subscribe batches process a prefix of MAX_BATCH_TOPICS entries. Extra string
 * topics receive BATCH_OVERFLOW denials; the per-connection control-egress
 * budget bounds these replies. See handler/control-egress.js.
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

import { installAttribution } from '../utils/attribution.js';
import { wsFacade } from './ws-facade.js';
import { WS_CONNECTION_PERMIT, upgradeAdmission } from './admission.js';
import { bumpIn, closeHookRegistered } from './ws-stats.js';
import { sendControl } from './control-egress.js';
import { bindIngress, dispatchIngressFrame, ingressBoundFrame, ingressOkFrame, WIRE_INGRESS_CAP } from './ingress.js';
import {
	platform,
	prepareBatchRecovery,
	unsubscribeFromWire,
	runWireBatchGates,
	subscribeWithVerdict,
	wireGrantGateDecides
} from './platform.js';
import {
	deniesRefLessRecover,
	deniesRefLessRecoverBatch,
	deniesUngrantedObserve,
	isPluginOwnedTopic,
	recoverRequiresRefFrame
} from '../utils/subscribe-policy.js';
import { wsModule } from '../ws-handler-bridge.js';
import { isSystemTopic, isValidWireTopic } from '../utils/topic.js';
import {
	isEchoableRef,
	subscribeDeniedFrame,
	subscribedFrame
} from '../utils/ack-frame.js';
import { runCloseHook, runDrainHook, runMessageHook, runOpenHook } from '../utils/hook-boundary.js';
import { declareRuntimeConnectionSlots } from './ws-state.js';
import { routeGameFrame } from './game-ingress.js';
import { dispatchUnsubscribeHook, reportHookError } from './unsubscribe-hook.js';
import { flushCoalescedFor } from './coalesced.js';
import { assert, fatal } from '../utils/assertions.js';
import { processMonotonicNow, randomUuid } from '../runtime.js';
import {
	isValidResumeEpoch,
	isValidResumeSeq
} from '../utils/resume-input.js';
import {
	CONTROL_FRAME_LIMIT,
	MAX_BATCH_TOPICS,
	controlFrameTooLargeFrame,
	isConsumedControlType,
	leaseGrantFrame,
	looksLikeControlFrame
} from '../utils/control-frame.js';
import { createLeaseState, leaseReportedSaturation } from '../utils/lease.js';
import { grantSizeFor } from './pressure-metrics.js';
import { detachWireStates } from './wire-state.js';
import { releaseSharedWireId } from '../utils/shared-wire-id.js';
import {
	accountClosedLogicalSubscriptions,
	declareConnectionSlots,
	pendingSubscribeTotal,
	membershipUnconfirmed
} from '../utils/ws-symbols.js';
import {
	getServer,
	MAX_PENDING_SUBSCRIBES_PER_CONNECTION,
	MAX_SUBSCRIPTIONS_PER_CONNECTION,
	WS_CAPS,
	WS_LEASE,
	WS_PENDING_SUBSCRIBES,
	WS_PENDING_SUBSCRIBES_TOTAL,
	WS_COALESCED,
	WS_SHARED_COHORTS,
	WS_PLATFORM,
	CARRY_REQUEST_ID,
	WS_SESSION_ID,
	WS_STATS,
	WS_SUBSCRIPTIONS,
	beginPendingSubscribe,
	capCounts,
	heldSubscriptions,
	trackCloseHook,
	topicEpochValue,
	wsConnections,
	wsCounters
} from './ws-state.js';
import { allow_non_ascii_topics, allow_system_topic_subscribe } from './config.js';


/**
 * @param {any} ws
 * @param {string} topic
 * @param {number | string | null} ref
 */
function sendSubscribed(ws, topic, ref) {
	if (ref === null) return;
	sendControl(ws, subscribedFrame(topic, ref, topicEpochValue(topic)));
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
	if (!allow_system_topic_subscribe && isSystemTopic(topic) && !isPluginOwnedTopic(topic)) return true;
	return false;
}

/**
 * Apply one subscribe request: validate, authorize, subscribe, ack.
 *
 * The batch path does NOT come through here: its one-call batch gate runs
 * before the per-entry work. Both wire forms authorize already-held topics
 * again. This is the single-subscribe spelling, so there is no pre-obtained
 * verdict to pass on.
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
 * The platform owns the cap, authorization and in-flight cancellation record.
 * The demux validates the wire shape and sends the result. Held wire requests
 * still run authorization; a precomputed batch verdict avoids repeating the
 * application hook for each entry.
 *
 * @param {any} ws
 * @param {string} topic
 * @param {unknown} [verdict] - from a batch gate already run for this frame
 * @param {{ offset: number, epoch?: number } | null} [recover]
 * @param {number} [pendingToken] - the batch lane's own in-flight stamp for
 *   this topic, which the landing settles in place of taking one
 * @returns {Promise<string | null>}
 */
function gatedSubscribe(ws, topic, verdict, recover, pendingToken, preparedRecovery) {
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
		{ allowSystemTopic: allow_system_topic_subscribe, recover: recover ?? undefined, preparedRecovery },
		verdict,
		// The lane, not an option: a client-initiated subscribe is the one the
		// server-grant gate judges, and the server's own `platform.subscribe`
		// is the grant it judges against. Passed as a parameter of a
		// module-private function for the same reason the verdict is - anything
		// reachable through the platform object is forgeable, and this one
		// decides which of the two authorities is being exercised. The batch
		// lane's stamp rides here for the same reason.
		{ fromWire: true, pendingToken }
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
	// A denial, including the one for a subscribe a revocation overtook while
	// it sat in the gate. A late `subscribed` would desynchronize the client,
	// but SILENCE strands it: a client that keys a promise or a timeout map on
	// `ref` never settles the entry and, without a timeout of its own, waits
	// forever. `FORBIDDEN`, the reason svelte-adapter-uws gives it, tells it
	// the truth - the subscription did not stand - and closes the ref.
	sendSubscribeDenied(ws, topic, ref, result);
}

/**
 * The Bun `websocket` handler set.
 */
function getTransportMetricHooks() { return wsCounters.transportMetricHooks; }
function recordTransportDrop(bytes) { recordBackpressureDrop(wsCounters, { byteLength: bytes }); }
deliveryAuthorization.setIdleHandler(flushCoalescedFor);

export const websocketHandlers = {
	/** @param {any} raw */
	open(raw) {
		const ws = wsFacade(raw, getServer, getTransportMetricHooks, recordTransportDrop);
		// Guarded like every other userData read. A throw out of Bun's open
		// callback would skip `wsConnections.add` below, leaving a live
		// connection invisible to the registry for the rest of its life.
		let userData;
		try {
			userData = ws.getUserData();
		} catch {
			return;
		}
		let carriedRequestId;
		try {
		// Claim the shared slots as own properties before anything reads or
		// writes one: their keys are registered Symbols, and an accessor on
		// Object.prototype for one would otherwise swallow the writes below.
		declareConnectionSlots(userData);
		declareRuntimeConnectionSlots(userData);
		// With admission configured, the upgrade stamps the connection permit on
		// this object before `srv.upgrade` hands it over (handler/upgrade.js), and
		// the close handler below is what releases it. A socket opening without one
		// was admitted past the ceiling's count, so nothing about its accounting
		// can be trusted from here on.
		if (upgradeAdmission !== null) {
			const permitCarried = userData[WS_CONNECTION_PERMIT] === true;
			fatal(permitCarried, 'ws.connection-permit-carrier', null);
			if (!permitCarried) return;
		}
		// A platform slot already set on a fresh open is unrecoverable structural
		// corruption: a re-entrant or duplicate open on the same object, about to
		// overwrite live per-connection state. In production the open runs on
		// until the scheduled exit, as it does on svelte-adapter-uws.
		fatal(!userData[WS_PLATFORM], 'ws.platform-double-init', null);
		userData[WS_SUBSCRIPTIONS] = new Set();

		// Promote the upgrade-time request id (carried on CARRY_REQUEST_ID) into
		// a per-connection platform clone, then drop the carry slot so userData
		// stays clean for hook code. The clone is prototype-linked, so it costs
		// one object per connection and every method still resolves to the
		// shared platform. An id that did not arrive is minted rather than left
		// undefined: every log line for the connection correlates on it.
		const wsPlatform = Object.create(platform);
		carriedRequestId = userData[CARRY_REQUEST_ID];
		// The upgrade always sets it, so only a runtime that stopped handing
		// `open` the object passed to `srv.upgrade` would lose it; say so rather
		// than let the minted id hide it.
		assert(typeof carriedRequestId === 'string', 'ws.request-id-carry', null);
		wsPlatform.requestId = typeof carriedRequestId === 'string' ? carriedRequestId : randomUuid();
		userData[WS_PLATFORM] = wsPlatform;
		delete userData[CARRY_REQUEST_ID];
		assert(userData[CARRY_REQUEST_ID] === undefined, 'ws.request-id-leak', null);

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

		// REGISTERED BEFORE THE FIRST THING THAT CAN CLOSE, and the welcome frame
		// is one: the control-egress budget can refuse it and cut the connection
		// on the spot. The close handler then runs to completion from inside
		// this one - deregistering, releasing the connection permit, and
		// clearing what it needs to - so anything registered after that point
		// would be registered onto a socket already torn down.
		wsConnections.add(ws);
		wsCounters.transportMetricHooks?.connectionOpen(ws);
		try {
			installAttribution(wsModule.attribution, userData);
		} catch {
			console.error('[ws] attribution failed; refusing connection');
			try { ws.end(1008, 'Attribution failed'); } catch { /* already closed */ }
			return;
		}
		sendControl(ws, '{"type":"welcome","sessionId":"' + sessionId + '"}');
		// And the app's `open` is skipped if that happened. The alternative is
		// what this used to do: announce a connection that no longer exists, to
		// a hook whose first `ws.getUserData()` throws, reported as a failed
		// open hook on a connection that never opened. An app is entitled to the ordinary
		// contract, which is that `open` is only called for a connection it can
		// still use, and that `close` never precedes it.
		if (ws._closed) return;
		// Called only for a truthy export, as on svelte-adapter-uws: an
		// `export const open = dev && fn` reads false in production and is
		// skipped, not called and reported.
		} catch (err) {
			wsConnections.delete(ws);
			if (userData[WS_CONNECTION_PERMIT]) {
				userData[WS_CONNECTION_PERMIT] = undefined;
				upgradeAdmission?.releaseConnection();
			}
			emitOperationalEvent({
				source: 'svelte-adapter-bunserve', component: 'runtime.websocket-open',
				event: 'runtime.websocket-open.failed', severity: 'error', dataClass: 'pseudonymous',
				message: 'Connection setup failed after the upgrade completed.',
				attributes: { requestId: userData[WS_PLATFORM]?.requestId ?? carriedRequestId, error: diagnosticError(err) }
			});
			try { ws.end(1011, 'Connection setup failed'); } catch { /* native side already gone */ }
			return;
		}
		if (wsModule.open) runOpenHook(wsModule, ws, { platform: userData[WS_PLATFORM] });
	},

	/**
	 * @param {any} raw
	 * @param {string | Buffer} message
	 */
	async message(raw, message) {
		const ws = wsFacade(raw, getServer, getTransportMetricHooks, recordTransportDrop);
		const messageDone = wsCounters.transportMetricHooks?.messageStart(ws, message);
		let messageFailed = false;
		const onMessageError = messageDone ? () => { messageFailed = true; } : undefined;
		try {
		// Read ONCE, here, and reused by every branch below that reaches it before
		// anything is sent or awaited - nothing on those paths can close the
		// socket first. The app-message path pays the one read it always paid.
		let ud;
		try {
			ud = ws.getUserData();
		} catch {
			return;
		}
		// A message on a connection with no platform slot means open never ran or
		// the slot was clobbered - unrecoverable. One truthiness check on a read
		// this handler makes anyway.
		fatal(ud[WS_PLATFORM], 'ws.platform-missing-in-message', null);
		bumpIn(ws, message);

		// Bun selects the frame type from the payload: a text frame arrives as
		// a string, a binary frame as a Buffer. That replaces the donor's
		// explicit isBinary argument, and it means a control frame check never
		// has to decode bytes - only strings can be control frames.
		const isBinary = typeof message !== 'string';
		if (isBinary && message[0] === 0x03 && ud[WS_CAPS]?.has(WIRE_INGRESS_CAP)) {
			await dispatchIngressFrame(ws, ud, message, ud[WS_PLATFORM], sendControl);
			return;
		}

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
				await runMessageHook(wsModule, ws, { data: message, isBinary, msg: undefined, platform: ud[WS_PLATFORM] }, onMessageError);
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
					await runMessageHook(wsModule, ws, { data: message, isBinary, msg: undefined, platform: ud[WS_PLATFORM] }, onMessageError);
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
					// A re-sent hello REPLACES the prior set, so the live
					// per-capability counts are diffed, not blindly incremented.
					capCounts.adjust(ud[WS_CAPS], caps);
					ud[WS_CAPS] = caps;
					if (caps.has(WIRE_INGRESS_CAP)) sendControl(ws, ingressOkFrame());
					// First-hello lease arm: a client advertising `lease` opts
					// into flow control. Grant-and-observe, the family
					// semantics: the server never gates its own sends on the
					// window - pacing is enforced client-side - it only sizes
					// windows from its posture and observes saturation on
					// replenish. FIRST hello only: a re-sent hello (a lazy
					// plugin re-advertising caps) must not reset the window or
					// repeat the ack.
					if (caps.has('lease') && !ud[WS_LEASE]) {
						const g = grantSizeFor();
						const gate = createLeaseState({ requestCount: g.count, ttlMs: g.ttlMs });
						gate.grant();
						// Zero rather than the gate's own reading. Saturation on
						// this connection is whatever the client reports on
						// request-n; the server consumes no permit, so its mirror
						// has nothing to say about the client's backlog. A window
						// granted a statement ago reads 0 either way.
						ud[WS_LEASE] = { gate, saturation: 0 };
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
					const slot = ud[WS_LEASE];
					if (slot) {
						// Saturation comes from the frame's REPORTED backlog, not
						// from this mirror gate. The server never consumes a
						// permit, so the mirror reads 0 while the window is
						// unexpired and 1 once its TTL lapses - and a lapsed TTL
						// marks an idle client resuming, the opposite of
						// saturation. Reading it here made the documented "a
						// saturated opted-in connection lifts the worker pressure
						// value" mechanism dead code in both adapters.
						//
						// Folded BEFORE the re-grant, because it describes the
						// window being replaced. The client reports how many sends
						// its spent window left waiting; a healthy low-water
						// replenish reports none and leaves the peak untouched.
						slot.saturation = leaseReportedSaturation(msg.queued);
						if (slot.saturation > wsCounters.leaseSaturationPeak) {
							wsCounters.leaseSaturationPeak = slot.saturation;
						}
						const g = grantSizeFor();
						slot.gate.requestN(g.count, g.ttlMs);
						sendControl(ws, leaseGrantFrame(g.count, g.ttlMs));
					}
					return;
				}

				if (msg.type === 'ingress-bind' && typeof msg.id === 'number' && typeof msg.kind === 'string') {
					if (bindIngress(ud, ws, msg.id, msg.kind, msg.target)) {
						sendControl(ws, ingressBoundFrame(msg.id));
					}
					return;
				}

				if (msg.type === 'game') {
					routeGameFrame(ws, undefined, msg, ud[WS_PLATFORM], 0, sendControl);
					return;
				}

				if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
					const subRef = isEchoableRef(msg.ref) ? msg.ref : null;
					// History asked for with no way to answer. EVERY gate and
					// denial on this path - the topic checks included - is silent
					// without a ref, so a recover subscribe carrying none installs
					// nothing and says nothing whatever refused it, and the client
					// replays its offset into a gap it cannot see. Refused first,
					// before anything can swallow it, with the uncorrelatable-error
					// shape. Silence stays right for a ref-less subscribe that asks
					// for no history: that client said it would not listen.
					if (deniesRefLessRecover({
						hasResumeHook: wsModule.resume,
						recover: msg.recover,
						ref: subRef
					})) {
						sendControl(ws, recoverRequiresRefFrame(msg.topic));
						return;
					}
					// A recover offset asks for the missed tail (epoch-checked by
					// the app's resume hook) before going live. Offset and epoch take
					// the subscribe recovery rules. Standalone resume maps remain
					// application-owned; an invalid subscribe recovery value
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
					await applySubscribe(ws, msg.topic, subRef, recover);
					return;
				}

				if (msg.type === 'resume' && typeof msg.sessionId === 'string' &&
					msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
					assert(ud[WS_PLATFORM], 'ws.platform-missing-in-resume', null);
					let resumeSeqs = msg.lastSeenSeqs;
					let resumeEpochs = msg.lastSeenEpochs && typeof msg.lastSeenEpochs === 'object'
						? msg.lastSeenEpochs : undefined;
					// Both client-named maps require confirmed grants when the
					// server owns authorization. Otherwise the hook owns their shape.
					if (wireGrantGateDecides()) {
						const grants = heldSubscriptions(ws);
						const filterGranted = (map) => {
							const allowed = Object.create(null);
							let dropped = false;
							for (const topic of Object.keys(map)) {
								if (deniesUngrantedObserve(true, false, membershipUnconfirmed(ud, topic) ? null : grants, topic)) {
									dropped = true;
									continue;
								}
								allowed[topic] = map[topic];
							}
							return dropped ? allowed : map;
						};
						resumeSeqs = filterGranted(resumeSeqs);
						if (resumeEpochs) resumeEpochs = filterGranted(resumeEpochs);
					}
					if (wsModule.resume) {
						try {
							await wsModule.resume(ws, {
								sessionId: msg.sessionId,
								lastSeenSeqs: resumeSeqs,
								lastSeenEpochs: resumeEpochs,
								platform: ud[WS_PLATFORM]
							});
						} catch (err) {
							reportHookError('resume', err);
						}
					}
					// Standalone resume installs no live membership. The hook is
					// awaited before acknowledging, including a contained failure.
					sendControl(ws, '{"type":"resumed"}');
					return;
				}

				if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
					// The RELEASE always happens, ahead of any bound. A throttled
					// unsubscribe that left the subscription installed would do
					// so silently: the family client sends unsubscribe with NO
					// ref and has no branch for a refusal frame, so a page
					// unmounting a hundred stores would leave the tail of them
					// subscribed and still receiving publishes. Releasing is
					// cheap and is exactly the part that must not be skipped.
					const wasHeld = ud[WS_SUBSCRIPTIONS].has(msg.topic);
					unsubscribeFromWire(ws, msg.topic);
					if (ws._closed) return;
					// The app's unsubscribe hook fires whether or not the
					// connection actually held the subscription: plugin state
					// (a presence roster entry, a cursor attachment) can exist
					// independently of native membership, and skipping the hook
					// would leak it until the socket closed.
					if (!wasHeld) dispatchUnsubscribeHook(ws, msg.topic, false);

					return;
				}

				if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
					const ref = isEchoableRef(msg.ref) ? msg.ref : null;
					if (deniesRefLessRecoverBatch({ hasResumeHook: wsModule.resume, recover: msg.recover, ref })) {
						sendControl(ws, recoverRequiresRefFrame(null));
						return;
					}
					for (let i = MAX_BATCH_TOPICS; i < msg.topics.length; i++) {
						if (typeof msg.topics[i] === 'string') sendSubscribeDenied(ws, msg.topics[i], ref, 'BATCH_OVERFLOW');
					}

					assert(ud[WS_SUBSCRIPTIONS] instanceof Set, 'subs.shape-batch', null);
					const accepted = msg.topics.slice(0, MAX_BATCH_TOPICS);

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
						fresh.push(topic);
					}

					const preDenied = fresh.map((topic) => wireGrantGateDecides() && !isPluginOwnedTopic(topic) && (!held.has(topic) || membershipUnconfirmed(ud, topic)));
					if (fresh.length > 0) {
						// Every topic in the frame is stamped as in-flight BEFORE the hook
						// is awaited. A revocation cancels a subscribe by bumping that
						// topic's in-flight generation, and it can only bump one that
						// exists - so without the stamp, a `platform.unsubscribe` or an
						// `unsubscribe` frame landing while the batch hook is parked finds
						// nothing to cancel and the subscription installs behind it. The
						// single-subscribe lane stamps before its own gate for exactly this
						// reason, and the two spellings of one request have to answer alike.
						let batchUd;
						try {
							batchUd = ws.getUserData();
						} catch {
							return;
						}
						const headroom = Math.max(0, MAX_PENDING_SUBSCRIBES_PER_CONNECTION - pendingSubscribeTotal(batchUd));
						for (let i = headroom; i < fresh.length; i++) {
							sendSubscribeDenied(ws, fresh[i], ref, preDenied[i] ? 'FORBIDDEN' : 'RATE_LIMITED');
						}
						if (headroom < fresh.length) fresh.length = headroom;
						if (fresh.length === 0) return;
						const tokens = fresh.map((topic) => beginPendingSubscribe(batchUd, topic, held.has(topic)));
						// ONE gate call for the whole batch when the app exports
						// `subscribeBatch` - that is the entire reason the hook exists, and
						// calling it per entry would defeat it. Counted as in-flight app work
						// for its whole duration: awaited outside the accounting, pipelined
						// batch frames would open one concurrent gate call each with nothing
						// bounding how many run at once.
						// A COPY, never the array the settle loop walks. Hooks receive an
						// ordinary mutable array, and an app that filters or sorts it in
						// place would leave every token stamped above matched to a
						// different topic - settling entries that are not in flight while
						// the real ones are never settled at all, which spends the
						// connection's in-flight budget permanently and hands a revoked
						// topic the ack that belonged to its neighbour.
						const verdicts = await runWireBatchGates(ws, fresh, tokens, preDenied);
						const recovery = msg.recover && typeof msg.recover === 'object' && typeof wsModule.resume === 'function'
							? await prepareBatchRecovery(ws, fresh, tokens, verdicts, msg.recover) : null;
						const deliveryOperation = deliveryAuthorization.begin();
						try {
							for (let i = 0; i < fresh.length; i++) {
								const topic = fresh[i];
								// The stamp taken above travels into the landing rather than
								// being settled here and re-taken. The landing reads what the
								// record knows about this attempt - whether a revocation
								// cancelled it, and whether live authority backs a membership
								// the batch hook may have installed while it ran - and a fresh
								// stamp would know neither. The topics after this one stay in
								// flight while it lands, so a revocation reaching them now
								// still cancels them.
								const result = await gatedSubscribe(ws, topic, recovery ? recovery[i].denial : verdicts[i], undefined, tokens[i], recovery?.[i]);
								settleSubscribeResult(ws, topic, ref, result);
							}
						} finally { deliveryAuthorization.finish(deliveryOperation); }
					}
					return;
				}
			}
		}

		// Everything else is the app's. `msg` is forwarded when it was already
		// parsed, so a plugin dispatcher does not decode and parse a second
		// time.
		//
		// Application message concurrency is owned by the application.
		// `message` is the app's own protocol: the adapter has no
		// idea which frames are expensive, no way to express a refusal in a
		// protocol it does not define, and no ability to pause Bun's read side.
		// A per-frame app handler is client-paced on every WebSocket server
		// there is; the controls that fit are the app's own concurrency limit
		// and Bun's maxPayloadLength / backpressureLimit, both already exposed.
		await runMessageHook(wsModule, ws, { data: message, isBinary, msg, platform: ud[WS_PLATFORM] }, onMessageError);
		} catch (error) { messageFailed = true; throw error; }
		finally { messageDone?.(messageFailed); }
	},

	/** @param {any} raw */
	drain(raw) {
		const ws = wsFacade(raw, getServer, getTransportMetricHooks, recordTransportDrop);
		let ud;
		try {
			ud = ws.getUserData();
		} catch {
			return;
		}
		if (!deliveryAuthorization.drain(ws)) return;
		assert(ud[WS_PLATFORM], 'ws.platform-missing-in-drain', null);
		// Resume any sendCoalesced traffic backpressure held back, before the
		// app's own drain hook.
		flushCoalescedFor(ws);
		// A truthy export only, for the reason `open` is gated.
		if (wsModule.drain) runDrainHook(wsModule, ws, { platform: ud[WS_PLATFORM] });
	},

	/**
	 * @param {any} raw
	 * @param {number} code
	 * @param {string} message
	 */
	close(raw, code, message) {
		const ws = wsFacade(raw, getServer, getTransportMetricHooks, recordTransportDrop);
		// Deregister FIRST, before anything that could throw. This is the one
		// place where a throw would strand the facade in the live-connection
		// registry permanently - `sendTo` and `forEachSubscriber` would then
		// walk a dead socket on every call for the rest of the process's life,
		// and `connections` would over-report forever.
		wsConnections.delete(ws);
		wsCounters.transportMetricHooks?.connectionClose(ws, code);
		ws._markClosed();
		deliveryAuthorization.closed(ws);

		// Released beside the deregistration because they are the same
		// obligation, and this callback is the only place that runs exactly once
		// per socket. The marker is cleared BEFORE the release rather than
		// after: that is what makes a second close a no-op instead of an
		// over-release, and `releaseConnection` throws on over-release, which
		// here would strand the app's close hook.
		if (upgradeAdmission !== null) {
			const carried = ws._rawUserData();
			if (carried && carried[WS_CONNECTION_PERMIT]) {
				carried[WS_CONNECTION_PERMIT] = false;
				upgradeAdmission.releaseConnection();
			}
		}

		// Readable throughout this handler: the socket is closed for WRITES, but
		// userData is not released until `_markDetached()` in the `finally`
		// below, so the app's close hook can still identify what it is tearing
		// down (uWS keeps it valid for the same window).
		const userData = ws._rawUserData();
		if (!userData) return;
		assert(userData[WS_PLATFORM], 'ws.platform-missing-in-close', null);
		// A slot that is not a Set is corruption the shape checks report on their
		// own paths. Here it must not throw - from the snapshot below or from the
		// `finally` - or the rest of the teardown is abandoned, and there is
		// nothing in it this handler could release, so it releases nothing, as on
		// svelte-adapter-uws.
		const slot = userData[WS_SUBSCRIPTIONS];
		const subscriptions = slot instanceof Set ? slot : new Set();
		// A SNAPSHOT for the hook, not the live set. `runCloseHook` returns at the
		// hook's first await and the `finally` below then clears the set - so an
		// async close hook doing the documented teardown
		// (`for (const t of ctx.subscriptions) await roster.remove(t)`) iterated
		// ZERO topics and leaked every roster entry for the connection, silently.
		// The clear still has to happen (see the note on it below), so the two
		// requirements are met by handing out a copy.
		const teardownTopics = new Set(subscriptions);

		const stats = userData[WS_STATS];
		const closePlatform = userData[WS_PLATFORM];
		// A close this side sent with no status reads 0 to the hook, as it does
		// on svelte-adapter-uws; Bun reports the 1005 it put on the wire.
		if (code === 1005 && ws._noStatusSent) code = 0;
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
			const settling = runCloseHook(wsModule, ws, ctx);
			if (settling) trackCloseHook(settling);
		} finally {
			// Runs even if the app's hook threw: a leaked subscription count
			// would skew every later pressure reading. Settling marks the set,
			// so a release that lands afterwards - an app or plugin continuation
			// resuming after its own await, through any copy of the subscription
			// helpers - charges nothing a second time.
			accountClosedLogicalSubscriptions(subscriptions);
			// Then CLEAR it. The hook was handed a snapshot, so nothing reads the
			// live set from here on, and Bun keeps a socket's data reachable for
			// as long as anything holds the socket.
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
			// The in-flight record and its total go together: a subscribe still
			// parked in its gate settles against the absent record, answers
			// cancelled, and charges nothing.
			userData[WS_PENDING_SUBSCRIBES] = undefined;
			userData[WS_PENDING_SUBSCRIBES_TOTAL] = undefined;
			// sendCoalesced values still queued can never go out now. Bun keeps
			// the socket's data alive for as long as anything holds the ws, so
			// they are released here rather than with it.
			userData[WS_COALESCED] = undefined;
			// RELEASE userData last. Up to here the close hook could read it to
			// identify the connection; from here a continuation resuming after
			// its own await gets the throw its rollback is written against.
			ws._markDetached();
		}
	}
};
