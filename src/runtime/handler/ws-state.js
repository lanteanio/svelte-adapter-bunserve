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
import { createHookQueue } from '../utils/hook-queue.js';
import { isValidPublishSeq } from '../utils/publish-seq.js';
import { createCapCounts } from '../utils/wire.js';
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
 * The capability tokens this connection declared in its `hello` frame. Absent
 * on connections that never sent one - old clients - which is the safe-default
 * "no opt-in features" signal every capability consumer keys on.
 */
export const WS_CAPS = Symbol('caps');

/**
 * The connection's send-gate window, present only after a `hello` carrying the
 * `lease` capability armed flow control (first hello only - a re-sent hello
 * never resets the window). Shape: `{ gate, saturation }` where `gate` is a
 * createLeaseState machine and `saturation` its last observed 0..1 reading -
 * which today always reads 0, because the observation happens after the
 * re-grant (see the request-n lane in handler/ws.js).
 */
export const WS_LEASE = Symbol('lease');

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
export const WS_TOPIC_IDS = Symbol('topicIds');

/**
 * Per-connection stateful wire-codec entries, keyed by capability:
 * `{ state, detach }`, or the poisoned sentinel `{ state: null, poisoned }`.
 * See handler/wire-state.js for the lifecycle.
 */
export const WS_WIRE_STATE = Symbol('wireState');

/**
 * Topics whose SHARED binary cohort this connection joined, so close releases
 * exactly the shared wire-id refs it acquired and no others.
 */
export const WS_SHARED_COHORTS = Symbol('sharedCohorts');

/**
 * Topics running shared binary fan-out, topic -> the capability whose codec
 * marked them shared. The first shared publish to a topic migrates its
 * current subscribers into cohorts and records it here, so every later
 * subscriber is cohorted at subscribe time instead.
 * @type {Map<string, string>}
 */
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
 * - `siege` belongs to `protection`, a recorded parity gap. Each label arrives
 *   with the feature, which is how `auth_timeout`, `ip_rate_limit` and
 *   `auth_rate_limit` got here.
 * - `duplicate_header` is unreachable on this transport rather than unported:
 *   repeated request headers are merged before the adapter is entered, so there
 *   is no ambiguity here to refuse.
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
	/**
	 * Sends and subscribes that were refused because the socket had already
	 * closed. This is the lane a closed-socket operation lands in; it must
	 * never be confused with a backpressure drop, which is a different signal
	 * entirely (see utils/send-result.js).
	 */
	closedWsAborts: 0,

	/**
	 * Releases whose teardown could not be recorded for the close hook because
	 * the connection's pending-release record was full. Non-zero means an
	 * `unsubscribe` hook has been failing persistently, and those releases lost
	 * the close-hook fallback: nothing covers them if their own hook does not
	 * perform the teardown. Exposed as `platform.droppedReleaseRecords`.
	 */
	droppedReleaseRecords: 0,

	/**
	 * Topic publishes since boot. Monotonic and never reset, so the name says
	 * exactly that rather than implying a sampling window. Exposed as
	 * `platform.publishCount`.
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

	/** heapUsed/heapTotal at the previous sampler tick. */
	lastHeapUsedRatio: 0,

	/** process RSS bytes at the previous sampler tick. */
	lastResidentBytes: 0,

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
	 * Worst per-connection send-gate saturation observed since the last
	 * sample; written on `request-n`, folded into the snapshot value by the
	 * sampler, then decayed by half each tick. The write site reads a freshly
	 * re-granted window (the sibling's order, kept for parity), which is 0
	 * for a server that never consumes permits - so the fold is armed but
	 * cannot lift the value today. See the request-n lane in handler/ws.js.
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

let PROCESS_EPOCH = drawProcessEpoch();

/** @returns {number} */
export function processEpoch() {
	return PROCESS_EPOCH;
}

/**
 * Re-latch the seq-space generation (simulation/test harness only): the sim
 * pins a fixed virtual epoch per run, and a test may redraw so the value
 * stops depending on module-load randomness.
 */
export function resetProcessEpoch(next) {
	// A harness may LATCH a specific generation; argless, it redraws through
	// the seam exactly as module load did. A latched value is squeezed into
	// the epoch's u32 domain (`>>> 0`, drawProcessEpoch's range), so an
	// epoch-ms input like 1700000000000 latches as its low 32 bits and the
	// `subscribed` ack carries a different value than a sibling that latches
	// the full ms. What latching preserves is the DRAW ORDER: no bytes leave
	// the seeded rng stream for this epoch, on either adapter.
	PROCESS_EPOCH = typeof next === 'number' ? (next >>> 0) : drawProcessEpoch();
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
 * A THIRD limit, and deliberately not the gate counter. Sharing `WS_GATES`
 * breaks both lanes at once. Bun does not await the message handler, so a
 * client holding the permitted 10,000 subscriptions can pipeline 10,000
 * `unsubscribe` frames in one read burst and land that many CONCURRENT app
 * hooks unless the unsubscribe lane has its own CHECKED bound on every path,
 * held and speculative alike. And every increment a shared counter takes from
 * legitimate releases drives the SUBSCRIBE path toward `RATE_LIMITED` on a
 * connection nowhere near any real limit - a SvelteKit route change unmounts
 * the old page's stores in one tick, which is exactly such a burst.
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
 * Twice what the queue can hold in flight, so ordinary concurrency never
 * approaches it: at most `concurrency + backlog` releases exist at once, and
 * every one of them is recorded.
 *
 * The slack exists for entries an app hook that keeps FAILING leaves behind.
 * Those free their queue slot but stay owed, so they accumulate ON TOP of
 * whatever is in flight, and without a ceiling a connection that releases and
 * re-subscribes in a loop against a broken hook would grow this without limit.
 *
 * That means the ceiling IS reachable, and reaching it costs teardown coverage
 * for the releases past it - there is no way around that, since every entry at
 * that point is a topic genuinely owed something. Getting there takes roughly
 * two thousand DISTINCT topics on one connection whose hook never resolved -
 * the record is keyed by topic, so releasing the SAME topic over and over
 * against a broken hook does not grow it at all. It is counted in
 * `droppedReleaseRecords`, and it says so once.
 */
const MAX_PENDING_RELEASE_TOPICS =
	2 * (MAX_CONCURRENT_UNSUBSCRIBE_HOOKS + MAX_QUEUED_UNSUBSCRIBE_HOOKS);

let warnedPendingReleaseFull = false;
/**
 * Warned once, COUNTED every time. The warning describes a static fault - an
 * `unsubscribe` hook that keeps failing - so repeating it per release adds
 * nothing, but a connection that hits this an hour after the first one still
 * has to be visible to an operator, which is what the counter is for.
 */
function warnPendingReleaseFull() {
	wsCounters.droppedReleaseRecords++;
	if (warnedPendingReleaseFull) return;
	warnedPendingReleaseFull = true;
	console.error(
		`[ws] a connection is carrying ${MAX_PENDING_RELEASE_TOPICS} distinct topics whose unsubscribe hook has not\n` +
		'  succeeded yet, so further releases are no longer recorded for the close hook and their teardown\n' +
		'  is not guaranteed. The usual cause is an `unsubscribe` hook that throws or rejects on every\n' +
		'  call - fix that, and check the errors logged above it. The running total is\n' +
		'  platform.droppedReleaseRecords.'
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
			processMonotonicNow()
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
	if (isValidPublishSeq(seq)) return seq;
	throw new TypeError(
		`publish seq must be an integer >= 1, received ${String(seq)} (topic "${topic}"). ` +
		'There is no upper bound - the frame varint carries any magnitude exactly - but 0 is ' +
		'the binary frame\'s "no seq" sentinel so a stamped 0 vanishes for binary subscribers, ' +
		'a negative seq parses back off the wire as a different number, and a fractional one is ' +
		'truncated on the frame but not in the JSON envelope. The counter lane and every shipped ' +
		'authority are 1-based; offset a 0-based source by 1.'
	);
}

/**
 * Stamp the next sequence number for a topic, or null when this publish opted
 * out with `{ seq: false }`. An explicit numeric `seq` is a
 * cluster-authoritative value, taken as given once it is one the wire can
 * carry; absent options and `{ seq: true }` alike draw from the local counter.
 *
 * @param {{ seq?: boolean | number } | undefined} options
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
 * @param {boolean | number | undefined} seqOption - the one read of `options.seq`
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
	if (seqOption === false) return null;
	if (typeof seqOption === 'number') return stampExplicitSeq(seqOption, topic);
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
