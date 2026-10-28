import { parseRange } from './range.js';
import { parseHttpDate } from './http-date.js';
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
 * So it lives here, with the caller supplying the entry's facts and applying
 * the result. The order it works in is load-bearing and spelled out at the
 * step it governs.
 *
 * @typedef {{
 *   etag: string,
 *   brEtag?: string,
 *   gzEtag?: string,
 *   mtimeSec?: number,
 *   lastModified?: string,
 *   brSize?: number,
 *   gzSize?: number,
 *   hasBr?: boolean,
 *   hasGz?: boolean
 * }} PlanEntry
 *
 * `encoding` on a 304 is the coding of the representation the request selected,
 * because the validator the 304 carries has to be that representation's - not
 * the identity one it would otherwise default to.
 *
 * @typedef {{ status: 200 | 304 | 412 | 416, encoding: '' | 'br' | 'gzip' }
 *   | { status: 206, encoding: '' | 'br' | 'gzip', start: number, end: number }} StaticPlan
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
	const encoding = negotiateEncoding(acceptEncoding, entry.hasBr === true, entry.hasGz === true);
	const repSize = encoding === 'br' ? entry.brSize : encoding === 'gzip' ? entry.gzSize : size;

	// The validator of the representation the client would actually receive.
	// Precomputed per coding at index time - deriving it here would allocate a
	// string on every request just to compare it.
	const repEtag = encoding === 'br'
		? /** @type {string} */ (entry.brEtag)
		: encoding === 'gzip'
			? /** @type {string} */ (entry.gzEtag)
			: entry.etag;

	// If-Match accepts any representation validator previously issued for this
	// asset. If-None-Match validates the representation selected by this request.
	// If-Match requires an issued tag; If-None-Match uses weak comparison.
	if (ifMatch) {
		if (!listNames(ifMatch, entry.etag) &&
			!(entry.brEtag !== undefined && listNames(ifMatch, entry.brEtag)) &&
			!(entry.gzEtag !== undefined && listNames(ifMatch, entry.gzEtag))) {
			return { status: 412, encoding: '' };
		}
	} else if (ifUnmodifiedSince && entry.mtimeSec !== undefined) {
		const t = ifUnmodifiedSince === entry.lastModified ? entry.mtimeSec * 1000 : parseHttpDate(ifUnmodifiedSince);
		if (!Number.isNaN(t) && entry.mtimeSec * 1000 > t) return { status: 412, encoding: '' };
	}
	if (ifNoneMatch) {
		if (weakEtagListHas(ifNoneMatch, repEtag)) return { status: 304, encoding };
	} else if (ifModifiedSince && entry.mtimeSec !== undefined) {
		const t = ifModifiedSince === entry.lastModified ? entry.mtimeSec * 1000 : parseHttpDate(ifModifiedSince);
		if (!Number.isNaN(t) && entry.mtimeSec * 1000 <= t) return { status: 304, encoding };
	}
	let range = false;
	if (rangeHeader && repEtag && !rangeHeader.includes(',') &&
		(!ifRange || (!ifRange.startsWith('W/') && !repEtag.startsWith('W/') && ifRange === repEtag))) {
		range = parseRange(rangeHeader, repSize);
	}
	if (range === null) {
		// Syntactically valid but the start position is beyond EOF
		return { status: 416, encoding };
	}
	if (range !== false) {
		return { status: 206, encoding, start: range.start, end: range.end };
	}
	return { status: 200, encoding };
}

/** Match a whole validator in the list, or the wildcard for an existing asset. */
function listNames(header, validator) {
	if (header === '*') return true;
	if (!validator) return false;
	let start = 0;
	while (start < header.length) {
		let comma = header.indexOf(',', start);
		if (comma === -1) comma = header.length;
		if (header.slice(start, comma).trim() === validator) return true;
		start = comma + 1;
	}
	return false;
}

/**
 * If-None-Match uses weak comparison: only the quoted opaque tag matters.
 * The common echoed validator avoids list parsing. Walk quoted members on the
 * list path because a different valid opaque tag can itself contain commas.
 * If-Match retains the independent exact-issued-validator policy above.
 * @param {string} header
 * @param {string} tag
 * @returns {boolean}
 */
function weakEtagListHas(header, tag) {
	if (header === '*') return true;
	if (!tag) return false;
	if (header === tag) return true;
	const opaque = tag.startsWith('W/') ? tag.slice(2) : tag;
	if (header === opaque) return true;
	let start = 0;
	while (start < header.length) {
		while (header[start] === ' ' || header[start] === '\t' || header[start] === ',') start++;
		if (header.startsWith('W/', start)) start += 2;
		if (header[start] !== '"') return false;
		const end = header.indexOf('"', start + 1);
		if (end === -1) return false;
		let next = end + 1;
		while (header[next] === ' ' || header[next] === '\t') next++;
		if (next < header.length && header[next] !== ',') return false;
		if (header.slice(start, end + 1) === opaque) return true;
		start = next + 1;
	}
	return false;
}
