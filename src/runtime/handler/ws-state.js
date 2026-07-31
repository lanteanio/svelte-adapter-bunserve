/**
 * Shared WebSocket runtime state: the live-connection registry, the
 * per-connection userData slots, and the counters the platform reports.
 *
 * Kept separate from handler/state.js (which holds HTTP state) so the WS half
 * can be imported without dragging the static cache in, and so a future
 * shared-core extraction has one obvious file to lift.
 */

import { ws_options } from './config.js';
import { createByteBudget } from '../utils/egress-budget.js';
import { createHookQueue } from '../utils/hook-queue.js';
import {
	beginPending,
	createPending,
	pendingTopics,
	settlePending,
	tombstonePending
} from '../utils/pending-subscribe.js';

/**
 * The Bun server, needed for topic fan-out (`server.publish`) and the native
 * membership count (`server.subscriberCount`). Set once at boot; the platform
 * reads it lazily so importing the platform never requires a running server.
 * @type {import('bun').Server | null}
 */
let server = null;

/** @param {import('bun').Server} srv */
export function setServer(srv) {
	server = srv;
}

/** @returns {import('bun').Server} */
export function getServer() {
	if (server === null) {
		throw new Error(
			'The WebSocket platform was used before Bun.serve() started. ' +
			'platform.publish and friends are only available once the server is listening.'
		);
	}
	return server;
}

/**
 * Per-connection userData slots. Symbols so they cannot collide with anything
 * an app puts on its own userData from the upgrade hook, and so they do not
 * show up in Object.keys / JSON.stringify of user data.
 */
export const WS_SUBSCRIPTIONS = Symbol('subscriptions');
export const WS_PENDING_SUBSCRIBES = Symbol('pendingSubscribes');
export const WS_PENDING_RELEASES = Symbol('pendingReleases');
export const WS_PLATFORM = Symbol('platform');
export const WS_SESSION_ID = Symbol('sessionId');
export const WS_STATS = Symbol('stats');

/**
 * The upgrade-time request id travels as a STRING key, not a Symbol: it is set
 * on the object handed to `server.upgrade(req, { data })` before any socket
 * exists, and is promoted to a per-connection platform clone in `open()` and
 * then deleted, so userData stays clean for hook code.
 */
export const WS_REQUEST_ID_KEY = '__adapter_request_id';

/**
 * Live connections, holding the FACADE (not the raw Bun socket) so identity is
 * stable and every consumer gets the throw-on-closed surface.
 * @type {Set<any>}
 */
export const wsConnections = new Set();

/**
 * Close hooks that have started and not finished.
 *
 * The shutdown drain needs this because Bun invokes the server-side `close`
 * handler SYNCHRONOUSLY inside `raw.close()`: by the time the drain's advisory
 * loop returns, `wsConnections` is already empty, so a settle poll watching the
 * registry has nothing left to wait for and returns immediately. An app whose
 * close hook is async (`await redis.srem(...)`) was then killed mid-flight by
 * the `process.exit(0)` a few milliseconds later. The hook promises are what the
 * drain actually has to wait on.
 * @type {Set<Promise<void>>}
 */
export const pendingCloseHooks = new Set();

/**
 * Track one in-flight close hook. The promise is already rejection-guarded by
 * callHook, so this only needs to know when it settles.
 *
 * @param {Promise<void>} p
 */
export function trackCloseHook(p) {
	pendingCloseHooks.add(p);
	// Promise.resolve() because callHook accepts any thenable (it only requires
	// `.catch`), and a custom thenable without `.finally` would throw out of the
	// close handler AND strand this entry forever - which would then burn the
	// full settle window on every later drain.
	Promise.resolve(p).finally(() => pendingCloseHooks.delete(p));
}

/**
 * True once the shutdown drain has begun. The upgrade lane refuses new
 * connections from this point: the drain advises and closes everything it can
 * SEE, and an upgrade whose async app hook was mid-await when the signal landed
 * would otherwise complete afterwards and hand a brand-new client to a process
 * that is about to exit - with no advisory, no 1012, and a 1006 from stop(true)
 * moments later.
 */
let draining = false;

export function beginDraining() {
	draining = true;
}

/** @returns {boolean} */
export function isDraining() {
	return draining;
}

/**
 * Per-connection subscription cap.
 *
 * This is a real bound, not a formality. One connection reaching it pins a Set
 * entry, a JS string, and an entry in Bun's native topic registry per topic, and
 * subscribe-batch lets a client add hundreds per frame - so a cap set high
 * enough to never fire (the family's historical 1,000,000) bounds nothing and
 * leaves single-connection memory exhaustion available to any unauthenticated
 * client. Apps that legitimately need more raise it explicitly, which is also a
 * prompt to think about whether per-connection fan-in is the right design.
 */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION =
	ws_options?.maxSubscriptionsPerConnection ?? 10_000;

/**
 * Topics whose sequence counter is retained. Unbounded retention is a slow leak
 * on any app that publishes to client-named topics (`room:<uuid>`) with
 * `{ seq: true }`: one Map entry per topic ever published, for the life of the
 * process, with nothing to evict it.
 */
export const MAX_SEQ_TOPICS = 10_000;

export const wsCounters = {
	/**
	 * Sends and subscribes that were refused because the socket had already
	 * closed. This is the lane a closed-socket operation lands in; it must
	 * never be confused with a backpressure drop, which is a different signal
	 * entirely (see utils/send-result.js).
	 */
	closedWsAborts: 0,

	/**
	 * Topic publishes since boot. Monotonic, NOT windowed - it was called
	 * `publishCountWindow` while nothing sampled or reset it, which described a
	 * behaviour that did not exist. Exposed as `platform.publishCount`.
	 */
	publishCount: 0,

	/**
	 * Sum of every connection's subscription count, across the instance.
	 * Exposed as `platform.totalSubscriptions`.
	 */
	totalSubscriptions: 0,

	/** One-shot latch for the async-sendTo-filter warning. */
	sendToAsyncWarned: false,

	/** One-shot latch for the async-adviseReconnect-filter warning. */
	adviseAsyncWarned: false
};

/**
 * Per-topic sequence counters for `{ seq: true }` publishes.
 * @type {Map<string, number>}
 */
export const topicSeqs = new Map();

/**
 * The generation of this process's seq space, stamped once at boot and carried
 * on every `subscribed` ack. A client that reconnects to a RESTARTED server
 * sees a different epoch and knows its remembered sequence numbers refer to a
 * seq space that no longer exists, rather than silently treating the new
 * server's seq 1 as a regression from the old server's seq 5000.
 *
 * Single-process today, so one value covers every topic. A backend with a
 * shared per-topic seq authority would return that topic's stored generation
 * from the same wire field, with no protocol change.
 */
// A random 32-bit value, NOT Date.now(). The only requirement is that it
// differs across restarts; a boot timestamp additionally hands every
// unauthenticated client the exact millisecond the process started, which is
// free uptime and deploy-timing intelligence and a stable fingerprint for
// correlating instances behind a load balancer.
const PROCESS_EPOCH = crypto.getRandomValues(new Uint32Array(1))[0];

/** @returns {number} */
export function processEpoch() {
	return PROCESS_EPOCH;
}

/**
 * Bounded cache of built envelope prefixes, keyed `topic\0event`.
 * @type {Map<string, string>}
 */
export const envelopePrefixCache = new Map();

/**
 * Per-connection wrappers over the pure epoch helpers (utils/pending-subscribe.js),
 * which hold the reasoning and the tests. These only locate the connection's Map.
 *
 * @param {any} ud
 * @param {string} topic
 * @returns {number} token
 */
export function beginPendingSubscribe(ud, topic) {
	let state = ud[WS_PENDING_SUBSCRIBES];
	if (!state) state = ud[WS_PENDING_SUBSCRIBES] = createPending();
	return beginPending(state, topic);
}

/**
 * Distinct topics with a gate in flight on this connection - what the cap
 * counts. See the note in utils/pending-subscribe.js.
 *
 * @param {any} ud
 * @returns {number}
 */
export function pendingSubscribeTopics(ud) {
	return pendingTopics(ud[WS_PENDING_SUBSCRIBES]);
}

/**
 * The connection's installed subscriptions, or an empty set when it is gone.
 *
 * @param {any} ws
 * @returns {Set<string>}
 */
export function heldSubscriptions(ws) {
	try {
		return ws.getUserData()[WS_SUBSCRIPTIONS] ?? EMPTY_SUBSCRIPTIONS;
	} catch {
		return EMPTY_SUBSCRIPTIONS;
	}
}

const EMPTY_SUBSCRIPTIONS = new Set();

/**
 * Authorization gates this connection may have running at once.
 *
 * A SECOND limit, deliberately separate from the subscription cap, because one
 * counter cannot do both jobs. The cap bounds what can INSTALL, and it counts
 * distinct pending topics - N concurrent subscribes to one topic can only ever
 * install one subscription, so counting them N times produced denials that were
 * not true. But that same distinctness means N concurrent gates for one topic
 * cost 1 against the cap, which left concurrent APP WORK unbounded: one socket
 * repeating a single topic, or pipelining batch frames, opened as many
 * concurrent gate calls as it sent frames. The gate is where an app does its DB
 * or Redis round-trip, so that is the expensive thing to bound.
 *
 * The bound itself is asserted in test/unit/ws-state.test.mjs, including the
 * part that makes it mean anything: a gate is counted for as long as it is
 * SUSPENDED, not just while it is being called.
 */
const MAX_CONCURRENT_GATES = ws_options?.maxConcurrentSubscribeGates ?? 64;

/** Per-connection count of gates currently running. */
const WS_GATES = Symbol('inflightGates');

/**
 * Unsubscribe hooks this connection may have running at once, and how many may
 * wait behind them.
 *
 * A THIRD limit, and deliberately not the gate counter. The unsubscribe hook was
 * counted against `WS_GATES` but only CHECKED against it on the speculative lane
 * (a topic the connection never held), which left two defects at once. A client
 * holding the permitted 10,000 subscriptions could pipeline 10,000 `unsubscribe`
 * frames in one read burst and land 10,000 CONCURRENT app hooks - 156x the bound
 * the README advertises - because Bun does not await the message handler. And
 * the increments that were never gated still counted, so an ordinary page
 * unmounting a hundred stores drove the shared counter past 64 and the SUBSCRIBE
 * path answered `RATE_LIMITED` on a connection nowhere near any real limit -
 * a SvelteKit route change, which unmounts the old stores and mounts the new
 * ones in one tick, hit exactly that.
 *
 * Separate counters because the two lanes have different rights: a subscribe
 * gate may be REFUSED (the client is told, and its own frame caused it), while
 * an unsubscribe hook may only be DEFERRED - see utils/hook-queue.js.
 */
const MAX_CONCURRENT_UNSUBSCRIBE_HOOKS = ws_options?.maxConcurrentUnsubscribeHooks ?? 64;

/**
 * The queue is what makes deferral safe rather than unbounded. Each waiting
 * entry is a closure over a topic string already capped at 256 characters, so
 * the ceiling here is memory measured in hundreds of kilobytes per connection at
 * worst, against an unbounded number of concurrent database round-trips without
 * it.
 */
const MAX_QUEUED_UNSUBSCRIBE_HOOKS = ws_options?.maxQueuedUnsubscribeHooks ?? 1024;

const WS_UNSUB_QUEUE = Symbol('unsubscribeHookQueue');

/**
 * Run the app's `unsubscribe` hook under this connection's bound.
 *
 * @param {any} ws
 * @param {() => unknown} task
 * @param {boolean} required - false for a topic this connection never held
 * @returns {'ran' | 'queued' | 'refused' | 'overflow'}
 */
export function runUnsubscribeHook(ws, task, required) {
	let ud;
	try {
		ud = ws.getUserData();
	} catch {
		// The socket is gone; its close hook has already had its turn at the
		// teardown this task duplicates.
		return 'refused';
	}
	let queue = ud[WS_UNSUB_QUEUE];
	if (queue === undefined) {
		queue = createHookQueue({
			concurrency: MAX_CONCURRENT_UNSUBSCRIBE_HOOKS,
			maxQueued: MAX_QUEUED_UNSUBSCRIBE_HOOKS
		});
		ud[WS_UNSUB_QUEUE] = queue;
	}
	return queue.enqueue(task, required);
}

/**
 * Drop this connection's waiting unsubscribe hooks. Their topics stay in the
 * pending-release set, so the close hook is handed them and performs the
 * teardown they did not get to.
 *
 * @param {any} ud
 */
export function clearUnsubscribeHooks(ud) {
	ud?.[WS_UNSUB_QUEUE]?.clear();
}

/**
 * Distinct topics one connection may carry an unowed teardown for.
 *
 * Everything in flight fits with room to spare: the queue admits at most
 * `concurrency + backlog` releases at once, and this is twice that. The slack
 * is for entries an app hook that keeps FAILING leaves behind - those free
 * their queue slot but stay owed, so without a ceiling a connection releasing
 * and re-subscribing in a loop against a broken hook would grow this without
 * limit.
 */
const MAX_PENDING_RELEASE_TOPICS =
	2 * (MAX_CONCURRENT_UNSUBSCRIBE_HOOKS + MAX_QUEUED_UNSUBSCRIBE_HOOKS);

let warnedPendingReleaseFull = false;
/**
 * One-shot: reaching this means the app's `unsubscribe` hook is failing
 * persistently, which is a static fault, not a per-frame condition.
 */
function warnPendingReleaseFull() {
	if (warnedPendingReleaseFull) return;
	warnedPendingReleaseFull = true;
	console.error(
		`[ws] a connection is carrying ${MAX_PENDING_RELEASE_TOPICS} topics whose unsubscribe hook never\n` +
		'  succeeded, so further releases are no longer recorded for the close hook. The usual cause is\n' +
		'  an `unsubscribe` hook that throws or rejects on every call - fix that, and check the errors\n' +
		'  logged above it.'
	);
}

/**
 * Record that a topic is owed a teardown the app has not performed yet.
 *
 * The release itself runs BEFORE the hook is queued, and it deletes the topic
 * from the subscription set. That set is what the close hook is handed, so
 * without this record a hook that is still waiting when the connection closes
 * would be dropped by `clearUnsubscribeHooks` AND be absent from the close
 * hook's snapshot - the app's per-topic state (a presence roster entry, a
 * cursor attachment) would then be released by nobody. A client can drive that
 * on purpose by pipelining more releases than the queue holds.
 *
 * COUNTED, not a plain set membership. One topic can be owed more than one
 * teardown at a time - release it, subscribe it again, release it again - and
 * a set collapses those into one entry that the first hook to finish then
 * deletes, dropping the teardown still owed for the second. The count is what
 * makes "two owed, one settled" expressible.
 *
 * Only topics the connection GENUINELY held are recorded, so a client cannot
 * grow this by naming topics it never had.
 *
 * @param {any} ud
 * @param {string} topic
 */
export function beginPendingRelease(ud, topic) {
	let pending = ud[WS_PENDING_RELEASES];
	if (pending === undefined) {
		pending = new Map();
		ud[WS_PENDING_RELEASES] = pending;
	}
	const owed = pending.get(topic);
	if (owed === undefined && pending.size >= MAX_PENDING_RELEASE_TOPICS) {
		warnPendingReleaseFull();
		return;
	}
	pending.set(topic, (owed ?? 0) + 1);
}

/**
 * Settle one owed teardown for a topic.
 *
 * Only a hook that RESOLVED discharges what it was owed. A hook that threw or
 * rejected ran the app's code but did not necessarily release anything - the
 * realistic shape is `await redis.srem(...)` against a backend that is down -
 * so its topic stays owed and the close hook is told to tear it down. That
 * makes teardown AT LEAST once rather than exactly once; see the note on
 * `pendingReleaseTopics`.
 *
 * @param {any} ud
 * @param {string} topic
 * @param {boolean} released - did the hook resolve?
 */
export function settlePendingRelease(ud, topic, released) {
	if (!released) return;
	const pending = ud?.[WS_PENDING_RELEASES];
	if (pending === undefined) return;
	const owed = pending.get(topic);
	if (owed === undefined) return;
	if (owed <= 1) pending.delete(topic);
	else pending.set(topic, owed - 1);
}

/**
 * The topics still owed a teardown, for the close hook's snapshot.
 *
 * These are handed to the `close` hook IN ADDITION to what the connection still
 * held, so teardown is at-least-once: a hook that was mid-await when the socket
 * died can complete AND have its topic named to the close hook. An app's
 * teardown therefore has to be idempotent, which is documented - the
 * alternative is dropping the release whenever the two race, which is the leak
 * this record exists to close.
 *
 * @param {any} ud
 * @returns {Iterable<string>}
 */
export function pendingReleaseTopics(ud) {
	return ud?.[WS_PENDING_RELEASES]?.keys() ?? EMPTY_SUBSCRIPTIONS;
}

/**
 * Drop the pending-release record once the close hook has been handed it.
 *
 * @param {any} ud
 */
export function clearPendingReleases(ud) {
	if (ud) ud[WS_PENDING_RELEASES] = undefined;
}

/**
 * Control-frame bytes a connection may be sent per window.
 *
 * The ack channel is inherently amplifying - a client names a topic in a few
 * bytes and is answered with a whole frame - and per-entry acks cannot be
 * collapsed without breaking the family client, which keys denials and
 * subscription epochs off them and re-subscribes everything as a batch on every
 * reconnect. So the CHANNEL is bounded instead of the protocol. Generous by
 * design: a reconnect resubscribing a thousand topics spends roughly 60KB.
 */
export const MAX_CONTROL_EGRESS_BYTES = ws_options?.maxControlEgressBytes ?? 4 * 1024 * 1024;

/** Window over which the budget above is measured. */
const CONTROL_EGRESS_WINDOW_MS = 10_000;

const WS_CONTROL_BUDGET = Symbol('controlBudget');

/**
 * Charge control-frame bytes to a connection's budget.
 *
 * The window arithmetic itself is pure (utils/egress-budget.js); this owns only
 * the per-connection slot, created on first use. In practice that is the
 * `welcome` frame every connection is sent at open, so this is lazy in shape
 * rather than in effect - do not read it as an allocation a quiet connection
 * avoids.
 *
 * @param {any} ws
 * @param {number} bytes
 * @returns {boolean} false when this connection has exhausted its window
 */
export function chargeControlEgress(ws, bytes) {
	let ud;
	try {
		ud = ws.getUserData();
	} catch {
		// No connection to charge; the caller's own send will fail anyway.
		return true;
	}
	let budget = ud[WS_CONTROL_BUDGET];
	if (budget === undefined) {
		budget = createByteBudget(MAX_CONTROL_EGRESS_BYTES, CONTROL_EGRESS_WINDOW_MS, () =>
			performance.now()
		);
		ud[WS_CONTROL_BUDGET] = budget;
	}
	return budget(bytes);
}

/**
 * @param {any} ws
 * @returns {boolean} false when this connection already has too many gates open
 */
export function hasGateHeadroom(ws) {
	let ud;
	try {
		ud = ws.getUserData();
	} catch {
		return false;
	}
	return (ud[WS_GATES] ?? 0) < MAX_CONCURRENT_GATES;
}

/**
 * Run `fn` counted as one in-flight gate on this connection.
 *
 * @template T
 * @param {any} ws
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withGateCounted(ws, fn) {
	let ud;
	try {
		ud = ws.getUserData();
	} catch {
		// No connection to charge it to; the call still has to happen so the
		// caller gets a verdict rather than a crash.
		return fn();
	}
	ud[WS_GATES] = (ud[WS_GATES] ?? 0) + 1;
	try {
		return await fn();
	} finally {
		ud[WS_GATES]--;
		if (ud[WS_GATES] < 0) ud[WS_GATES] = 0;
	}
}

/**
 * @param {any} ud
 * @param {string} topic
 * @param {number} token
 * @returns {boolean} whether the subscription may still be installed
 */
export function settlePendingSubscribe(ud, topic, token) {
	return settlePending(ud[WS_PENDING_SUBSCRIBES], topic, token);
}

/**
 * @param {any} ud
 * @param {string} topic
 * @returns {boolean}
 */
export function tombstonePendingSubscribe(ud, topic) {
	return tombstonePending(ud[WS_PENDING_SUBSCRIBES], topic);
}

/**
 * Stamp the next sequence number for a topic, or null when this publish opted
 * out. An explicit numeric `seq` is passed through verbatim (a cluster-
 * authoritative value); `{ seq: true }` draws from the local counter.
 *
 * @param {{ seq?: boolean | number } | undefined} options
 * @param {string} topic
 * @returns {number | null}
 */
export function stampSeq(options, topic) {
	if (!options || options.seq === undefined || options.seq === false) return null;
	if (typeof options.seq === 'number') return options.seq;
	const current = topicSeqs.get(topic);
	const next = (current ?? 0) + 1;
	// Re-insert on every stamp so iteration order is least-recently-stamped
	// first, which makes the eviction below a true LRU.
	if (current !== undefined) topicSeqs.delete(topic);
	topicSeqs.set(topic, next);
	if (topicSeqs.size > MAX_SEQ_TOPICS) {
		const oldest = topicSeqs.keys().next().value;
		if (oldest !== undefined) topicSeqs.delete(oldest);
		if (!seqEvictionWarned) {
			seqEvictionWarned = true;
			console.warn(
				`[ws] more than ${MAX_SEQ_TOPICS} topics have been published with { seq: true }; ` +
				'the least recently used counters are being evicted. An evicted topic restarts ' +
				'its sequence at 1, so a client holding an older seq for it sees the number go ' +
				'backwards. Publish without { seq: true } on high-cardinality topics, or scope ' +
				'them so the working set stays under the cap.'
			);
		}
	}
	return next;
}

let seqEvictionWarned = false;
