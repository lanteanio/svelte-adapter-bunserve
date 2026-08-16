// The server's one upgrade rate limiter, plus the address it keys on.
//
// It lives in its own module for the reason `admission.js` does: the limiter is
// reached from the upgrade path, its periodic sweep is driven from the pressure
// sampler, and importing either of those from the other to reach a singleton
// would be a cycle. A second instance would be worse than a cycle - two maps,
// each metering half the traffic, and a limit that admits twice what it says.

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
		maxKeyLen: MAX_RATE_KEY_LEN
	})
	: null;

/** The configured limit, for a refusal that wants to say what it was. */
export const upgradeRateLimitPerWindow = configuredLimit;

/** The configured window in seconds, for the same reason. */
export const upgradeRateLimitWindowSeconds = windowMs / 1000;

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
 * Drop identities idle for two whole windows. Driven from the pressure
 * sampler's tick, which is the process's existing periodic work - a limiter
 * that is off schedules nothing, and the insertion-time cap is what bounds the
 * map between sweeps in any case.
 */
export function sweepUpgradeRateLimit() {
	if (upgradeRateLimiter === null) return;
	upgradeRateLimiter.sweep(monotonicNow());
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
 * Which address this handshake is metered as.
 *
 * The same precedence the SSR path uses - socket peer by default, the
 * configured `ADDRESS_HEADER` when the direct peer is a trusted proxy - with
 * one deliberate difference: it never THROWS. SSR's resolver is SvelteKit's
 * `getClientAddress`, whose contract is to fail loudly when a configured header
 * is missing, because an app asking for the client's address needs to know it
 * cannot be answered. Here the address is only ever a bucket key, and a proxy
 * that drops a header on some hop would otherwise turn every upgrade on the
 * server into a 500. Falling back to the socket peer meters those clients
 * together, which is what the proxy-collapse advisory in the upgrade path
 * exists to say out loud.
 *
 * @param {Request} req
 * @param {string} direct the socket peer address, or '' when unknown
 * @returns {string}
 */
export function rateLimitAddress(req, direct) {
	if (!address_header) return direct;
	// A header claim from a peer outside TRUSTED_PROXIES is ignored rather than
	// refused: that request is a direct client, and its socket address IS its
	// address. Warning here is the SSR path's job - it sees the same peer and
	// warns once - and a per-upgrade advisory on a flood would be its own
	// amplifier.
	if (trusted_proxies && !trusted_proxies.match(direct)) return direct;
	const value = req.headers.get(address_header);
	if (value === null) return direct;
	if (address_header === 'x-forwarded-for') {
		// The same 8 KiB ceiling the SSR path applies. Past it the value is not
		// a hop chain any proxy produced, and the limiter's own key bound would
		// truncate it anyway - but doing that here keeps the split and the trim
		// below off a value that size.
		if (value.length > 8192) return direct;
		const addresses = value.split(',');
		// Too few hops to satisfy the configured depth means the chain is not
		// the one this deployment was configured for, so the claim is not
		// honoured. SSR throws here; metering falls back to the peer.
		if (xff_depth > addresses.length) return direct;
		return addresses[addresses.length - xff_depth].trim();
	}
	return value;
}
