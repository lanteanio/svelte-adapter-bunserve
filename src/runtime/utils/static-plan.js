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
 *   mtimeSec?: number,
 *   hasBr?: boolean,
 *   hasGz?: boolean
 * }} PlanEntry
 *
 * @typedef {{ status: 200 | 304 | 412 | 416, encoding: '' | 'br' | 'gzip' }
 *   | { status: 206, encoding: '', start: number, end: number }} StaticPlan
 *
 * @param {PlanEntry} entry - the asset's precomputed identity facts
 * @param {number} size - identity byte length
 * @param {string} rangeHeader
 * @param {string} ifRange
 * @param {string} ifNoneMatch
 * @param {string} acceptEncoding
 * @param {string} [ifMatch]
 * @param {string} [ifUnmodifiedSince]
 * @param {string} [ifModifiedSince]
 * @returns {StaticPlan}
 */
export function planStaticResponse(
	entry,
	size,
	rangeHeader,
	ifRange,
	ifNoneMatch,
	acceptEncoding,
	ifMatch = '',
	ifUnmodifiedSince = '',
	ifModifiedSince = ''
) {
	// The 412 preconditions come first - RFC 9110's evaluation order, and the
	// only order that cannot lie: a failed If-Match must not be converted into
	// a 304 by an If-None-Match that happens to match, because the client that
	// sent both is asking "is my version still the current one" and the answer
	// is no.
	//
	// If-Match is compared as OPAQUE EQUALITY against any of the entry's
	// validators, not with the strong comparison RFC 9110 prescribes. Every
	// validator this lane issues is weak by construction (mtime + size), and a
	// weak validator never strong-matches ANYTHING - so the strict reading
	// answers 412 to every client that echoes the exact validator this server
	// handed it, for a byte-identical resource. Matching what we issued is
	// what the precondition is for. The list form is split because a wrong
	// answer here refuses a request that should have succeeded, which is the
	// opposite of If-None-Match's safe direction (a needless 200).
	if (ifMatch) {
		let matched = false;
		for (const token of ifMatch.split(',')) {
			const t = token.trim();
			if (t === '*' || (t !== '' && (t === entry.etag || t === entry.brEtag || t === entry.gzEtag))) {
				matched = true;
				break;
			}
		}
		if (!matched) return { status: 412, encoding: '' };
	} else if (ifUnmodifiedSince && entry.mtimeSec !== undefined) {
		// Evaluated only when If-Match is absent (RFC 9110 s13.2.2), at the
		// whole-second precision HTTP dates carry. An unparseable date is an
		// ignored header, not a refusal - the client said nothing intelligible
		// about time, and 412 on garbage would refuse requests a proxy
		// mangled.
		const t = Date.parse(ifUnmodifiedSince);
		if (!Number.isNaN(t) && entry.mtimeSec > Math.floor(t / 1000)) {
			return { status: 412, encoding: '' };
		}
	}
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
	// Date revalidation is the fallback for a cache that lost the validator,
	// and RFC 9110 says to ignore it entirely when If-None-Match was sent -
	// the client that sent both wants the etag answer, and a date-based 304
	// after an etag MISmatch would claim freshness the validator just denied.
	if (!ifNoneMatch && ifModifiedSince && entry.mtimeSec !== undefined) {
		const t = Date.parse(ifModifiedSince);
		if (!Number.isNaN(t) && entry.mtimeSec <= Math.floor(t / 1000)) {
			return { status: 304, encoding: '' };
		}
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
