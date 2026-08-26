import { parseRange } from './range.js';
import { negotiateEncoding } from './static-negotiate.js';
import { httpDateSeconds } from './http-date.js';

/**
 * Decide what a static asset request gets: status, content-coding, and byte
 * range. This is the ordering that conditional requests, range requests, and
 * content negotiation all depend on, and it is where this adapter's two
 * nastiest static bugs lived - a compressed representation sharing the
 * identity validator (silent corruption on resume), and a junk Range header
 * disabling compression for everyone (egress amplification). Both were
 * ordering mistakes, invisible to any test that could not reach this logic.
 *
 * So it lives here, with the caller supplying the entry's facts and applying
 * the result. The order it works in is load-bearing and spelled out at the
 * step it governs.
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
 * `encoding` on a 304 is the coding of the representation the request selected,
 * because the validator the 304 carries has to be that representation's - not
 * the identity one it would otherwise default to.
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
	// Which representation this request would GET is decided FIRST, because
	// every precondition below is defined against the SELECTED representation
	// (RFC 9110 s13.1). Deciding it after the fact is how If-Match came to
	// accept the gzip validator for a request that was about to be answered
	// with identity bytes.
	//
	//   1. resolve the range, because whether one will be SERVED decides the
	//      representation - a range is identity-only, and a Range header that
	//      cannot be honoured (malformed, multi-range, stale If-Range) must
	//      fall through to a normal negotiated response rather than silently
	//      pinning identity;
	//   2. negotiate the coding;
	//   3. take that representation's validator, and answer every precondition
	//      against it.
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

	// The 412 preconditions come next - RFC 9110's evaluation order, and the
	// only order that cannot lie: a failed If-Match must not be converted into
	// a 304 by an If-None-Match that happens to match, because the client that
	// sent both is asking "is my version still the current one" and the answer
	// is no.
	//
	// If-Match is compared as OPAQUE EQUALITY rather than with the strong
	// comparison RFC 9110 prescribes. Every validator this lane issues is weak
	// by construction (mtime + size), and a weak validator never strong-matches
	// ANYTHING - so the strict reading answers 412 to every client that echoes
	// the exact validator this server handed it, for a byte-identical resource.
	// Matching what we issued is what the precondition is for. That is the only
	// deviation: the tag still has to be THIS representation's, so a client
	// holding the gzip copy and asking for identity is told its copy is not the
	// one being served, which is the question it asked.
	if (ifMatch) {
		if (!listNames(ifMatch, repEtag)) return { status: 412, encoding: '' };
	} else if (ifUnmodifiedSince && entry.mtimeSec !== undefined) {
		// Evaluated only when If-Match is absent (RFC 9110 s13.2.2), at the
		// whole-second precision HTTP dates carry. An unintelligible date is an
		// ignored header, not a refusal - the client said nothing about time,
		// and 412 on garbage would refuse requests a proxy mangled.
		const t = httpDateSeconds(ifUnmodifiedSince);
		if (!Number.isNaN(t) && entry.mtimeSec > t) {
			return { status: 412, encoding: '' };
		}
	}

	// If-None-Match takes `*`, takes a list, and compares weakly - which is
	// what RFC 9110 s13.1.2 asks for and what a cache revalidating a stored
	// response actually sends. The encoding travels with the 304 because the
	// validator it carries has to be the one for the representation that was
	// selected, not the identity one.
	if (repEtag && ifNoneMatch && listNames(ifNoneMatch, repEtag)) {
		return { status: 304, encoding };
	}
	// Date revalidation is the fallback for a cache that lost the validator,
	// and RFC 9110 says to ignore it entirely when If-None-Match was sent -
	// the client that sent both wants the etag answer, and a date-based 304
	// after an etag MISmatch would claim freshness the validator just denied.
	if (!ifNoneMatch && ifModifiedSince && entry.mtimeSec !== undefined) {
		const t = httpDateSeconds(ifModifiedSince);
		if (!Number.isNaN(t) && entry.mtimeSec <= t) {
			return { status: 304, encoding };
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

/**
 * The opaque part of an entity-tag, so a client echoing `"x"` for a validator
 * this server spelled `W/"x"` is recognised. Every tag here is weak, and weak
 * comparison - which is what If-None-Match is defined to use - ignores the
 * prefix.
 *
 * @param {string} tag
 * @returns {string}
 */
function opaqueTag(tag) {
	return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * Does a precondition header name this validator? Handles `*` and the list
 * form both preconditions are defined over.
 *
 * @param {string} header - the raw If-Match / If-None-Match value
 * @param {string | undefined} validator - the selected representation's etag
 * @returns {boolean}
 */
function listNames(header, validator) {
	for (const token of header.split(',')) {
		const t = token.trim();
		if (t === '') continue;
		if (t === '*') return true;
		if (validator && opaqueTag(t) === opaqueTag(validator)) return true;
	}
	return false;
}
