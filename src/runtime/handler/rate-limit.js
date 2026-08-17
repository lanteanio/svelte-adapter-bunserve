// The server's rate limiters for the doors that meter by client address - the
// WebSocket upgrade and the auth preflight - plus the address they key on.
//
// It lives in its own module for the reason `admission.js` does: the limiters
// are reached from the request paths, their periodic sweep is driven from the
// pressure sampler, and importing either of those from the other to reach a
// singleton would be a cycle. A second instance of one would be worse than a
// cycle - two maps, each metering half the traffic, and a limit that admits
// twice what it says.
//
// The two doors are metered SEPARATELY, as the sibling meters them: every
// reconnect that preflights also upgrades, so one shared budget would make
// whichever door is tighter the binding constraint on both.

import { ws_options, address_header, trusted_proxies, xff_depth } from './config.js';
import { createSlidingWindowLimiter } from '../utils/rate-limiter.js';
import { monotonicNow } from '../runtime.js';

/**
 * Identities retained under a sustained flood. Enforced at insertion by
 * evicting the least active of a bounded sample, so the map can never outgrow
 * the cap between sweeps and a newcomer is never refused because other
 * identities filled it.
 */
const MAX_RATE_ENTRIES = 10_000;

/** How many entries each rotating insertion-time eviction sample inspects. */
const RATE_MAP_EVICTION_SAMPLE = 16;

/**
 * Longest key the map will store.
 *
 * Capping the ENTRY COUNT alone does not bound memory, because the key is not
 * necessarily an address: with `ADDRESS_HEADER` configured and no
 * `TRUSTED_PROXIES` it is the client's header value verbatim. Ten thousand
 * multi-kilobyte keys is tens of megabytes, not the couple of megabytes the
 * entry cap implies. Aligned with the resolver's single-header ceiling, so
 * accepted identities are never merged merely because the limiter kept a
 * shorter prefix, while a legitimate multi-hop X-Forwarded-For still gets a
 * bound.
 */
const MAX_RATE_KEY_LEN = 128;

/**
 * Identities dropped at the map cap, per door.
 *
 * An eviction is not a refusal and is not visible to any client: the evicted
 * identity simply starts a fresh window next time it is seen, so it gets a full
 * allowance it had not earned. A steady rate here means the cap - not the
 * configured limit - is what is deciding who gets metered, which is the one
 * thing an operator cannot infer from the refusal counts.
 *
 * Two plain numbers rather than instruments: nothing reads them until something
 * scrapes, and the eviction path is inside the limiter's insertion cap.
 */
export const rateMapEvictions = { upgrade: 0, auth: 0 };

/**
 * Whether the limiter gates anything. `0` is the documented spelling for
 * "disabled", so a server that sets it pays for no map and no key folding.
 */
const configuredLimit = typeof ws_options?.upgradeRateLimit === 'number'
	&& Number.isFinite(ws_options.upgradeRateLimit) && ws_options.upgradeRateLimit > 0
	? ws_options.upgradeRateLimit
	: 0;

/**
 * The window, in milliseconds. Only consulted when the limiter exists, and the
 * normalizer refuses a zero window, so this cannot be the value that breaks the
 * estimate.
 */
const windowMs = (typeof ws_options?.upgradeRateLimitWindow === 'number'
	&& Number.isFinite(ws_options.upgradeRateLimitWindow) && ws_options.upgradeRateLimitWindow > 0
	? ws_options.upgradeRateLimitWindow
	: 10) * 1000;

/**
 * Null when nothing is metered, which every call site checks for rather than
 * paying for a limiter whose limit is zero. The cost is not the allocation; it
 * is the key fold on a path every upgrade takes.
 *
 * @type {ReturnType<typeof createSlidingWindowLimiter> | null}
 */
export const upgradeRateLimiter = configuredLimit > 0
	? createSlidingWindowLimiter({
		maxPerWindow: configuredLimit,
		windowMs,
		maxEntries: MAX_RATE_ENTRIES,
		evictionSample: RATE_MAP_EVICTION_SAMPLE,
		maxKeyLen: MAX_RATE_KEY_LEN,
		onEvict: () => { rateMapEvictions.upgrade++; }
	})
	: null;

/** The configured limit, for a refusal that wants to say what it was. */
export const upgradeRateLimitPerWindow = configuredLimit;

/** The configured window in seconds, for the same reason. */
export const upgradeRateLimitWindowSeconds = windowMs / 1000;

/**
 * The auth preflight's own budget, read the same way and defaulted HIGHER on
 * purpose - the sibling's 30 per 10s against the upgrade door's 10.
 *
 * Every reconnect that preflights also upgrades, so this door sees at least as
 * much traffic as that one during a deploy's reconnect wave, and a NAT'd network
 * behind one address multiplies both. Matching them 1:1 would make the preflight
 * the binding constraint and refuse traffic the upgrade limit would have
 * admitted.
 */
const configuredAuthLimit = typeof ws_options?.authPathRateLimit === 'number'
	&& Number.isFinite(ws_options.authPathRateLimit) && ws_options.authPathRateLimit > 0
	? ws_options.authPathRateLimit
	: 0;

/** That door's window in milliseconds; the normalizer refuses a zero window. */
const authWindowMs = (typeof ws_options?.authPathRateLimitWindow === 'number'
	&& Number.isFinite(ws_options.authPathRateLimitWindow) && ws_options.authPathRateLimitWindow > 0
	? ws_options.authPathRateLimitWindow
	: 10) * 1000;

/**
 * Null when nothing is metered at that door, which its call site checks for
 * rather than paying for a limiter whose limit is zero.
 *
 * A SECOND map with the same bounds, not a shared one: the maps are what bound
 * memory under a flood, and an identity being known to one door says nothing
 * about the other's budget.
 *
 * @type {ReturnType<typeof createSlidingWindowLimiter> | null}
 */
export const authRateLimiter = configuredAuthLimit > 0
	? createSlidingWindowLimiter({
		maxPerWindow: configuredAuthLimit,
		windowMs: authWindowMs,
		maxEntries: MAX_RATE_ENTRIES,
		evictionSample: RATE_MAP_EVICTION_SAMPLE,
		maxKeyLen: MAX_RATE_KEY_LEN,
		onEvict: () => { rateMapEvictions.auth++; }
	})
	: null;

/** The configured auth limit, for a refusal that wants to say what it was. */
export const authRateLimitPerWindow = configuredAuthLimit;

/** That door's window in seconds. */
export const authRateLimitWindowSeconds = authWindowMs / 1000;

// SAID AT BOOT, once, while there is still an operator reading the log.
//
// `ADDRESS_HEADER` without `TRUSTED_PROXIES` makes the bucket key a string the
// CLIENT supplies, and that is a different proposition for a limiter than it is
// for `getClientAddress()`. The app-facing resolver inherits trust-verbatim from
// adapter-node and an app reading an address knows to configure its proxy; a
// limiter keyed on an unauthenticated value is a control anyone can step around
// by sending a fresh value per request, and can point at a victim by sending
// theirs. The refusals still happen, so nothing here looks broken from inside.
//
// A warning rather than a refusal, and the key is not changed: the two adapters
// in this family resolve the same identity from the same configuration, and a
// deployment that meters on the header today would collapse into its gateway's
// bucket if this quietly stopped honouring it - a worse outage than the evasion
// it would close. Making it a refusal is a family decision, and it belongs on
// both adapters or neither.
if (address_header && !trusted_proxies && (upgradeRateLimiter !== null || authRateLimiter !== null)) {
	console.warn(
		`[adapter] ADDRESS_HEADER is set to \`${address_header}\` and TRUSTED_PROXIES is not, so the\n` +
		'  rate limiters key on a value any client can choose. A client can spend a fresh key per\n' +
		'  request and never reach a limit, or send another client\'s address and spend theirs. Set\n' +
		'  TRUSTED_PROXIES to your proxy\'s address or CIDR range, so the header is honoured only\n' +
		'  where it was written by something you run.'
	);
}

/**
 * Record this handshake and report whether it is over the limit.
 *
 * THE CLOCK IS READ HERE, and only here, so metering and sweeping cannot end up
 * on two different ones - a window opened against one clock and closed against
 * another is a bug with no symptom until the two disagree.
 *
 * It is the MONOTONIC clock, which is where this differs from uws: the window
 * is an elapsed-time measurement, and the wall clock is not one. An NTP step
 * backwards makes `now - windowStart` negative, which reads as a window that
 * has not started; a step forwards can retire a window early. Neither is
 * reachable from config and both are invisible when they happen. The observable
 * contract - N upgrades per window per client - is unchanged, so this is which
 * clock measures the window rather than what the window means.
 *
 * @param {string} address
 * @returns {boolean} true when the handshake should be REFUSED
 */
export function upgradeRateLimitExceeded(address) {
	if (upgradeRateLimiter === null) return false;
	return upgradeRateLimiter.exceeded(address, monotonicNow());
}

/**
 * Record this preflight and report whether it is over the limit. The same
 * clock, read in the same one place, for the reason above.
 *
 * @param {string} address
 * @returns {boolean} true when the request should be REFUSED
 */
export function authRateLimitExceeded(address) {
	if (authRateLimiter === null) return false;
	return authRateLimiter.exceeded(address, monotonicNow());
}

/**
 * Drop identities idle for two whole windows, at both doors. Driven from the
 * pressure sampler's tick, which is the process's existing periodic work - a
 * limiter that is off schedules nothing, and the insertion-time cap is what
 * bounds each map between sweeps in any case.
 */
export function sweepRateLimits() {
	const now = monotonicNow();
	if (upgradeRateLimiter !== null) upgradeRateLimiter.sweep(now);
	if (authRateLimiter !== null) authRateLimiter.sweep(now);
}

/**
 * Whether an address is one a client cannot have arrived from over the public
 * internet. Used only to decide whether a refusal is worth an advisory - it is
 * a heuristic about deployment shape, not a security boundary.
 *
 * @param {string} address
 * @returns {'loopback' | 'private' | 'public' | 'unknown'}
 */
export function addressScope(address) {
	if (!address) return 'unknown';
	const a = address.toLowerCase();
	if (a === '::1' || a.startsWith('127.')) return 'loopback';
	if (a.startsWith('10.') || a.startsWith('192.168.')) return 'private';
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 'private';
	// Unique-local (fc00::/7) and link-local (fe80::/10).
	if (/^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a)) return 'private';
	// The same addresses as an IPv4-mapped literal, which is what a dual-stack
	// listener can report.
	if (a.startsWith('::ffff:')) return addressScope(a.slice('::ffff:'.length));
	return 'public';
}

/**
 * Advisories already given, keyed by door AND by what was wrong.
 *
 * See the latch note in `warnRateLimitProxyCollapse`.
 *
 * @type {Set<string>}
 */
const warnedProxyCollapse = new Set();

/**
 * Say once, per door, that this server may be metering every client as one.
 *
 * THREE SHAPES REACH THE SAME OUTCOME, and the advisory has to know all three,
 * because the two that were missing are the ones where the collapse is TOTAL
 * rather than per-gateway:
 *
 * - No client address at all. `requestIP` answers null for a socket already
 *   gone, and on some deployment shapes it can answer null for live ones, so
 *   every client keys on the empty string and the whole server shares one
 *   bucket. Nothing about the empty key looks private or loopback.
 * - `ADDRESS_HEADER` configured but not arriving, or arriving in a shape the
 *   configured depth cannot read. The resolver falls back to the socket peer
 *   rather than throwing - deliberately, since a dropped header must not 500
 *   every handshake - so the deployment believes it is metering clients while
 *   it is metering its gateway. THE SOURCE IS WHAT SAYS SO: asking the request
 *   whether the header arrived answers yes for both of the unusable shapes.
 * - The header arriving from a peer TRUSTED_PROXIES does not name. Correct for
 *   a direct client, and a total permanent collapse when the allowlist simply
 *   misses the real proxy - which nothing else reports, since the header is
 *   present on every request and the boot warning only fires with no allowlist
 *   at all.
 * - A loopback or private peer with no `ADDRESS_HEADER`: an address-rewriting
 *   proxy in front of the server, every client arriving as the gateway.
 *
 * The symptom is the same for all of them and is otherwise very hard to
 * attribute: intermittent 429s under trivial traffic. One-shot per cause rather
 * than throttled, because a server directly facing the internet sees real client
 * addresses here and reaches none of them.
 *
 * @param {string} source where the key came from, from `resolveRateLimitAddress`
 * @param {string} address the address the refusal was keyed on
 * @param {{ what: string, knob: string, limit: number, windowSeconds: number }} door
 */
export function warnRateLimitProxyCollapse(source, address, door) {
	/** @type {string | null} */
	let cause = null;
	/** @type {string} */
	let kind;

	if (source === 'header') {
		// The header decided this key. An empty value is still a collapse - every
		// client carrying one shares the empty bucket - but it is a value the
		// CLIENT chose, so it is reported as what it is rather than as "the
		// runtime could not see a peer".
		if (address !== '') return;
		kind = 'header-empty';
		cause =
			`the \`${address_header}\` value this request carried was empty, so it keyed on nothing.\n` +
			'  Every client sending an empty one shares that bucket. The header is honoured from\n' +
			'  whoever sends it unless TRUSTED_PROXIES names your proxies.';
	} else if (source === 'header-absent') {
		kind = 'header-absent';
		cause =
			`ADDRESS_HEADER is set to \`${address_header}\`, but this request did not carry it, so the\n` +
			'  socket peer was metered instead. Behind a proxy that is one bucket for everyone;\n' +
			'  check that the proxy sets the header on the WebSocket route as well as on ordinary\n' +
			'  requests.';
	} else if (source === 'header-unusable') {
		kind = 'header-unusable';
		cause =
			`the \`${address_header}\` value this request carried could not be read at the configured\n` +
			'  depth, so the socket peer was metered instead. A chain shorter than XFF_DEPTH, or one\n' +
			'  past the 8 KiB ceiling, does both silently: behind a proxy EVERY client then meters as\n' +
			'  the gateway and the limit below is one global cap. Check XFF_DEPTH against the number\n' +
			'  of proxies that actually append to the chain.';
	} else if (source === 'header-untrusted') {
		// Ordinary for a genuinely direct client on a server that is also
		// reachable through its proxy. A permanent, total collapse when the
		// allowlist does not name the real proxy - and nothing else says so, since
		// the header IS present on every request and the boot warning only fires
		// when TRUSTED_PROXIES is unset.
		kind = 'header-untrusted';
		cause =
			`this request carried \`${address_header}\`, but its peer (${address || 'unknown'}) is not in\n` +
			'  TRUSTED_PROXIES, so the claim was ignored and the peer was metered. That is correct for\n' +
			'  a client connecting directly. If it is your proxy, the allowlist does not name it - and\n' +
			'  then EVERY client meters as that one address.';
	} else if (address === '') {
		kind = 'no-address';
		cause =
			'no client address could be resolved, so EVERY client shares one bucket and the\n' +
			'  limit below is a single server-wide cap.';
	} else {
		const scope = addressScope(address);
		if (scope !== 'loopback' && scope !== 'private') return;
		kind = 'peer-' + scope;
		cause =
			`the client address is ${scope} (${address}) and ADDRESS_HEADER is unset. If this server\n` +
			'  runs behind a reverse proxy, a load balancer, or docker\'s userland-proxy, every\n' +
			'  client arrives as the same address and the limit below is really one GLOBAL cap.';
	}

	// LATCHED PER DOOR AND PER CAUSE. Per door because the message names a door,
	// a limit and a knob, so one latch for the process leaves the second door's
	// operator changing an option that governs the other one. Per cause because
	// some of these are reachable by a CLIENT - an empty header value is one
	// request away - and a single latch per door would let anyone spend it and
	// leave the deployment's real collapse permanently unmentionable.
	const latch = door.knob + '\n' + kind;
	if (warnedProxyCollapse.has(latch)) return;
	warnedProxyCollapse.add(latch);
	console.warn(
		`[ws] refused ${door.what} (429), and ${cause}\n` +
		`  The limit is \`${door.knob}\` (${door.limit} per ${door.windowSeconds}s).\n` +
		'  Restore real client addresses with ADDRESS_HEADER=x-forwarded-for (plus XFF_DEPTH for\n' +
		'  the trusted hop count) and TRUSTED_PROXIES, or set docker `userland-proxy: false`, or\n' +
		`  set ${door.knob}: 0 if you throttle upstream.`
	);
}

/**
 * Forget every advisory latch. For the simulator alone, and for the reason the
 * limiters have one: a corpus runs many servers in one process, and a latch
 * taken by an early seed would silence every seed after it - making which seed
 * warns depend on the order they ran in.
 */
export function _resetAdvisoriesForSim() {
	warnedProxyCollapse.clear();
}

/** What the upgrade door calls itself in that advisory. */
export const UPGRADE_DOOR = {
	what: 'a WebSocket upgrade',
	knob: 'websocket.upgradeRateLimit',
	limit: upgradeRateLimitPerWindow,
	windowSeconds: upgradeRateLimitWindowSeconds
};

/** And the auth preflight. */
export const AUTH_DOOR = {
	what: 'an auth preflight',
	knob: 'websocket.authPathRateLimit',
	limit: authRateLimitPerWindow,
	windowSeconds: authRateLimitWindowSeconds
};

/**
 * Which address this handshake is metered as, AND WHERE THE KEY CAME FROM.
 *
 * The same precedence the SSR path uses - socket peer by default, the
 * configured `ADDRESS_HEADER` when the direct peer is a trusted proxy - with
 * one deliberate difference: it never THROWS. SSR's resolver is SvelteKit's
 * `getClientAddress`, whose contract is to fail loudly when a configured header
 * is missing, because an app asking for the client's address needs to know it
 * cannot be answered. Here the address is only ever a bucket key, and a proxy
 * that drops a header on some hop would otherwise turn every upgrade on the
 * server into a 500.
 *
 * THE SOURCE IS RETURNED BESIDE THE ADDRESS because every silent way this
 * metering collapses is a statement about the source, not about the value. An
 * advisory that re-derives it from the request can only approximate: asking
 * "did the header arrive" answers yes for a chain shorter than `XFF_DEPTH` and
 * for one past the size ceiling, and both of those meter every client on the
 * server as the gateway - a total, permanent collapse that would then go
 * unmentioned. Only the code that made the decision knows which branch it took.
 *
 * @param {Request} req
 * @param {string} direct the socket peer address, or '' when unknown
 * @returns {{ address: string, source: 'peer' | 'header' | 'header-untrusted' | 'header-absent' | 'header-unusable' }}
 */
export function resolveRateLimitAddress(req, direct) {
	if (!address_header) return { address: direct, source: 'peer' };
	// A header claim from a peer outside TRUSTED_PROXIES is ignored rather than
	// refused: that request is a direct client, and its socket address IS its
	// address. Ordinary on a server that is reachable directly as well as through
	// its proxy; a collapse when the allowlist simply does not name the real one,
	// which is why the source says which happened and the advisory decides.
	if (trusted_proxies && !trusted_proxies.match(direct)) {
		return { address: direct, source: 'header-untrusted' };
	}
	const value = req.headers.get(address_header);
	if (value === null) return { address: direct, source: 'header-absent' };
	if (address_header === 'x-forwarded-for') {
		// The same 8 KiB ceiling the SSR path applies. Past it the value is not
		// a hop chain any proxy produced, and the limiter's own key bound would
		// truncate it anyway - but doing that here keeps the split and the trim
		// below off a value that size.
		if (value.length > 8192) return { address: direct, source: 'header-unusable' };
		const addresses = value.split(',');
		// Too few hops to satisfy the configured depth means the chain is not
		// the one this deployment was configured for, so the claim is not
		// honoured. SSR throws here; metering falls back to the peer.
		if (xff_depth > addresses.length) return { address: direct, source: 'header-unusable' };
		return { address: addresses[addresses.length - xff_depth].trim(), source: 'header' };
	}
	return { address: value, source: 'header' };
}

/**
 * The address alone, for callers that only need a bucket key.
 *
 * @param {Request} req
 * @param {string} direct the socket peer address, or '' when unknown
 * @returns {string}
 */
export function rateLimitAddress(req, direct) {
	return resolveRateLimitAddress(req, direct).address;
}
