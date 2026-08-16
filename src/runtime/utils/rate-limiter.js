// Per-client sliding-window rate limiter for the doors that meter by client
// address. Today that is the WebSocket upgrade; the auth preflight endpoint
// joins it when that endpoint does.
//
// This mirrors svelte-adapter-uws's module of the same name, deliberately and
// closely, for the reason `upgrade-admission.js` gives: the two adapters are
// drop-in replacements for each other, so the same `upgradeRateLimit` has to
// refuse the same clients at the same rate on both. A limiter is also the wrong
// place to be inventive - several of the decisions below are individually
// load-bearing and none of them are obvious (evict rather than refuse at the
// entry cap, sample from a cursor held ACROSS calls rather than a fresh
// iterator, bound the key length and not only the entry count), and a copy
// written from the shape rather than from the reasons would reproduce the
// shape and miss one.
//
// Pure: no clock, no timers, no globals. `nowMs` is passed in, which is what
// keeps it outside the determinism seam and directly testable.

/**
 * Expand an IPv6 literal to its eight normalized hex groups, or null when it is
 * not one. Null means "do not fold" everywhere below, so anything this cannot
 * read keeps its full value and shares a bucket with nothing.
 *
 * @param {string} host lowercased, bracket- and zone-free
 * @returns {string[] | null}
 */
function expandIpv6(host) {
	let head = host;
	/** @type {string[] | null} */
	let tail = null;

	// An embedded IPv4 tail (::ffff:1.2.3.4) stands in for the last two groups.
	const lastColon = host.lastIndexOf(':');
	const last = host.slice(lastColon + 1);
	if (last.indexOf('.') !== -1) {
		const octets = last.split('.');
		if (octets.length !== 4) return null;
		const n = [];
		for (const octet of octets) {
			if (!/^\d{1,3}$/.test(octet)) return null;
			const value = Number(octet);
			if (value > 255) return null;
			n.push(value);
		}
		head = host.slice(0, lastColon + 1) + '0:0';
		tail = [(((n[0] << 8) | n[1]) >>> 0).toString(16), (((n[2] << 8) | n[3]) >>> 0).toString(16)];
	}

	const parts = head.split('::');
	if (parts.length > 2) return null;
	const left = parts[0] ? parts[0].split(':') : [];
	const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
	const missing = 8 - left.length - right.length;
	if (parts.length === 2 ? missing < 0 : missing !== 0) return null;

	const groups = [...left, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...right];
	if (groups.length !== 8) return null;
	if (tail) { groups[6] = tail[0]; groups[7] = tail[1]; }
	// Every group is VALIDATED - a malformed tail must not fold, or a crafted
	// address header could be made to land in a real client's bucket and spend
	// its allowance. Only the first four are NORMALIZED, because only those four
	// appear in the /64 key, and the parse/format round trip on the other four
	// is waste on a per-request path.
	for (let i = 0; i < 8; i++) {
		if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
		if (i < 4) groups[i] = parseInt(groups[i], 16).toString(16);
	}
	return groups;
}

/**
 * The bucket one client gets.
 *
 * IPv6 is keyed on its allocation PREFIX, not the full address. A /64 is the
 * smallest block a host is routinely GIVEN - the standard allocation from every
 * major hosting provider and most residential ISPs - so keying on the /128 lets
 * one ordinary attacker source every request from a fresh address, never share a
 * bucket with itself, and drive the door at full server speed while the limiter
 * records one request per identity. 6to4 is the exception: `2002:V4ADDR::/48`
 * gives one site the whole /48, so it is keyed on /48.
 *
 * IPv4 keeps its full address, and so does anything that does not parse as a
 * global IPv6 address:
 *
 * - IPv4-mapped (`::ffff:1.2.3.4`) is what an IPv4 client can look like on a
 *   dual-stack listener, and its /64 is shared by the whole IPv4 internet.
 * - Any address whose first four groups are zero - `::1`, `::`, and the
 *   IPv4-compatible and IPv4-mapped forms written in hex or fully expanded -
 *   has the same problem for the same reason.
 * - A scoped or malformed bracketed value is not treated as a global literal.
 *   This is also what stops an attacker-controlled address header spelling a
 *   victim's key followed by ignored garbage.
 * - With `ADDRESS_HEADER` set the value is a client-supplied string that need
 *   not be an address at all.
 *
 * WHICH SHAPE THE RUNTIME REPORTS IS NOT RELIED ON. A dual-stack listener may
 * hand an IPv4 client over dotted, as `::ffff:1.2.3.4`, or fully expanded, and
 * all three decline to fold by a different rule below. That is deliberate:
 * nothing here should have to be revisited because a runtime changed how it
 * spells an address, and this adapter's probe does not record which it emits.
 *
 * Merging distinct clients into one bucket is a far worse error than failing to
 * merge one client's addresses, so every uncertain case declines to fold.
 *
 * @param {string} clientIp resolved client address, or the raw header value
 * @param {number} maxKeyLen longest key stored
 * @returns {string}
 */
export function rateLimitKey(clientIp, maxKeyLen) {
	// TRUNCATE FIRST. The fold parses, and this runs on every upgrade including
	// the reject path the limiter exists to make cheap. A value longer than the
	// cap is not an address - with `ADDRESS_HEADER` set it is a client-supplied
	// string, and for headers other than X-Forwarded-For nothing bounds its
	// length - so folding it first would mean a lowercase, two splits and
	// several regexes over kilobytes of attacker input per request. That is a
	// CPU amplifier built into the guard whose job is to bound one. Real
	// addresses are far below the cap and are unaffected.
	const bounded = clientIp.length > maxKeyLen ? clientIp.slice(0, maxKeyLen) : clientIp;
	const key = foldToPrefix(bounded);
	return key.length > maxKeyLen ? key.slice(0, maxKeyLen) : key;
}

/**
 * @param {string} value
 * @returns {string}
 */
function foldToPrefix(value) {
	let host = value;

	// A bracketed literal, with or without a port: [2001:db8::1]:443
	if (host.charCodeAt(0) === 91) {
		const end = host.indexOf(']');
		if (end === -1) return value;
		const suffix = host.slice(end + 1);
		if (suffix !== '') {
			if (!/^:\d{1,5}$/.test(suffix) || Number(suffix.slice(1)) > 65535) return value;
		}
		host = host.slice(1, end);
	}
	if (host.indexOf(':') === -1) return value; // IPv4, or an opaque header value

	// Fast path for the zero-prefixed forms. An IPv4 client on a dual-stack
	// listener can arrive fully expanded
	// (`0000:0000:0000:0000:0000:ffff:7f00:0001`), which the zero-prefix rule
	// below refuses to fold anyway - recognising it here skips a full parse
	// whose result is thrown away.
	if (host.charCodeAt(0) === 48 || host.charCodeAt(0) === 58) {
		if (/^(0{1,4}:){4}|^::/.test(host)) return value;
	}

	const pct = host.indexOf('%');
	if (pct !== -1) return value; // scoped, not a global literal
	host = host.toLowerCase();

	// `1.2.3.4:5678` has a colon but is IPv4 with a port, not IPv6.
	if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(host)) return value;

	const groups = expandIpv6(host);
	if (groups === null) return value;
	// A zero /64 is not a routing prefix anyone is allocated - see above.
	if (groups[0] === '0' && groups[1] === '0' && groups[2] === '0' && groups[3] === '0') return value;

	// Prefixes where the /64 is SHARED BY UNRELATED CLIENTS, so folding merges
	// people who have nothing to do with each other. The same failure the
	// IPv4-mapped exemption exists for, and the more dangerous half:
	//
	// - NAT64 (`64:ff9b::/32`, RFC 6052 plus the RFC 8215 local-use range): a
	//   server behind a translator sees EVERY IPv4 client as `64:ff9b::a.b.c.d`,
	//   so one bucket would hold the entire translated IPv4 internet and ten
	//   upgrades would lock out every IPv4 user of that deployment.
	// - Teredo (`2001::/32`): the /64 identifies the relay, not the host.
	// - Link-local (`fe80::/10`): one /64 for an entire LAN.
	//
	// The address is kept whole instead.
	if (groups[0] === '64' && groups[1] === 'ff9b') return value;
	if (groups[0] === '2001' && groups[1] === '0') return value;
	const first = parseInt(groups[0], 16);
	if ((first & 0xffc0) === 0xfe80) return value;

	// 6to4 gives one site `2002:V4ADDR::/48`. Folding only the ordinary /64
	// would leave that site 65,536 independently metered subnet buckets.
	if (groups[0] === '2002') return `${groups[0]}:${groups[1]}:${groups[2]}::`;
	return `${groups[0]}:${groups[1]}:${groups[2]}:${groups[3]}::`;
}

/**
 * @typedef {object} SlidingWindowLimiter
 * @property {Map<string, { prev: number, curr: number, windowStart: number }>} map
 * @property {(clientIp: string, nowMs: number) => boolean} exceeded
 * @property {(nowMs: number) => void} sweep
 */

/**
 * Build a sliding-window limiter.
 *
 * @param {object} opts
 * @param {number} opts.maxPerWindow requests admitted per window; `0` disables
 * @param {number} opts.windowMs
 * @param {number} opts.maxEntries hard cap on tracked identities
 * @param {number} opts.evictionSample how many entries eviction inspects per pass
 * @param {number} opts.maxKeyLen longest key stored
 * @param {() => void} [opts.onEvict] called once per eviction, for a counter
 * @returns {SlidingWindowLimiter}
 */
export function createSlidingWindowLimiter({
	maxPerWindow,
	windowMs,
	maxEntries,
	evictionSample,
	maxKeyLen,
	onEvict
}) {
	/** @type {Map<string, { prev: number, curr: number, windowStart: number }>} */
	const map = new Map();

	/**
	 * Rotating position for {@link evictOne}, held ACROSS calls.
	 *
	 * A deleted Map slot is marked with a tombstone and only compacted when the
	 * table rehashes, so at the cap - where every miss deletes one entry and
	 * inserts another - a FRESH iterator must walk an ever-growing run of
	 * tombstones before reaching the first live entry. A sample that reads as
	 * O(evictionSample) then degrades to O(size), which gets worse as the cap
	 * grows: backwards for a bound. Keeping the iterator alive means each
	 * tombstone is stepped over at most once on the way past, rather than
	 * re-walked from the head on every insertion.
	 *
	 * @type {Iterator<[string, { prev: number, curr: number, windowStart: number }]> | null}
	 */
	let evictCursor = null;

	/**
	 * Reclaim one slot, preferring the least active identity in the sample.
	 *
	 * The cursor rotates through the table rather than always inspecting the
	 * oldest entries: insertion order puts the longest-lived legitimate clients
	 * first, so sampling from the head would feed exactly the clients worth
	 * keeping to a flood of one-shot identities.
	 */
	function evictOne() {
		/** @type {string | null} */
		let victim = null;
		let victimScore = Infinity;
		let sampled = 0;
		let wrapped = 0;
		// At least one, always. A sample of 0 or a non-number makes the loop below
		// never run, so nothing is ever evicted and the entry cap silently stops
		// bounding the map - the guard's own bound disabled by a misconfigured
		// knob. Not reachable from config today; cheap to make impossible.
		const sampleTarget = Number.isFinite(evictionSample) && evictionSample >= 1
			? Math.floor(evictionSample)
			: 1;
		while (sampled < sampleTarget && wrapped < 2) {
			if (evictCursor === null) {
				evictCursor = map.entries();
				wrapped++;
			}
			const step = evictCursor.next();
			if (step.done) {
				evictCursor = null;
				continue;
			}
			sampled++;
			const [k, e] = step.value;
			const score = e.prev + e.curr;
			if (score < victimScore) { victimScore = score; victim = k; }
		}
		if (victim !== null) {
			map.delete(victim);
			if (onEvict) onEvict();
		}
	}

	return {
		map,

		/**
		 * Record a request from `clientIp` and report whether it exceeds the
		 * limit. Returns false immediately when the limiter is disabled.
		 *
		 * @param {string} clientIp
		 * @param {number} nowMs
		 * @returns {boolean} true when the request should be REFUSED
		 */
		exceeded(clientIp, nowMs) {
			if (maxPerWindow <= 0) return false;

			// Fold IPv6 to its allocation prefix and bound the key length - see
			// rateLimitKey. The bound is what makes the entry cap bound BYTES and
			// not only count: an X-Forwarded-For chain can legitimately run to
			// kilobytes, and that becomes the client's identity once ADDRESS_HEADER
			// is set. Two values beyond the bound that share a prefix collapse into
			// one bucket, which makes such a flood rate-limit itself sooner;
			// ordinary single-address identities fit whole and are never merged by
			// truncation.
			const key = rateLimitKey(clientIp, maxKeyLen);

			let entry = map.get(key);
			if (!entry) {
				// The entry cap is enforced at INSERTION, not only by the periodic
				// sweep: between sweeps a burst of rotating identities would
				// otherwise grow the map without bound.
				//
				// EVICT, do not refuse. Refusing a new key at the cap looks like the
				// fail-closed choice, but the map is a shared resource: one host
				// rotating an address header fills every slot cheaply and every
				// OTHER client - all of them innocent - is refused until the next
				// sweep, turning a slow leak into a total outage. Dropping the least
				// active entry keeps the map bounded while a new client is always
				// admitted; the worst an attacker gains is resetting some other
				// identity's window, which that client's own limit re-establishes on
				// its next request.
				if (map.size >= maxEntries) evictOne();
				entry = { prev: 0, curr: 0, windowStart: nowMs };
				map.set(key, entry);
			} else {
				const elapsed = nowMs - entry.windowStart;
				if (elapsed >= 2 * windowMs) {
					entry.prev = 0;
					entry.curr = 0;
					entry.windowStart = nowMs;
				} else if (elapsed >= windowMs) {
					entry.prev = entry.curr;
					entry.curr = 0;
					entry.windowStart = nowMs;
				}
			}

			// Sliding estimate: the previous window's count fades out linearly as
			// the current window progresses. At 0% elapsed prev counts fully; at
			// 100% it contributes nothing and the window rotates next time. This is
			// what stops a client doubling its effective rate by placing requests
			// either side of a fixed-window boundary.
			const elapsed = nowMs - entry.windowStart;
			const estimate = entry.prev * (1 - elapsed / windowMs) + entry.curr;
			if (estimate >= maxPerWindow) return true;
			entry.curr++;
			return false;
		},

		/**
		 * Drop entries idle for two full windows. Cheap to call periodically; the
		 * insertion-time cap is what bounds the map between calls.
		 *
		 * @param {number} nowMs
		 * @returns {void}
		 */
		sweep(nowMs) {
			for (const [key, entry] of map) {
				if (nowMs - entry.windowStart >= 2 * windowMs) map.delete(key);
			}
			// Release the eviction cursor, unconditionally, every sweep.
			//
			// A live Map iterator pins the backing table it was opened on, and every
			// later rehash chains onto that one. Releasing only when the map empties
			// is a condition a server with ANY resident traffic never reaches, so
			// one burst past the entry cap would create a cursor that then retained
			// superseded tables for the life of the process - unbounded growth
			// inside the guard whose whole job is to bound memory, reachable by
			// anyone who can open connections.
			//
			// The cost is that the rotation restarts from the head after each sweep,
			// so one eviction per sweep samples the long-lived entries the rotation
			// exists to protect. That is a bounded, periodic weakening of VICTIM
			// CHOICE - a heuristic - traded against an unbounded leak, and evictions
			// during a flood vastly outnumber sweeps, so the cursor still rotates
			// for all but the first sample after each one.
			evictCursor = null;
		},

		/**
		 * Drop every tracked identity and release the cursor.
		 *
		 * For the simulator alone, and for the reason the admission controller
		 * has one: production builds this once per process, while the sim runs a
		 * whole corpus of servers in one - so without it a seed would inherit the
		 * windows of every seed before it, and a fingerprint would depend on the
		 * order its seed was run in. `sweep` is not a substitute: it retires what
		 * is IDLE, and the entries a previous run left behind are, by its clock,
		 * brand new.
		 */
		_resetForSim() {
			map.clear();
			evictCursor = null;
		}
	};
}
