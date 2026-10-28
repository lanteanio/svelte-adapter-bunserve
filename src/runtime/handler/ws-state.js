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
import { processMonotonicNow, randomBytes as randomOctets } from '../runtime.js';
import { explicitSeqValue, throwInvalidSeq } from '../utils/publish-seq.js';
import { createCapCounts } from '../utils/wire.js';
import { assert } from '../utils/assertions.js';
import { formatDiagnostic } from '../diagnostic-format.js';
import {
	WS_ATTRIBUTION,
	WS_CAPS,
	WS_INGRESS_BINDINGS,
	WS_PENDING_SUBSCRIBES,
	WS_PENDING_SUBSCRIBES_TOTAL,
	WS_PLATFORM,
	WS_PUBLISH_GRANT,
	WS_SESSION_ID,
	WS_SUBSCRIPTIONS,
	setSubscriptionAccountingHook
} from '../utils/ws-symbols.js';

export {
	WS_PENDING_SUBSCRIBES,
	WS_PENDING_SUBSCRIBES_TOTAL,
	WS_PLATFORM,
	WS_SESSION_ID,
	WS_SUBSCRIPTIONS,
	beginPendingSubscribe,
	isPendingSubscribeCancelled,
	settlePendingSubscribe,
	tombstonePendingSubscribe
} from '../utils/ws-symbols.js';

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
 * show up in Object.keys / JSON.stringify of user data. The subscription,
 * in-flight subscribe and platform slots live in utils/ws-symbols.js beside the
 * helpers that move them.
 */
export const WS_STATS = Symbol.for('adapter-uws.ws.stats');

/**
 * The connection's `platform.sendCoalesced` queue: a Map from key to the one
 * pending { topic, event, data }, created on first use.
 */
export const WS_COALESCED = Symbol.for('adapter-uws.ws.coalesced');

/**
 * Distinct `sendCoalesced` keys one connection may hold pending. A new key at
 * the cap evicts the oldest pending one - latest value wins is the contract,
 * so the oldest is the most stale value to lose. The figure svelte-adapter-uws
 * uses.
 */
export const MAX_COALESCED_KEYS_PER_CONNECTION = 1_000_000;

/**
 * The capability tokens this connection declared in its `hello` frame. Absent
 * on connections that never sent one - old clients - which is the safe-default
 * "no opt-in features" signal every capability consumer keys on.
 */
export { WS_CAPS } from '../utils/ws-symbols.js';

/**
 * The connection's send-gate window, present only after a `hello` carrying the
 * `lease` capability armed flow control (first hello only - a re-sent hello
 * never resets the window). Shape: `{ gate, saturation }` where `gate` is a
 * createLeaseState machine and `saturation` its last observed 0..1 reading -
 * which today always reads 0, because the observation happens after the
 * re-grant (see the request-n lane in handler/ws.js).
 */
export const WS_LEASE = Symbol.for('adapter-uws.ws.lease');

/**
 * Live per-capability connection counts across the instance, maintained by the
 * `hello` handler and released on close. The binary publish fast path asks
 * this ONE question - "does any connected client want binary for this codec?" -
 * to skip the per-subscriber walk entirely on JSON-only deployments.
 */
export const capCounts = createCapCounts();

/**
 * Per-connection binary topic-id slot (`{ byName, next }`), managed by
 * utils/wire.js allocWireId. Reset with the connection: a reconnect is a new
 * connection with a fresh id space and fresh announces.
 */
export const WS_TOPIC_IDS = Symbol.for('adapter-uws.ws.topic-ids');

/**
 * Per-connection stateful wire-codec entries, keyed by capability:
 * `{ state, detach }`, or the poisoned sentinel `{ state: null, poisoned }`.
 * See handler/wire-state.js for the lifecycle.
 */
export const WS_WIRE_STATE = Symbol.for('adapter-uws.ws.wire-state');

/**
 * Topics whose SHARED binary cohort this connection joined, so close releases
 * exactly the shared wire-id refs it acquired and no others.
 */
export const WS_SHARED_COHORTS = Symbol.for('adapter-uws.ws.shared-cohorts');

/**
 * Topics running shared binary fan-out, topic -> the capability whose codec
 * marked them shared. The first shared publish to a topic migrates its
 * current subscribers into cohorts and records it here, so every later
 * subscriber is cohorted at subscribe time instead.
 * @type {Map<string, string>}
 */
/**
 * Wire-subscribe authorization arming, worker-wide.
 *
 * `enabled` is set from `websocket.authorizeWireSubscribe` at boot and can be
 * turned on later through `platform.authorizeWireSubscribe()` - the spelling a
 * framework whose subscriptions are all server-initiated uses at startup. It
 * latches false -> true and is never turned back off: a gate that can be
 * disarmed at runtime is not a gate, and every lane reads this fresh rather
 * than snapshotting it, so arming mid-flight tightens the in-flight frames
 * instead of leaving them judged under the old posture.
 *
 * `strict` makes the two authorities conjunctive - a server grant AND an app
 * hook allow - and latches the same way, so a later no-argument call cannot
 * downgrade a strict worker.
 */
export const subscribeAuth = { enabled: false, strict: false };

export const sharedTopics = new Map();

/**
 * The highest EXPLICIT (cluster-authoritative) sequence number this server has
 * stamped per topic. ONE seq space: a counter publish - which is every publish
 * that neither hands in a number nor opts out with `{ seq: false }`, the
 * default included - draws from the local per-topic counter, an unrelated
 * space, and never writes a value here.
 *
 * The resume barrier is the only consumer, and it asks this map a single
 * question - what is the highest seq this server could have issued for the
 * topic - both as the fallback dedup floor when a resume hook reports no
 * watermark, and as the ceiling on a watermark a hook does report. A map
 * holding the max of two spaces cannot answer that for a topic published both
 * ways, which is why the counter lane stays out of it.
 *
 * Bounded exactly like `topicSeqs`, by the same second-chance eviction and for
 * the same reason: an app that publishes explicit seqs to client-named topics
 * (`room:<uuid>`) would otherwise grow one entry per topic ever published, for
 * the life of the process. An evicted topic loses its mark outright, and a
 * resume then dedups nothing for it: every reported watermark is refused and
 * the whole held window re-delivers, up to `MAX_RESUME_BUFFERED_FRAMES`.
 * Duplicates, never a gap - and a quiet topic is the one the eviction reaches
 * for, but see `evictOne` for the case where it cannot find one.
 * @type {Map<string, number>}
 */
export const maxAuthoritativeSeq = new Map();

/**
 * Note one published seq against a topic's authoritative high-water mark,
 * bounded by the second-chance eviction in `evictOne`.
 *
 * An `authoritative` (explicit numeric, cluster-stamped) seq may arrive
 * reordered, so the mark only ever moves UP.
 *
 * A seq no comparison can order - a NaN - is refused rather than stored. It
 * could never raise the mark, storing one would erase a real seq, and the flush
 * reads this map for a ceiling a NaN would make meaningless.
 *
 * A counter seq is not a value this mark can hold, so it refreshes recency and
 * nothing else, and only for a topic that already has a mark: the counter lane
 * must never be what creates an entry here. Keeping a topic that is busy in
 * the counter lane from aging out of this one is the whole point of that
 * refresh - and with the counter now the DEFAULT, every publish to a marked
 * topic reaches it.
 *
 * @param {string} topic
 * @param {number} seq
 * @param {boolean} authoritative - true for an explicit numeric `seq`
 */
export function notePublishedSeq(topic, seq, authoritative) {
	if (typeof seq !== 'number' || Number.isNaN(seq)) return;
	const prev = maxAuthoritativeSeq.get(topic);
	if (prev !== undefined) {
		if (maxAuthoritativeSeq.size >= MAX_SEQ_TOPICS) {
			noteRecentlyUsed(maxAuthoritativeSeqRecent, topic);
		}
		// Recency only for a counter seq. A value it cannot hold must not be
		// written, and there is nothing else left to do.
		if (!authoritative) return;
		if (seq > prev) maxAuthoritativeSeq.set(topic, seq);
		return;
	}
	// No entry yet, and the counter lane must never be what creates one -
	// that would put a local value in the authoritative space.
	if (!authoritative) return;
	if (maxAuthoritativeSeq.size >= MAX_SEQ_TOPICS) {
		evictOne(maxAuthoritativeSeq, maxAuthoritativeSeqRecent);
		// Its own warning, and its own latch, because this map's harm is not the
		// counter map's. A lost counter restarts a number; a lost mark takes a
		// resume dedup floor with it, and the remedy differs too - an explicit
		// seq is what CREATES a mark here, so there is no publish-side opt-out
		// to point at.
		if (!markEvictionWarned) {
			markEvictionWarned = true;
			console.warn(
				`[ws] more than ${MAX_SEQ_TOPICS} topics carry an explicit seq; the oldest resume ` +
				'dedup floors are being evicted. A topic that has gone quiet goes first, but where ' +
				'the oldest marks are all still being published to, one of THOSE is evicted. A resume ' +
				'on an evicted topic dedups nothing and re-delivers its whole held window. Scope the ' +
				'topics so the working set of explicitly-stamped ones stays under the cap.'
			);
		}
	}
	maxAuthoritativeSeq.set(topic, seq);
}

let markEvictionWarned = false;

/**
 * Mark a key as used since the last eviction swept past it.
 *
 * This is the recency half of the eviction below, and it is deliberately a
 * Set rather than the re-insert it replaced. Keeping a Map in
 * least-recently-used ORDER means deleting and re-adding the key on every
 * touch, and Map.delete is not flat in map size: measured under Bun, a
 * delete-then-set at the 10,000-entry bound costs about 700 ns, more than an
 * order of magnitude above a plain set. Since the counter became the default
 * that cost sat on every publish, and it was worst exactly where the map is
 * full - the state a busy deployment lives in. The per-publish figures are in
 * bench/publish-seq-default-micro.mjs, which reports all three regimes.
 *
 * The flag is only worth setting while something can be evicted, which is only
 * while the map is at the cap.
 *
 * @param {Set<string>} recent
 * @param {string} key
 */
export function noteRecentlyUsed(recent, key) {
	// Only when the flag is not already held: re-adding cannot grow the Set, so
	// clearing on that path would throw away every earned flag for nothing.
	if (!recent.has(key) && recent.size >= MAX_SEQ_TOPICS) recent.clear();
	recent.add(key);
}

/**
 * How many entries one eviction will examine before it stops looking for an
 * unflagged victim and takes the oldest it saw.
 *
 * Without a limit, a sweep across a map where everything is flagged does work
 * proportional to the whole map on a single insert. With it, one eviction
 * costs at most this many re-inserts - and reaching the limit means at least
 * this many DISTINCT topics were published to since the last eviction, so the
 * cost is amortized against at least that many stamps.
 */
export const SWEEP_LIMIT = 32;

/**
 * Evict one entry, second-chance style: sweep from the oldest, spend the used
 * flag of anything touched since the last sweep, and evict the first entry
 * that had none.
 *
 * A SPARED ENTRY IS MOVED TO THE BACK, and that is the load-bearing half. The
 * map is the eviction queue, so an entry left where it is comes up again on
 * the very next eviction with its flag already spent - a reprieve of exactly
 * one eviction, which is not the property this is here for. Requeued, it gets
 * a full lap: a topic still being published to survives as many evictions as
 * there are entries ahead of it.
 *
 * WITH ONE EXCEPTION, and it is not a rare one on the workload that reaches
 * this bound at all: the sweep gives up after `SWEEP_LIMIT` entries. When
 * every entry it examined was in use there is no quiet victim within reach,
 * and the oldest of the examined entries is evicted even though it was
 * published to. So an ACTIVE topic can be evicted, and can restart its
 * counter at 1, whenever the oldest stretch of the queue is uniformly hot.
 * Scanning further to avoid it is the unbounded sweep the limit exists to
 * prevent, and at a working set genuinely larger than the cap no policy can
 * evict only quiet topics - there are none. Both maps warn once when they
 * start evicting, and both warnings state this case.
 *
 * That is what makes this CLOCK rather than exact LRU. The requeue is paid
 * only while evicting, which happens only when a NEW topic arrives at a full
 * map, and only for topics that earned a flag; exact LRU pays the same
 * re-insert on every touch of every topic, which is the cost that does not
 * scale. What is given up is precision among entries that were all touched
 * within the same lap, and the guarantee above at the window's edge.
 *
 * The map must not be mutated while its own key iterator is live - an entry
 * re-added during iteration is visited again - so the spared keys are
 * collected first and requeued after the sweep.
 *
 * Exported for the unit lane: every property above is about eviction ORDER
 * over many rounds, and reaching it through the two live maps means filling
 * ten thousand entries per assertion. Driven directly with a handful of keys,
 * a full lap is five rounds.
 *
 * @param {Map<string, number>} map
 * @param {Set<string>} recent
 */
export function evictOne(map, recent) {
	/** @type {string[]} */
	const spared = [];
	/** @type {string | undefined} */
	let victim;
	for (const key of map.keys()) {
		if (!recent.delete(key)) {
			victim = key;
			break;
		}
		spared.push(key);
		if (spared.length >= SWEEP_LIMIT) break;
	}
	// Every entry the sweep looked at was in use. Take the oldest of them: it
	// is the one that has gone longest without being re-inserted, and the
	// alternative is scanning a map that is entirely hot.
	if (victim === undefined) victim = spared.shift();
	if (victim === undefined) return;
	map.delete(victim);
	// Requeue AFTER the iterator is done with the map.
	for (let i = 0; i < spared.length; i++) {
		const key = spared[i];
		const value = map.get(key);
		if (value === undefined) continue;
		map.delete(key);
		map.set(key, value);
	}
}

/**
 * Used-since-last-sweep flags for the two bounded seq maps.
 *
 * Exported beside the maps they belong to, and for the same reason: the
 * policy they encode - a flag is only worth setting while something can be
 * evicted, and only one is ever spent per sweep - is invisible from the
 * outside until a map is at its cap, which is ten thousand entries away from
 * anything a test would otherwise set up.
 */
export const topicSeqsRecent = new Set();
export const maxAuthoritativeSeqRecent = new Set();

/**
 * Drop every per-topic seq counter, mark and recency flag.
 *
 * The recency flags are module-private, so a caller clearing the two maps
 * directly would leave them behind - and a flag for a topic name that is later
 * re-created spares it an eviction it never earned. That is a determinism
 * hazard rather than a leak (the flags are bounded), which is exactly the kind
 * of state the simulation reset exists to put back to zero.
 */
export function resetSeqState() {
	topicSeqs.clear();
	maxAuthoritativeSeq.clear();
	topicSeqsRecent.clear();
	maxAuthoritativeSeqRecent.clear();
}

/**
 * Open live-frame buffers per topic with a resume in flight, topic -> the Set
 * of buffers capturing it. Read by every fan-out site behind a single
 * `.size > 0` guard, so a deployment that never resumes pays one integer
 * compare per publish.
 * @type {Map<string, Set<{ ws: any, frames: { seq: number | null, envelope: string, compress: boolean, authoritative: boolean }[], overflow: boolean }>>}
 */
export const resumeBuffers = new Map();

/**
 * Frames one resume buffer holds at most. Past it the buffer is marked
 * overflowed and the flush signals a truncation instead of trusting a partial
 * window - the client has no gap detection, so a silent hole is the one
 * outcome this must never produce.
 */
export const MAX_RESUME_BUFFERED_FRAMES = 4096;

/**
 * Append one published frame to every open buffer for its topic. Called from
 * the fan-out sites only when some buffer is open.
 *
 * `excludeWs` is the one socket a publish suppressed (author echo): a buffer
 * belonging to that connection must not capture the frame, or the flush would
 * hand a resuming author the very frame it was excluded from. `authoritative`
 * marks a frame stamped with an explicit numeric seq; only those are deduped
 * against the flush floor, because a counter-stamped live frame is always
 * newer than the resume window and lives in a different seq space than an
 * explicit floor.
 *
 * @param {string} topic
 * @param {number | null} seq
 * @param {string} envelope
 * @param {boolean} compress
 * @param {any} [excludeWs]
 * @param {boolean} [authoritative]
 */
export function captureResumeFrame(topic, seq, envelope, compress, excludeWs, authoritative) {
	const set = resumeBuffers.get(topic);
	if (set === undefined) return;
	for (const b of set) {
		if (excludeWs !== undefined && excludeWs !== null && b.ws === excludeWs) continue;
		if (b.frames.length >= MAX_RESUME_BUFFERED_FRAMES) {
			b.overflow = true;
			continue;
		}
		b.frames.push({ seq, envelope, compress, authoritative: authoritative === true });
	}
}

/**
 * Carries the upgrade-time request id from `server.upgrade(req, { data })` to
 * `open()`, which promotes it to the per-connection platform clone and deletes
 * the slot, so userData stays clean for hook code.
 *
 * A Symbol no other code can name, never a string: assigning a string key goes
 * through any setter Object.prototype has for that name, so a preload or
 * polyfill defining one would take the value, and a hook spreading client JSON
 * into its userData could name it. Bun hands `open` the very object passed to
 * `upgrade()`, so a Symbol key arrives intact (probe: upgrade-data).
 */
export const CARRY_REQUEST_ID = Symbol('adapter.carryRequestId');

/**
 * Marks a socket whose handshake reserved a connection permit, so `close`
 * releases exactly the permits that were taken. The shared family symbol
 * keeps connection accounting consistent across adapter modules.
 */
export const WS_CONNECTION_PERMIT = Symbol.for('adapter-uws.ws.connection-permit');

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
 * runCloseHook (utils/hook-boundary.js), so this only needs to know when it
 * settles.
 *
 * @param {Promise<void>} p
 */
export function trackCloseHook(p) {
	pendingCloseHooks.add(p);
	// Promise.resolve() because a hook may return any thenable, and a custom
	// one without `.finally` would throw out of the close handler AND strand
	// this entry forever - which would then burn the full settle window on
	// every later drain.
	Promise.resolve(p).finally(() => pendingCloseHooks.delete(p));
}

/**
 * True once the shutdown drain has begun. The upgrade lane refuses new
 * connections from this point: the drain advises and closes everything it can
 * SEE, and an upgrade whose async app hook was mid-await when the signal landed
 * would otherwise complete afterwards and hand a brand-new client to a process
 * that is about to exit - with no advisory, no 1001, and a 1006 from stop(true)
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
 * Count one refused upgrade under the reason that refused it.
 *
 * An unrecognised reason is ignored rather than counted or thrown on: a
 * mistyped label must not invent a counter nobody reads, and a refusal path is
 * the last place that should be able to throw.
 *
 * @param {string} reason one of `UPGRADE_REJECTION_REASONS`
 */
export function recordUpgradeRejection(reason) {
	if (!(reason in wsCounters.upgradeRejectedByReason)) return;
	wsCounters.upgradeRejectedByReason[reason]++;
	wsCounters.upgradeRejectedTotal++;
}

/**
 * The refusal counts as they stand, keyed by reason. A copy, so a caller that
 * holds one is reading the moment it asked about rather than an object that
 * moves underneath it.
 *
 * @returns {Record<string, number>}
 */
export function upgradeRejectionCounts() {
	return { ...wsCounters.upgradeRejectedByReason };
}

/**
 * Un-latch the drain flag (simulation/test harness only). Production never
 * un-drains - the process exits - but a sim runs many seeds in one process,
 * and a drain-lane scenario would otherwise leave every later seed's upgrades
 * refused with a 503.
 */
export function resetDraining() {
	draining = false;
}

export {
	MAX_PENDING_SUBSCRIBES_PER_CONNECTION,
	MAX_SUBSCRIPTIONS_PER_CONNECTION
} from '../utils/caps.js';

/**
 * Topics whose per-topic seq state is retained - the cap on `topicSeqs` and on
 * `maxAuthoritativeSeq` alike. Unbounded retention is a slow leak on any app
 * that publishes to client-named topics (`room:<uuid>`) with a seq: one Map
 * entry per topic ever published, for the life of the process, with nothing to
 * evict it.
 */
export const MAX_SEQ_TOPICS = 10_000;

/**
 * Why a WebSocket upgrade was refused before it opened.
 *
 * svelte-adapter-uws's label set for `upgrade_rejected_total{reason}`, narrowed
 * to the refusals this adapter can actually perform, so a refusal reads as the
 * same word on both and a dashboard built against one is not quietly wrong
 * against the other. What uws has and this list does not:
 *
 * - `siege` belongs to `protection`. Each label arrives with the feature, which
 *   is how `auth_timeout`, `ip_rate_limit` and `auth_rate_limit` got here.
 * - `duplicate_header` and `ambiguous_framing` belong to uws's reading of the
 *   handshake's whole header set: a repeated Host, Origin, Authorization,
 *   Proxy-Authorization or Content-Type, and a framing header said twice or
 *   sent empty. Bun joins a repeated one of those five into one value with
 *   ", ", and refuses the framing conflicts its own parser recognises with a
 *   400 before the adapter is entered.
 *
 * A refusal the RUNTIME makes (a handshake Bun itself rejects) is counted by
 * neither adapter.
 *
 * `draining` is the one label with no uws counterpart, because uws has no such
 * refusal: it does not turn upgrades away while shutting down. Leaving it out
 * would have made the total quietly wrong during exactly the window an operator
 * is watching a rollout, so it is carried as a documented extra rather than as
 * a gap - a dashboard reading by reason sees one more series here, and nothing
 * it reads means something different.
 */
export const UPGRADE_REJECTION_REASONS = Object.freeze([
	// A handshake no one could complete, refused before every other reason.
	'malformed_handshake',
	'over_capacity',
	'cursor_lane',
	'connection_capacity',
	'deferred_overflow',
	'bad_origin',
	'ip_rate_limit',
	// The auth preflight's own limit. It counts here, on the upgrade series,
	// because the sibling counts it here: a refused preflight is a socket that
	// never opens, and a dashboard reading upgrade refusals by reason would
	// otherwise be blind to the door that turned the client away first.
	'auth_rate_limit',
	'auth_rejected',
	'auth_timeout',
	'hook_error',
	'draining'
]);

/**
 * A counts-by-reason bag with every reason present and zero.
 *
 * Null-prototype so a reason can never collide with an inherited key, and
 * seeded so a read before the first refusal reports zeroes rather than an
 * object that grows a key at a time - a consumer should not have to tell
 * "no refusals yet" from "that reason does not exist".
 *
 * @returns {Record<string, number>}
 */
function seedRejectionCounts() {
	/** @type {Record<string, number>} */
	const counts = Object.create(null);
	for (const reason of UPGRADE_REJECTION_REASONS) counts[reason] = 0;
	return counts;
}

export const wsCounters = {
	droppedFramesWindow: 0,
	droppedBytesWindow: 0,
	transportMetricHooks: null,
	/**
	 * Sends and subscribes that were refused because the socket had already
	 * closed. This is the lane a closed-socket operation lands in; it must
	 * never be confused with a backpressure drop, which is a different signal
	 * entirely (see utils/send-result.js).
	 */
	closedWsAborts: 0,

	/**
	 * Topic publishes since boot. Monotonic and never reset, so the name says
	 * exactly that rather than implying a sampling window. Exposed as
	 * the `ws_publishes_total` metric.
	 */
	publishCount: 0,

	/**
	 * Sum of every connection's subscription count, across the instance.
	 * Read out through the `ws_subscriptions` metric.
	 */
	totalSubscriptions: 0,

	/** One-shot latch for the async-sendTo-filter warning. */
	sendToAsyncWarned: false,

	/** One-shot latch for the async-adviseReconnect-filter warning. */
	adviseAsyncWarned: false,

	/**
	 * Publishes since the last pressure sample - the windowed companion to the
	 * monotonic `publishCount`, drained and zeroed by each sampler tick to
	 * produce `publishRate`. Bumped on every publish lane alongside the
	 * monotonic counter.
	 */
	publishCountWindow: 0,

	/** The window drained by the previous sampler tick (introspection). */
	lastPublishCount: 0,

	/**
	 * Publish-egress accounting for the current pressure window, drained into
	 * `pressureSnapshot.egress` each sampler tick and reset: local deliveries
	 * and wire bytes charged, and publishes refused by a configured
	 * `websocket.egress` ceiling, per scope. Charged by
	 * handler/publish-egress.js, the one charge point every publish-family
	 * fan-out calls.
	 */
	egressDeliveriesWindow: 0,
	egressBytesWindow: 0,
	egressRefusedTopicWindow: 0,
	egressRefusedTenantWindow: 0,

	/**
	 * Monotonic egress totals, projected at scrape time as
	 * `egress_refused_total{scope}` and `egress_window_evicted_total{scope}`.
	 * Seeded with the whole scope vocabulary so both series exist as zeroes
	 * from the first scrape - a flat line reads as "nothing refused", a gap
	 * reads as a missing exporter.
	 */
	egressRefusedByScope: { topic: 0, tenant: 0 },
	egressEvictedByScope: { topic: 0, tenant: 0 },

	/** Connection count at the previous sampler tick. */
	lastConnections: 0,

	/**
	 * The memory-wall reading (utils/memory-wall.js) at the previous sampler
	 * tick: what the send-gate window sizer reads; no known wall contributes zero.
	 */
	lastHeapUsedRatio: 0,

	/** @type {number | null} No sample or no known memory wall. */
	lastMeasuredHeapUsedRatio: null,

	/**
	 * The UNLAYERED pressure reason of the previous sample - what the raw
	 * thresholds said before any capacity posture was folded in. The posture
	 * machine ticks on this one, never the layered reason, so its own effect
	 * cannot feed back and prevent relaxation.
	 * @type {'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI'}
	 */
	lastBasePressureReason: 'NONE',

	/**
	 * Wall-clock ms of the previous sampler tick. A stalled (unref'd) sampler
	 * is observable here: the snapshot goes stale and this stops advancing.
	 */
	lastSampleWallMs: 0,

	/**
	 * Worker peak of the client's advisory backlog ratio (`queued / 256`,
	 * clamped to 0..1), written on `request-n`. The sampler folds it into
	 * pressure.value, then halves the retained peak each tick. It does not
	 * change the pressure reason or the size of a grant.
	 */
	leaseSaturationPeak: 0,

	/**
	 * The protection posture machine, or null when `websocket.protection` is
	 * unset ('normal') - the zero-config posture. The sampler null-checks it;
	 * `platform.protection` reads 'normal' through the null.
	 * @type {{ level: string, tick: (s: { active: boolean }) => void } | null}
	 */
	activePosture: null,

	/**
	 * Null seams for the metrics registry and posture-export features (both
	 * recorded parity gaps). The sampler calls them null-checked at the end of
	 * every tick so the features can attach without touching the sampler.
	 * @type {(() => void) | null}
	 */
	metricsSampleHook: null,
	/** @type {(() => void) | null} */
	postureExportHook: null,

	/**
	 * WebSocket upgrades refused before open, by reason, and their total.
	 *
	 * Here rather than on the admission controller, which is the obvious home
	 * and the wrong one: that controller does not exist unless
	 * `websocket.upgradeAdmission` is configured, and most of these refusals
	 * have nothing to do with admission. An origin refusal on a server with no
	 * ceiling would have been counted nowhere, and the exporter that closes the
	 * metrics parity gap would have published zeroes for it - the silent kind of
	 * divergence, where the number exists and is wrong.
	 *
	 * @type {Record<string, number>}
	 */
	upgradeRejectedByReason: seedRejectionCounts(),
	upgradeRejectedTotal: 0,

	/**
	 * WebSocket upgrades that completed, since boot. The counterpart to the
	 * refusals above, and the denominator that makes them readable: a refusal
	 * count alone cannot tell a server turning away one client in a thousand
	 * from one turning away every second client.
	 *
	 * Monotonic for the life of a server, unlike the live connection count, which
	 * is what makes it a rate rather than a level. The simulator clears it
	 * between seeds along with the refusals, because there a "life" is one run
	 * and a counter carried across them makes a hypothesis depend on how many
	 * seeds preceded it.
	 */
	upgradeAdmittedTotal: 0,
	/** Active, connected upgrade attempts measured independently of admission. */
	upgradeInFlight: 0,

	/**
	 * Pressure-reason changes, keyed `from>to`. Bounded by the reason
	 * vocabulary squared - seven reasons, so at most 49 entries, and in practice
	 * a handful.
	 *
	 * A transition count is what makes the reason gauge alertable: the gauge says
	 * what is wrong now, and only the transitions say whether the server has been
	 * flapping between healthy and saturated all night.
	 *
	 * @type {Map<string, number>}
	 */
	pressureReasonTransitions: new Map()
};

/**
 * Move `wsCounters.totalSubscriptions` by one membership change: +1 on an
 * install, -1 on a release. This is the worker's subscription-accounting sink,
 * so it is reached only through add/removeLogicalSubscription and the close
 * settle in utils/ws-symbols.js, never written beside a Set mutation by hand.
 *
 * The total can never go negative: a release the counter has no install for is
 * corruption somewhere upstream, and the clamp keeps it from poisoning the
 * pressure reading and every later close, while the assertion makes it visible.
 *
 * The topic every delta carries is not read. Egress here reads Bun's native
 * subscriber count, so there is no per-topic tally to keep beside the total.
 *
 * @param {number} delta
 * @param {string} [_topic]
 */
export function adjustTotalSubscriptions(delta, _topic) {
	const next = wsCounters.totalSubscriptions + delta;
	if (next < 0) {
		assert(false, 'subs.total-negative', { totalSubscriptions: next });
		wsCounters.totalSubscriptions = 0;
	} else {
		wsCounters.totalSubscriptions = next;
	}
}

// One sink per worker, shared by every copy of the subscription helpers. A
// second runtime in the same worker would take it from this one: each keeps its
// own counter, so the displaced one freezes while the other is charged releases
// it never matched - a total stuck under the live memberships on one side and
// driven negative on the other, with neither saying why. Reported rather than
// asserted, because the condition is about a deployment carrying two runtimes,
// and a soft assertion throws in test mode.
if (setSubscriptionAccountingHook(adjustTotalSubscriptions)) {
	try {
		console.warn(formatDiagnostic({
			source: 'svelte-adapter-bunserve',
			component: 'runtime.subscription-accounting',
			event: 'runtime.subscription-accounting.sink-displaced',
			severity: 'warn',
			dataClass: 'operational',
			message: 'A second adapter runtime in this worker took over the subscription accounting sink. One subscription total is now frozen and the other is charged releases it never matched.',
			attributes: {}
		}));
	} catch { /* console gone */ }
}

/**
 * Per-topic sequence counters. This is the DEFAULT seq space: a publish
 * draws from it unless it says `{ seq: false }` or hands in an explicit
 * number, so `{ seq: true }` is one spelling of the default rather than the
 * only way in.
 * @type {Map<string, number>}
 */
export const topicSeqs = new Map();

/**
 * Per-topic publish counts and envelope bytes since the last pressure sample:
 * `topic -> { m, b }`. Bumped on every publish lane beside the window
 * counter, drained into `topPublishers` and cleared by each sampler tick, so
 * it never grows past one window's topic cardinality.
 * @type {Map<string, { m: number, b: number }>}
 */
export const topicPublishStats = new Map();

/**
 * The live pressure snapshot `platform.pressure` returns and `onPressure`
 * callbacks receive. Mutated IN PLACE by the sampler - deliberately a
 * singleton, never copied, so a held reference always reads the latest
 * sample. Consumers relying on the live reference are part of the contract.
 */
export const pressureSnapshot = {
	droppedFrames: 0,
	droppedBytes: 0,
	active: false,
	value: 0,
	subscriberRatio: 0,
	publishRate: 0,
	memoryMB: 0,
	reason: 'NONE',
	maxBufferedBytes: 0,
	backpressuredConnections: 0,
	psi: null,
	cpuThrottle: null,
	// Publish-egress figures for the last sample window: local deliveries and
	// wire bytes charged, and publishes refused by a configured
	// `websocket.egress` ceiling, per scope - the same fields the sibling
	// adapter's snapshot carries, so an app reading them is portable.
	egress: { deliveries: 0, bytes: 0, refusedTopic: 0, refusedTenant: 0 },
	topPublishers: []
};

/**
 * `onPressure` subscribers, fired (each contained) on reason transitions.
 * @type {Set<(snapshot: typeof pressureSnapshot) => void>}
 */
export const pressureListeners = new Set();

/**
 * `onPublishRate` subscribers. A non-empty set replaces the default throttled
 * runaway-publisher console warning.
 * @type {Set<(over: Array<{ topic: string, messagesPerSec: number, bytesPerSec: number }>) => void>}
 */
export const publishRateListeners = new Set();

/**
 * Last runaway-publisher warn time per topic, for the default (listener-less)
 * throttled warning. Bounded with FIFO eviction by the sampler.
 * @type {Map<string, number>}
 */
export const lastPublishWarnAt = new Map();

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
// Drawn through the runtime seam so a deterministic simulation controls it;
// the default env draws from node:crypto exactly as before.
function drawProcessEpoch() {
	const b = randomOctets(4);
	return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/** @type {number | undefined} */
let PROCESS_EPOCH;

/**
 * The connection's seq-space generation, latched on FIRST READ rather than at
 * module import - the spelling the sibling adapter uses, and for its reason: a
 * controlled simulation that has seeded the RNG can then latch a reproducible
 * value, where an import-time draw has already spent bytes from a stream the
 * simulation had no chance to seed.
 *
 * @returns {number}
 */
export function processEpoch() {
	if (PROCESS_EPOCH === undefined) PROCESS_EPOCH = drawProcessEpoch();
	return PROCESS_EPOCH;
}

/**
 * Per-topic epoch overrides, layered over the process generation.
 *
 * A topic's epoch normally IS the process generation: every in-memory seq
 * counter resets together, so one token describes them all. An override exists
 * for the case where ONE topic's recorded history can no longer be trusted
 * while the process lives on.
 *
 * The explicit-seq lane is what needs it. `maxAuthoritativeSeq` is monotone by
 * design - an explicit seq may arrive reordered, so the mark only ever moves up
 * - and no number carries the identity of the counter that issued it. One
 * publish stamped from a different authority (a `{ seq: Date.now() }` in a
 * one-off path, a second partition's offsets, an upstream counter restarted
 * after a deploy) therefore pins the mark at that value for the life of the
 * process, and every later resume window on that topic dedups against a floor
 * from the wrong sequence space. Nothing self-heals it, because healing it
 * would mean writing a counter value into the explicit space.
 *
 * Minting a fresh epoch for the topic is the answer, and it needs no protocol
 * change: the field already rides the `subscribed` ack. Every offset a client
 * recorded under the old authority dies at its next resume through the ordinary
 * epoch-mismatch answer, using machinery every client already implements. So an
 * app that CHANGES a topic's authority - moves it from the counter to an
 * external allocator, repoints it at another partition, resets the store behind
 * it - repudiates the old offsets deliberately instead of leaving them to dedup
 * against a poisoned floor forever.
 *
 * The map is bounded: authority changes are rare, but nothing should grow
 * without a ceiling. At the cap the longest-undisturbed override is dropped and
 * reads fall back to the process generation, which for a long-dead change is
 * the honest degradation - an offset old enough to outlive the cap has usually
 * cycled through a resume already.
 */
const TOPIC_EPOCH_OVERRIDE_MAX = 4096;

/** @type {Map<string, number>} */
const topicEpochs = new Map();

/**
 * The epoch for one topic: its override when something minted one, else the
 * process generation. The SINGLE read authority - the platform member and the
 * `subscribed` ack both route through it, so they cannot answer differently for
 * the same topic.
 *
 * @param {string} topic
 * @returns {number}
 */
export function topicEpochValue(topic) {
	const override = topicEpochs.get(topic);
	return override !== undefined ? override : processEpoch();
}

/**
 * Mint and install a fresh generation for ONE topic, returning it.
 *
 * The re-roll guard is load-bearing rather than tidy: a mint that equals the
 * value it replaces is a no-op for exactly the offsets the caller asked to
 * repudiate, and a deliberate bump has the current value in hand, so it can
 * simply not collide.
 *
 * Re-installing refreshes the entry's recency, so the cap always evicts the
 * longest-undisturbed override rather than the one most recently asked about.
 *
 * @param {string} topic
 * @returns {number} the installed epoch
 */
export function mintTopicEpoch(topic) {
	const current = topicEpochValue(topic);
	let minted = drawProcessEpoch();
	while (minted === current) minted = drawProcessEpoch();
	if (topicEpochs.delete(topic) === false && topicEpochs.size >= TOPIC_EPOCH_OVERRIDE_MAX) {
		const oldest = topicEpochs.keys().next().value;
		if (oldest !== undefined) topicEpochs.delete(oldest);
	}
	topicEpochs.set(topic, minted);
	return minted;
}

/** Clear every topic override. Simulation and harness use only. */
export function resetTopicEpochs() {
	topicEpochs.clear();
}

/**
 * Re-latch the seq-space generation (simulation/test harness only): the sim
 * pins a fixed virtual epoch per run, and a test may redraw so the value
 * stops depending on module-load randomness.
 */
export function resetProcessEpoch(next) {
	// A harness may LATCH a specific generation; argless, it CLEARS the latch so
	// the next read draws through the seam - from whatever stream the harness
	// has seeded by then, which is the whole point of latching lazily. A latched
	// value is squeezed into
	// the epoch's u32 domain (`>>> 0`, drawProcessEpoch's range), so an
	// epoch-ms input like 1700000000000 latches as its low 32 bits and the
	// `subscribed` ack carries a different value than a sibling that latches
	// the full ms. What latching preserves is the DRAW ORDER: no bytes leave
	// the seeded rng stream for this epoch, on either adapter.
	PROCESS_EPOCH = typeof next === 'number' ? (next >>> 0) : undefined;
}

/**
 * Bounded cache of built envelope prefixes, keyed `topic\0event`.
 * @type {Map<string, string>}
 */
export const envelopePrefixCache = new Map();

/**
 * DISTINCT topics with a subscribe in flight on this connection - what the
 * subscription cap and the in-flight bound count, not the attempt total. N
 * concurrent subscribes to one topic can only ever install one subscription -
 * the landing short-circuits on `subs.has(topic)` - so charging them N times
 * refuses subscribes the connection has every right to make. O(1): Map.size.
 *
 * @param {any} ud
 * @returns {number}
 */
export function pendingSubscribeTopics(ud) {
	return ud[WS_PENDING_SUBSCRIBES]?.size ?? 0;
}

/**
 * The connection's installed subscriptions, or an empty set when it is gone.
 *
 * @param {any} ws
 * @returns {Set<string>}
 */
export function heldSubscriptions(ws) {
	try {
		const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
		// A slot that is not a Set is corruption, reported where the slot is
		// read to change it (`subs.shape`, `subs.shape-unsubscribe`,
		// `subs.shape-batch`); answering with it here would only move the
		// failure into the caller's `has`.
		return subs instanceof Set ? subs : EMPTY_SUBSCRIPTIONS;
	} catch {
		return EMPTY_SUBSCRIPTIONS;
	}
}

const EMPTY_SUBSCRIPTIONS = new Set();

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
export const MAX_CONTROL_EGRESS_BYTES = 4 * 1024 * 1024;

/** Window over which the budget above is measured. */
export const CONTROL_EGRESS_WINDOW_MS = 10_000;

const WS_CONTROL_BUDGET = Symbol.for('adapter-uws.ws.control-budget');

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
			processMonotonicNow()
		);
		ud[WS_CONTROL_BUDGET] = budget;
	}
	return budget(bytes);
}


/**
 * Take an explicit (cluster-authoritative) seq for a publish, or throw when the
 * value cannot go on the wire.
 *
 * FAIL FAST RATHER THAN CORRUPT THE WIRE. The alternatives are both worse than
 * a throw. Publishing seq-less degrades the client's resume dedup with nothing
 * to notice it by, and substituting the counter is worse still: it belongs to a
 * different sequence space, so it would put a local value into the topic's
 * authoritative mark - the cross-space clobber the resume floor is built to
 * avoid. A bad seq is a bug in the calling app, not a runtime condition to
 * absorb, and it is deterministic - it will surface on the first publish rather
 * than under load.
 *
 * @param {number} seq
 * @param {string} topic
 * @returns {number}
 * @throws {TypeError} when the seq cannot be represented on both wires
 */
export function stampExplicitSeq(seq, topic) {
	return explicitSeqValue(seq, topic);
}

/**
 * Stamp the next sequence number for a topic, or null when this publish opted
 * out with `{ seq: false }`. An explicit numeric `seq` is a
 * cluster-authoritative value, taken as given once it is one the wire can
 * carry; absent options and `{ seq: true }` alike draw from the local counter.
 *
 * @param {{ seq?: unknown } | undefined} options
 * @param {string} topic
 * @returns {number | null}
 */
export function stampSeq(options, topic) {
	return stampSeqValue(options ? options.seq : undefined, topic);
}

/**
 * Value form of stampSeq, for callers that read `options.seq` themselves -
 * exactly once, before any app code could observe the call. The publish lanes
 * decide seq, authority, and the resume capture from that single read, so the
 * value stamped here is by construction the value recorded there, whatever a
 * payload's toJSON does to the caller's options in between.
 *
 * @param {unknown} seqOption - the one read of `options.seq`
 * @param {string} topic
 * @returns {number | null}
 */
export function stampSeqValue(seqOption, topic) {
	// ABSENT IS THE COUNTER, and only an explicit `false` opts out. A publish
	// with no options is the most common call shape there is, and
	// svelte-adapter-uws has always stamped the counter for it - so a
	// seq-less envelope here made the same app emit different bytes on the
	// two adapters, silently, on the call every app makes. `false` keeps
	// meaning "no seq": that is the spelling an app uses to say so.
	if (seqOption === false || seqOption === null) return null;
	if (typeof seqOption === 'number') {
		// Inlined from explicitSeqValue so the overwhelmingly common number
		// spelling keeps its single call frame on the hot path. SAFE integer,
		// because the wire carries a value faithfully only inside that range.
		if (Number.isSafeInteger(seqOption) && seqOption >= 1) return seqOption;
		// Cold: let the shared validator pick between the magnitude refusal and
		// the spelling one, so the two lanes cannot word it differently.
		return explicitSeqValue(seqOption, topic);
	}
	// The second spelling of the same authority, held to the same range, so a
	// caller reading an offset out of a store that hands back BigInt does not
	// convert at the call site - which is where the silent rounding happened.
	if (typeof seqOption === 'bigint') return explicitSeqValue(seqOption, topic);
	// Everything that is not one of the four legal spellings is a bug in the
	// calling app, and the counter is the worst possible place to put it: a
	// `{ seq: '742' }` read off a JSON column or a Redis reply was MEANT as the
	// cluster seq, and drawing the counter for it publishes a value from a
	// different sequence space, leaves the topic unmarked, and degrades resume
	// dedup to nothing with no signal at all. The same misuse already throws
	// when the number is one the wire cannot carry.
	if (seqOption !== undefined && seqOption !== true) throwInvalidSeq(seqOption, topic);
	const current = topicSeqs.get(topic);
	if (current !== undefined) {
		// The stamp of an existing topic is the hottest primitive in the
		// adapter now that the counter is the DEFAULT rather than an opt-in:
		// every publish reaches it. It is one Map.set, which is flat in map
		// size, plus a recency mark that is only taken while something can
		// actually be evicted. See noteRecentlyUsed for what that mark
		// replaced and what it costs.
		if (topicSeqs.size >= MAX_SEQ_TOPICS) noteRecentlyUsed(topicSeqsRecent, topic);
		const next = current + 1;
		topicSeqs.set(topic, next);
		return next;
	}
	// A topic seen for the first time is the only thing that can push the map
	// over its bound, so it is the only path that pays for an eviction.
	if (topicSeqs.size >= MAX_SEQ_TOPICS) {
		evictOne(topicSeqs, topicSeqsRecent);
		if (!seqEvictionWarned) {
			seqEvictionWarned = true;
			console.warn(
				`[ws] more than ${MAX_SEQ_TOPICS} topics carry a counter seq; counters are being ` +
				'evicted to hold that cap. A topic that has gone quiet goes first, but where the oldest ' +
				'counters are all still being published to, one of THOSE is evicted. An evicted topic ' +
				'restarts its sequence at 1, so a client holding an older seq for it sees the number go ' +
				'backwards. The counter is the DEFAULT: publish with { seq: false } on high-cardinality ' +
				'topics, or scope them so the working set stays under the cap.'
			);
		}
	}
	topicSeqs.set(topic, 1);
	return 1;
}

let seqEvictionWarned = false;

/**
 * Every Symbol this adapter keeps on a connection's userData.
 *
 * The object an upgrade hook returns is copied into the connection's userData
 * key by key, enumerable Symbol keys included - but never these. A hook that
 * returns, or spreads, the userData of another connection
 * (`{ ...other.getUserData(), tab }` copies own Symbols too) would otherwise
 * hand the new connection that one's wire-id table, cohort set, capabilities,
 * budgets and permit, and nothing would say so: frames under ids the client
 * never learned, cohort references released twice, a permit given back that
 * was never taken. `open` and the upgrade build these themselves.
 */
const CONNECTION_SLOTS = new Set([
	WS_ATTRIBUTION,
	WS_SUBSCRIPTIONS,
	WS_PENDING_SUBSCRIBES,
	WS_PENDING_SUBSCRIBES_TOTAL,
	WS_PLATFORM,
	WS_PUBLISH_GRANT,
	WS_SESSION_ID,
	WS_STATS,
	WS_COALESCED,
	WS_CAPS,
	WS_INGRESS_BINDINGS,
	WS_LEASE,
	WS_TOPIC_IDS,
	WS_WIRE_STATE,
	WS_SHARED_COHORTS,
	CARRY_REQUEST_ID,
	WS_CONNECTION_PERMIT,
	WS_CONTROL_BUDGET
]);

/**
 * @param {symbol} key
 * @returns {boolean} whether `key` is one of the adapter's own userData slots
 */
export function isConnectionSlot(key) {
	return CONNECTION_SLOTS.has(key);
}


/** Declare transport-owned slots without invoking inherited application setters. */
export function declareRuntimeConnectionSlots(userData) {
	for (const key of CONNECTION_SLOTS) {
		if (key === CARRY_REQUEST_ID) continue;
		if (!Object.hasOwn(userData, key)) Object.defineProperty(userData, key, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
}
