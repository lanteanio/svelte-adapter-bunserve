import { parseRange } from './range.js';
import { negotiateEncoding } from './static-negotiate.js';

/**
 * Decide what a static asset request gets: status, content-coding, and byte
 * range. This is the ordering that conditional requests, range requests, and
 * content negotiation all depend on, and it is where this adapter's two
 * nastiest static bugs lived - a compressed representation sharing the
 * identity validator (silent corruption on resume), and a junk Range header
 * disabling compression for everyone (egress amplification). Both were
 * ordering mistakes, invisible to any test that could not reach this logic.
 *
 * So it lives here, pure and free of IO, with the caller supplying the entry's
 * facts and applying the result. The order below is load-bearing:
 *
 *   1. resolve the range, because whether one will be SERVED decides the
 *      representation - a range is identity-only, and a Range header that
 *      cannot be honoured (malformed, multi-range, stale If-Range) must fall
 *      through to a normal negotiated response rather than silently pinning
 *      identity;
 *   2. negotiate the coding;
 *   3. evaluate If-None-Match against THAT representation's validator, since
 *      each coding is a distinct representation (RFC 7232) - and before the
 *      range, which RFC 7232 requires.
 *
 * @typedef {{
 *   etag: string,
 *   brEtag?: string,
 *   gzEtag?: string,
 *   hasBr?: boolean,
 *   hasGz?: boolean
 * }} PlanEntry
 *
 * @typedef {{ status: 200 | 304 | 416, encoding: '' | 'br' | 'gzip' }
 *   | { status: 206, encoding: '', start: number, end: number }} StaticPlan
 *
 * @param {PlanEntry} entry - the asset's precomputed identity facts
 * @param {number} size - identity byte length
 * @param {string} rangeHeader
 * @param {string} ifRange
 * @param {string} ifNoneMatch
 * @param {string} acceptEncoding
 * @returns {StaticPlan}
 */
export function planStaticResponse(entry, size, rangeHeader, ifRange, ifNoneMatch, acceptEncoding) {
	// Ranges apply only to assets carrying a validator (immutable versioned
	// assets never need them), are single-range only (RFC 7233 permits
	// ignoring multiple ranges), and are honoured only when If-Range matches
	// the identity validator the offsets refer to.
	/** @type {{ start: number, end: number } | null | false} */
	let range = false;
	if (rangeHeader && entry.etag) {
		if ((!ifRange || ifRange === entry.etag) && !rangeHeader.includes(',')) {
			range = parseRange(rangeHeader, size);
		}
	}

	const encoding = range !== false
		? ''
		: negotiateEncoding(acceptEncoding, {
			hasBr: entry.hasBr === true,
			hasGz: entry.hasGz === true
		});

	// The validator of the representation the client would actually receive.
	// Precomputed per coding at index time - deriving it here would allocate a
	// string on every request just to compare it.
	const repEtag = encoding === 'br'
		? /** @type {string} */ (entry.brEtag)
		: encoding === 'gzip'
			? /** @type {string} */ (entry.gzEtag)
			: entry.etag;

	// Exact-match comparison only: neither `If-None-Match: *` nor a
	// comma-separated list of validators matches, so both fall through to a
	// full response. That is a conservative answer (a needless 200 rather than
	// a wrong 304) and matches svelte-adapter-uws; both forms are vanishingly
	// rare on the GET traffic this path serves.
	if (repEtag && ifNoneMatch === repEtag) {
		return { status: 304, encoding: '' };
	}
	if (range === null) {
		// Syntactically valid but the start position is beyond EOF
		return { status: 416, encoding: '' };
	}
	if (range !== false) {
		return { status: 206, encoding: '', start: range.start, end: range.end };
	}
	return { status: 200, encoding };
}
