/**
 * Content negotiation and representation identity for static assets.
 *
 * Dependency-free so it is unit-testable without the runtime init chain: this
 * is the logic a conditional request and a resumed download both depend on,
 * and getting it wrong corrupts files rather than merely slowing them down.
 */

/**
 * Pick the content-coding to serve. Brotli wins over gzip when both are
 * available and acceptable; identity is the fallback.
 *
 * @param {string} acceptEncoding - raw Accept-Encoding header value
 * @param {{ hasBr: boolean, hasGz: boolean }} available - which precompressed
 *   variants exist for this asset
 * @returns {'' | 'br' | 'gzip'} '' means identity
 */
export function negotiateEncoding(acceptEncoding, available) {
	if (!acceptEncoding) return '';
	if (available.hasBr && acceptEncoding.includes('br')) return 'br';
	if (available.hasGz && acceptEncoding.includes('gzip')) return 'gzip';
	return '';
}

/**
 * The validator for a specific representation of an asset.
 *
 * A content-coding produces a DISTINCT representation, and RFC 7232 requires
 * distinct representations to carry distinct validators. Sharing the identity
 * ETag across codings is what lets a client resume a compressed download with
 * a byte Range and receive identity bytes at offsets it computed against the
 * compressed stream - a silently corrupt file. Suffixing the coding onto the
 * entity-tag keeps each representation independently cacheable and makes a
 * cross-representation If-Range mismatch, which is the safe outcome.
 *
 * @param {string} baseEtag - the identity ETag (may be '' for immutable assets)
 * @param {'' | 'br' | 'gzip'} encoding
 * @returns {string}
 */
export function representationEtag(baseEtag, encoding) {
	if (!baseEtag || !encoding) return baseEtag;
	const end = baseEtag.lastIndexOf('"');
	if (end <= 0) return baseEtag;
	return baseEtag.slice(0, end) + '-' + encoding + baseEtag.slice(end);
}
