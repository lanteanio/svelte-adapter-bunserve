// The publish-egress accounting primitives: the windowed usage ledger, its
// ceilings, and the tenant resolution. A leaf module on purpose - importing
// only the runtime clock seam - so the unit suite and the simulator load it
// without dragging the handler graph in, and enforcement cannot drift between
// the production wiring (handler/publish-egress.js) and anything else that
// runs the account.
//
// The module mirrors svelte-adapter-uws's egress-account at the parity pin:
// the charge law, the ceiling semantics and the ledger mechanics are the
// family contract (docs/tenancy.md in that repo carries the cross-repo
// version), so an `egress` section carried from one adapter to the other
// bounds the same quantities the same way. Where this file differs it is
// because the TRANSPORT differs - Bun's plain fan-out is one native
// `server.publish()` call, so recipient counts come from the runtime's
// subscriber registry rather than a tracked membership walk - never because
// the contract does.
//
// The charge law, stated once:
//   - One charge per logical publish. `publishWireBatch` is N logical
//     publishes sharing ONE admission decision - a batch is admitted whole or
//     refused whole.
//   - deliveries = local recipients at the instant of the publish, minus an
//     excluded socket that actually holds the subscription, times messages.
//   - bytes = the serialized form the lane sends, per recipient: UTF-8 bytes
//     of the JSON envelope, or the encoded binary frame where the lane
//     produces one for capability-advertising subscribers. Pre-compression;
//     permessage-deflate is a transport concern the budget does not see.
//
// Enforcement semantics, stated once:
//   - Ceilings are per rotation window (windowMs, default 1000 ms, lazily
//     rotated - no timer).
//   - The messages and deliveries ceilings refuse the publish that WOULD
//     cross them (both quantities are known before the decision).
//   - The bytes ceiling refuses once the window's charged bytes have REACHED
//     it: a publish's byte weight exists only after serialization, which must
//     not happen before admission (a stamped-then-refused publish would leave
//     a client-visible sequence gap), so the crossing publish is delivered
//     and the next is refused. Overshoot is bounded by one publish's bytes.
//   - The decision is made before the first frame of a logical publish; there
//     is no mid-walk shedding.

import { monotonicNow } from '../runtime.js';

export const EGRESS_DEFAULT_WINDOW_MS = 1000;

/**
 * Marks an options object whose call already took the egress decision for a
 * whole batch, so the per-entry lane charges without re-deciding (see
 * `publishWireBatch`'s stateless reroute).
 *
 * A Symbol, not a string key: a string would be settable by any caller that
 * hands a publish an options object, which would turn an internal batch
 * detail into a way to bypass every ceiling. Only code that imports this
 * module can name it, and it survives no JSON round trip - so it can never
 * arrive from a client either.
 */
export const EGRESS_ADMITTED = Symbol('adapter-bunserve.egress-admitted');

/**
 * The shared attribution id rule, stated in svelte-adapter-uws's
 * utils/attribution.js and applied here to the tenant resolver's answers:
 * `[a-zA-Z0-9_-]`, 1..64 chars. The charset excludes the NUL byte, so a
 * downstream `id + '\0' + key` bucket key stays unambiguous, and it excludes
 * `/`, so a tenant-namespaced topic prefix can never be spoofed from inside
 * an id.
 */
const VALID_ATTRIBUTION_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Default bound on the per-scope usage maps and the tenant-resolution memo.
 * A POWER OF TWO deliberately, and for MEMORY: V8 sizes a Map's backing table
 * to a power of two and, under the steady delete-plus-insert churn a ledger
 * at its bound performs, settles it above roughly twice the live count - so a
 * configured `maxKeys` is rounded UP to the next power of two, which holds no
 * fewer keys in the memory the requested value would have taken. The numbers
 * behind both statements were measured in the sibling adapter, whose ledger
 * this one mirrors entry for entry.
 */
const EGRESS_DEFAULT_MAX_KEYS = 4096;

/**
 * The values `maxKeys` may take, duplicated verbatim in the build-time guard
 * (ws-options.js) so every intake surface refuses what this module would
 * silently replace with the default. The ceiling is V8's own: a Map refuses
 * its 16,777,217th entry, so a larger bound would crash the publish path on
 * an insert before eviction ever engaged. There is deliberately no
 * `0 disables`: an unbounded ledger turns topic cardinality into that same
 * crash, behind unbounded memory first.
 */
const EGRESS_MAX_KEYS_FLOOR = 1024;
const EGRESS_MAX_KEYS_CEILING = 2 ** 24;

const EGRESS_DEFAULT_EVICT_SAMPLE = 8;

/**
 * Expired-window reclamation steps a new key pays at most, per insert past
 * the sweep floor. Draining faster than keys arrive is what keeps the map's
 * size a measure of the keys LIVE at once rather than of every key the
 * worker has seen.
 */
const EGRESS_SWEEP_STEPS = 32;

/**
 * How far below `maxKeys` reclamation starts, as a right-shift of the bound
 * (a sixteenth). Slack rather than a hard edge, so the amortised sweep has
 * begun before the only remaining answer is eviction.
 */
const EGRESS_SLACK_SHIFT = 4;

/**
 * One scope's bounded window ledger. Windows rotate lazily in place (no
 * timer, no re-seat), lapsed windows are reclaimed a bounded number of steps
 * per new key, and at the cap the victim is the least-spent key among a
 * bounded sample walked by a cursor that survives between calls.
 *
 * The cursor and the proven-clean horizon (`sweepUntil`) are the sibling
 * ledger's measured decisions carried whole: a fresh iterator per eviction
 * re-walks V8's tombstone run and was measured there at -58% against the
 * surviving cursor, and a full pass records the earliest expiry it saw
 * because that instant - not an insert count - is exactly how long "nothing
 * to reclaim" stays true.
 *
 * @param {{ messages: number, bytes: number, deliveries: number }} ceilings
 * @param {(costEnforcement: boolean) => void} onEvict
 * @param {number} maxKeys
 * @param {number} evictionSample
 */
function createWindowLedger(ceilings, onEvict, maxKeys, evictionSample) {
	const sweepFloor = maxKeys - (maxKeys >>> EGRESS_SLACK_SHIFT);

	/**
	 * How much of its allowance this window has spent, as the largest
	 * fraction across the ARMED dimensions - the enforcement an eviction
	 * would throw away. A ranking input, not a predicate: `over()` decides
	 * refusals, from the counters themselves.
	 *
	 * @param {{ m: number, b: number, d: number }} w
	 * @returns {number}
	 */
	function spent(w) {
		let u = 0;
		if (ceilings.messages > 0) { const r = w.m / ceilings.messages; if (r > u) u = r; }
		if (ceilings.deliveries > 0) { const r = w.d / ceilings.deliveries; if (r > u) u = r; }
		if (ceilings.bytes > 0) { const r = w.b / ceilings.bytes; if (r > u) u = r; }
		return u;
	}

	/** @type {Map<string, { at: number, pu: number, m: number, b: number, d: number }>} */
	const map = new Map();

	/** @type {Iterator<[string, { at: number, pu: number, m: number, b: number, d: number }]> | null} */
	let evictCursor = null;

	/**
	 * The time until which the ledger is PROVEN to hold no lapsed window,
	 * from the last full pass that reclaimed nothing. Inside the horizon the
	 * walk is skipped because it cannot find anything; outside it the walk
	 * runs because it can. A pass records the smallest expiry it saw - an
	 * entry live at the visit lapses at `at + windowMs`, and that instant is
	 * exactly how long the finding survives.
	 */
	let sweepUntil = 0;

	/** The earliest expiry the pass in progress has seen among survivors. */
	let passEarliestExpiry = Infinity;

	function openPass() {
		evictCursor = map.entries();
		passEarliestExpiry = Infinity;
	}

	function closePass() {
		evictCursor = null;
		// Infinity means the pass saw no surviving entry at all - an empty
		// ledger, not a proven-clean one.
		if (passEarliestExpiry === Infinity) return;
		sweepUntil = passEarliestExpiry;
	}

	/**
	 * Drop expired windows the cursor passes, a bounded number of steps per
	 * new key. The budget stays FIXED, including on the insert about to cost
	 * a live key its ceiling: the sibling measured the whole-pass variant at
	 * +152..213% per publish near the bound, because the horizon is a MINIMUM
	 * over resident expiries and a clock that advances per publish expires it
	 * almost immediately.
	 *
	 * @param {number} nowMs
	 * @param {number} windowMs
	 */
	function reclaimExpired(nowMs, windowMs) {
		if (nowMs < sweepUntil) return;
		const budget = EGRESS_SWEEP_STEPS;
		let steps = 0;
		let wrapped = 0;
		while (steps < budget && wrapped < 2) {
			if (evictCursor === null) {
				openPass();
				wrapped++;
			}
			const step = evictCursor.next();
			if (step.done) {
				closePass();
				continue;
			}
			steps++;
			const [key, w] = step.value;
			if (nowMs - w.at >= windowMs) {
				map.delete(key);
			} else {
				const expiry = w.at + windowMs;
				if (expiry < passEarliestExpiry) passEarliestExpiry = expiry;
			}
		}
	}

	/**
	 * Reclaim one slot, preferring an EXPIRED window (free to drop - its next
	 * read would have reset it anyway) and otherwise the LEAST ACTIVE key in
	 * the sample, scored by spent allowance across the current window and the
	 * one before it. Spent allowance and not publish count, because under a
	 * `deliveries` or `bytes` ceiling the count reads a one-recipient publish
	 * and a ten-thousand-recipient publish as equal. Window START is
	 * emphatically NOT the score: among live keys the oldest `at` belongs to
	 * the key publishing continuously - the runaway a ceiling exists to
	 * bound.
	 *
	 * @param {number} nowMs
	 * @param {number} windowMs
	 */
	function evictOne(nowMs, windowMs) {
		/** @type {string | null} */
		let victim = null;
		let victimScore = Infinity;
		let sampled = 0;
		let wrapped = 0;
		while (sampled < evictionSample && wrapped < 2) {
			if (evictCursor === null) {
				openPass();
				wrapped++;
			}
			const step = evictCursor.next();
			if (step.done) {
				closePass();
				continue;
			}
			sampled++;
			const [key, w] = step.value;
			if (nowMs - w.at >= windowMs) {
				map.delete(key);
				onEvict(false);
				return;
			}
			const expiry = w.at + windowMs;
			if (expiry < passEarliestExpiry) passEarliestExpiry = expiry;
			const score = spent(w) + w.pu;
			if (score < victimScore) { victimScore = score; victim = key; }
		}
		if (victim !== null) {
			map.delete(victim);
			onEvict(true);
		}
	}

	return {
		map,

		/**
		 * Lazily-rotated usage window for one scope key. `at` is the window's
		 * start; a read past `at + windowMs` resets the counters in place, so
		 * the steady state allocates nothing per publish and the key does not
		 * move.
		 *
		 * @param {string} key
		 * @param {number} nowMs
		 * @param {number} windowMs
		 */
		windowFor(key, nowMs, windowMs) {
			let w = map.get(key);
			if (w === undefined) {
				if (map.size >= sweepFloor) {
					// Reclaim first: a lapsed window is free to drop, so the
					// room it frees costs nobody their ceiling. Evict ONLY
					// when the ledger is full and reclamation could not free a
					// slot.
					reclaimExpired(nowMs, windowMs);
					if (map.size >= maxKeys) evictOne(nowMs, windowMs);
				}
				w = { at: nowMs, pu: 0, m: 0, b: 0, d: 0 };
				map.set(key, w);
				return w;
			}
			if (nowMs - w.at >= windowMs) {
				// `pu` carries the window just closed, so eviction can tell a
				// key that has gone quiet from one that has merely rotated. A
				// gap of more than one window means the previous window is not
				// adjacent and what it spent is not evidence of activity.
				w.pu = nowMs - w.at < windowMs * 2 ? spent(w) : 0;
				w.at = nowMs;
				w.m = 0;
				w.b = 0;
				w.d = 0;
			}
			return w;
		}
	};
}

/**
 * Normalize a raw `egress` option section into the frozen config the account
 * runs on. Assumes the build-time guard in ws-options.js already refused
 * misshaped values on every intake surface; anything unusable that still
 * arrives here reads as disabled rather than inverted.
 *
 * @param {any} input - the raw `websocket.egress` section (or undefined)
 * @returns {{ windowMs: number, maxKeys: number, evictionSample: number, topic: { messages: number, bytes: number, deliveries: number }, tenant: { messages: number, bytes: number, deliveries: number }, topicEnabled: boolean, tenantEnabled: boolean, bytesEnabled: boolean }}
 */
export function normalizeEgressOptions(input) {
	const src = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
	const windowMs = src && typeof src.windowMs === 'number' && Number.isFinite(src.windowMs) && src.windowMs >= 100
		? src.windowMs
		: EGRESS_DEFAULT_WINDOW_MS;
	// The EFFECTIVE bound, after the power-of-two rounding the memory law
	// requires. A bit-doubling loop rather than Math.log2, because the
	// rounding must be exact at every bound the guard admits.
	let maxKeys = EGRESS_DEFAULT_MAX_KEYS;
	if (src && Number.isSafeInteger(src.maxKeys) &&
		src.maxKeys >= EGRESS_MAX_KEYS_FLOOR && src.maxKeys <= EGRESS_MAX_KEYS_CEILING) {
		maxKeys = EGRESS_MAX_KEYS_FLOOR;
		while (maxKeys < src.maxKeys) maxKeys *= 2;
	}
	const evictionSample = src && Number.isSafeInteger(src.evictionSample) && src.evictionSample >= 1
		? src.evictionSample
		: EGRESS_DEFAULT_EVICT_SAMPLE;
	const scope = (section) => {
		const s = section && typeof section === 'object' && !Array.isArray(section) ? section : null;
		const ceiling = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
		return Object.freeze({
			messages: ceiling(s ? s.messages : 0),
			bytes: ceiling(s ? s.bytes : 0),
			deliveries: ceiling(s ? s.deliveries : 0)
		});
	};
	const topic = scope(src ? src.topic : null);
	const tenant = scope(src ? src.tenant : null);
	return Object.freeze({
		windowMs,
		maxKeys,
		evictionSample,
		topic,
		tenant,
		topicEnabled: topic.messages > 0 || topic.bytes > 0 || topic.deliveries > 0,
		tenantEnabled: tenant.messages > 0 || tenant.bytes > 0 || tenant.deliveries > 0,
		// Only a BYTES ceiling decides on an encoded length, so only a bytes
		// ceiling is worth walking the envelope for: a messages-only or
		// deliveries-only budget would otherwise pay an O(envelope) measure
		// per publish for a number nothing reads.
		bytesEnabled: topic.bytes > 0 || tenant.bytes > 0
	});
}

/**
 * The number of bytes a `0x03` binary frame puts on the wire for one
 * recipient: tag + schemaVersion + a one-byte topic-id varint + the seq
 * varint + the codec payload. Topic ids above 127 widen their varint by a
 * byte per frame that this charge does not see - a documented approximation,
 * bounded to single bytes, taken so the charge never needs the
 * per-connection id resolution the walk performs.
 *
 * @param {number} payloadLength
 * @param {number} seq - the on-wire seq (0 when unstamped)
 * @returns {number}
 */
export function binaryFrameChargeBytes(payloadLength, seq) {
	let seqLen = 1;
	let v = seq;
	while (v > 0x7f) {
		v = Math.floor(v / 128);
		seqLen++;
	}
	return 3 + seqLen + payloadLength;
}

/**
 * The wire bytes one JSON envelope puts on the wire for `recipients`
 * recipients.
 *
 * `exact` decides the unit, and it is a cost decision: `Buffer.byteLength`
 * walks the string, O(envelope), on the hottest primitive in the adapter. A
 * configured BYTES ceiling makes that walk load-bearing (a budget decision
 * must not under-count a multi-byte payload), so an operator who arms one
 * opts into it; every other configuration takes the UTF-16 length - the unit
 * `topicPublishStats` has always used, identical for ASCII envelopes, and
 * free.
 *
 * @param {string} envelope
 * @param {number} recipients
 * @param {boolean} [exact] - true once a BYTES ceiling is armed
 * @returns {number}
 */
export function envelopeWireBytes(envelope, recipients, exact) {
	if (recipients <= 0) return 0;
	return (exact ? Buffer.byteLength(envelope) : envelope.length) * recipients;
}

/**
 * Build one egress account: the windowed usage ledger plus its ceilings and
 * tenant resolution. Pure with respect to process state: the clock and every
 * refusal side effect are injected, so a unit test drives windows with its
 * own clock and the wiring reports refusals in the runtime's vocabulary.
 *
 * @param {{
 *   options: ReturnType<typeof normalizeEgressOptions>,
 *   tenantOf?: ((topic: string) => string | null | undefined) | null,
 *   clock?: () => number,
 *   onRefused?: (scope: 'topic' | 'tenant', topic: string | null, dimension: 'messages' | 'bytes' | 'deliveries', limit: number) => void,
 *   onResolverInvalid?: (raw: unknown) => void,
 *   onEvicted?: (scope: 'topic' | 'tenant') => void,
 *   memoize?: boolean
 * }} io
 */
export function createEgressAccount(io) {
	const config = io.options;
	const clock = io.clock || monotonicNow;
	const tenantOf = typeof io.tenantOf === 'function' ? io.tenantOf : null;
	const onRefused = io.onRefused || null;
	const onResolverInvalid = io.onResolverInvalid || null;
	const enabled = config.topicEnabled || config.tenantEnabled;
	// Only an eviction that dropped a LIVE window is reported: reclaiming an
	// expired one costs nothing an operator could act on.
	const onEvicted = io.onEvicted || null;
	const topicWindows = createWindowLedger(config.topic, (cost) => {
		if (cost && onEvicted !== null) {
			try { onEvicted('topic'); } catch { /* reporting never breaks a publish */ }
		}
	}, config.maxKeys, config.evictionSample);
	const tenantWindows = createWindowLedger(config.tenant, (cost) => {
		if (cost && onEvicted !== null) {
			try { onEvicted('tenant'); } catch { /* reporting never breaks a publish */ }
		}
	}, config.maxKeys, config.evictionSample);
	// Topic-to-tenant memo. The resolver is documented pure over the topic
	// string, so its answers are cacheable; wholesale clear at the cap keeps
	// it bounded without an eviction policy a pure function cannot need.
	const memoize = io.memoize !== false;
	/** @type {Map<string, string | null> | null} */
	const memo = memoize && tenantOf !== null ? new Map() : null;
	// The resolver-invalid diagnostic fires once per account: the condition
	// is a coding defect that repeats on every publish, and refusing to
	// attribute is already the fail-closed behavior.
	let resolverReported = false;

	const over = (usage, ceilings, messages, deliveries) => {
		if (ceilings.messages > 0 && usage.m + messages > ceilings.messages) return 'messages';
		if (ceilings.deliveries > 0 && usage.d + deliveries > ceilings.deliveries) return 'deliveries';
		if (ceilings.bytes > 0 && usage.b >= ceilings.bytes) return 'bytes';
		return null;
	};

	return {
		enabled,
		tenantEnabled: config.tenantEnabled,
		/** True only while a BYTES ceiling needs an encoded length. */
		bytesEnabled: config.bytesEnabled,
		config,

		/**
		 * Resolve the tenant a topic's egress is charged to, through the
		 * handler module's `egressTenantOf` export. Null for an unattributed
		 * topic. An invalid result (wrong type, or an id outside the shared
		 * attribution rule) refuses to attribute: the charge lands
		 * unattributed - never on a mangled key - and the defect is reported
		 * once.
		 *
		 * @param {string} topic
		 * @returns {string | null}
		 */
		resolveTenant(topic) {
			if (tenantOf === null) return null;
			if (memo !== null) {
				const hit = memo.get(topic);
				if (hit !== undefined) return hit;
			}
			let raw;
			let threw = false;
			try {
				raw = tenantOf(topic);
			} catch {
				threw = true;
			}
			let id = null;
			if (!threw && raw !== null && raw !== undefined) {
				if (typeof raw === 'string' && VALID_ATTRIBUTION_ID.test(raw)) {
					id = raw;
				} else if (!resolverReported) {
					resolverReported = true;
					try { onResolverInvalid?.(raw); } catch { /* diagnostics never break a publish */ }
				}
			}
			if (threw && !resolverReported) {
				resolverReported = true;
				try { onResolverInvalid?.(undefined); } catch { /* diagnostics never break a publish */ }
			}
			if (memo !== null) {
				if (memo.size >= config.maxKeys) memo.clear();
				memo.set(topic, id);
			}
			return id;
		},

		/**
		 * The pre-hoc decision for one logical publish (or one whole batch).
		 * True admits; false means the caller must deliver nothing and return
		 * its refusal shape. Reads usage only - the charge is a separate step
		 * so a refusal leaves every window untouched.
		 *
		 * @param {string | null} topic - null for a topic-less fan-out
		 * @param {string | null} tenantId
		 * @param {number} messages
		 * @param {number} deliveries
		 * @returns {boolean}
		 */
		admit(topic, tenantId, messages, deliveries) {
			if (!enabled) return true;
			return this.admitTopic(topic, messages, deliveries) &&
				this.admitTenant(tenantId, topic, messages, deliveries);
		},

		/**
		 * The topic half of the decision on its own.
		 *
		 * @param {string | null} topic
		 * @param {number} messages
		 * @param {number} deliveries
		 * @returns {boolean}
		 */
		admitTopic(topic, messages, deliveries) {
			if (!enabled || !config.topicEnabled || topic === null) return true;
			const w = topicWindows.windowFor(topic, clock(), config.windowMs);
			const dim = over(w, config.topic, messages, deliveries);
			if (dim === null) return true;
			try { onRefused?.('topic', topic, dim, config.topic[dim]); } catch { /* reporting never breaks a refusal */ }
			return false;
		},

		/**
		 * The tenant half of the decision. `topic` names a topic for the
		 * refusal report only - the ceiling is the tenant's, whatever mix of
		 * topics the publish spans.
		 *
		 * @param {string | null} tenantId
		 * @param {string | null} topic
		 * @param {number} messages
		 * @param {number} deliveries
		 * @returns {boolean}
		 */
		admitTenant(tenantId, topic, messages, deliveries) {
			if (!enabled || !config.tenantEnabled || tenantId === null || tenantId === undefined) return true;
			const w = tenantWindows.windowFor(tenantId, clock(), config.windowMs);
			const dim = over(w, config.tenant, messages, deliveries);
			if (dim === null) return true;
			try { onRefused?.('tenant', topic, dim, config.tenant[dim]); } catch { /* reporting never breaks a refusal */ }
			return false;
		},

		/**
		 * Add one admitted logical publish's weight to the windows.
		 *
		 * @param {string | null} topic
		 * @param {string | null} tenantId
		 * @param {number} messages
		 * @param {number} deliveries
		 * @param {number} bytes - total wire bytes (per-recipient size summed)
		 */
		charge(topic, tenantId, messages, deliveries, bytes) {
			if (!enabled) return;
			const at = clock();
			if (config.topicEnabled && topic !== null) {
				const w = topicWindows.windowFor(topic, at, config.windowMs);
				w.m += messages;
				w.d += deliveries;
				w.b += bytes;
			}
			if (config.tenantEnabled && tenantId !== null && tenantId !== undefined) {
				const w = tenantWindows.windowFor(tenantId, at, config.windowMs);
				w.m += messages;
				w.d += deliveries;
				w.b += bytes;
			}
		}
	};
}
