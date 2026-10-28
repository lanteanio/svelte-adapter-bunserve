/**
 * Select the highest accepted coding weight, preferring brotli on ties.
 * Weightless browser headers take a delimiter-checked fast path. Duplicate
 * lowercase weightless tokens take that fast path even after another casing.
 * Identity is the fallback when no available coding is accepted.
 * @param {string} header
 * @param {boolean} hasBr
 * @param {boolean} hasGz
 * @returns {'br' | 'gzip' | ''}
 */
export function negotiateEncoding(header, hasBr, hasGz) {
	if (header.length === 0 || (!hasBr && !hasGz)) return '';
	if (header === 'br') return hasBr ? 'br' : '';
	if (header === 'gzip') return hasGz ? 'gzip' : '';
	if (hasBr) {
		if (header === 'gzip, deflate, br' || header === 'gzip, deflate, br, zstd') return 'br';
		if (listedWeightless(header, 'br')) return 'br';
	} else if (listedWeightless(header, 'gzip')) {
		// Without a brotli representation, gzip is the top preference.
		return 'gzip';
	}
	return negotiateWeighted(header, hasBr, hasGz);
}

/**
 * Whether the first occurrence of `token` in `header` is a whole list element
 * with no parameter: preceded by the start or a comma and followed by the end
 * or a comma, optional whitespace on either side. The search is
 * case-sensitive, and a header in which the spelling first appears inside
 * another token, or with a weight, is left to the full pass.
 *
 * @param {string} header
 * @param {string} token
 * @returns {boolean}
 */
function listedWeightless(header, token) {
	const at = header.indexOf(token);
	if (at === -1) return false;
	let i = at - 1;
	while (i >= 0 && (header.charCodeAt(i) === 0x20 || header.charCodeAt(i) === 0x09)) i--;
	if (i >= 0 && header.charCodeAt(i) !== 0x2c) return false;
	i = at + token.length;
	const len = header.length;
	while (i < len && (header.charCodeAt(i) === 0x20 || header.charCodeAt(i) === 0x09)) i++;
	return i === len || header.charCodeAt(i) === 0x2c;
}

/**
 * The full decision: one pass over every element and its parameters.
 *
 * @param {string} header
 * @param {boolean} hasBr
 * @param {boolean} hasGz
 * @returns {'br' | 'gzip' | ''}
 */
function negotiateWeighted(header, hasBr, hasGz) {
	const len = header.length;
	let qBr = -1;
	let qGz = -1;
	let qStar = -1;
	let i = 0;
	while (i < len) {
		let c = header.charCodeAt(i);
		// OWS and empty list elements between commas
		if (c === 0x20 || c === 0x09 || c === 0x2c) { i++; continue; }
		const start = i;
		while (i < len) {
			c = header.charCodeAt(i);
			if (c === 0x2c || c === 0x3b || c === 0x20 || c === 0x09) break;
			i++;
		}
		const tokenLen = i - start;
		// 1 = br, 2 = gzip, 3 = *, 0 = a coding this lane does not serve
		let kind = 0;
		if (tokenLen === 2) {
			if ((header.charCodeAt(start) | 0x20) === 0x62 && (header.charCodeAt(start + 1) | 0x20) === 0x72) kind = 1;
		} else if (tokenLen === 4) {
			if ((header.charCodeAt(start) | 0x20) === 0x67 && (header.charCodeAt(start + 1) | 0x20) === 0x7a &&
				(header.charCodeAt(start + 2) | 0x20) === 0x69 && (header.charCodeAt(start + 3) | 0x20) === 0x70) kind = 2;
		} else if (tokenLen === 1 && header.charCodeAt(start) === 0x2a) {
			kind = 3;
		}
		// Parameters up to the next comma. Only `q` is read; anything else is
		// skipped. A weight that does not parse leaves the default.
		let q = 1000;
		while (i < len && header.charCodeAt(i) !== 0x2c) {
			c = header.charCodeAt(i);
			if (c === 0x3b) {
				i++;
				while (i < len && ((c = header.charCodeAt(i)) === 0x20 || c === 0x09)) i++;
				if (i + 1 < len && (header.charCodeAt(i) | 0x20) === 0x71 && header.charCodeAt(i + 1) === 0x3d) {
					const parsed = parseWeight(header, i + 2, len);
					if (parsed >= 0) q = parsed;
				}
				continue;
			}
			i++;
		}
		if (kind === 1) { if (qBr === -1) qBr = q; }
		else if (kind === 2) { if (qGz === -1) qGz = q; }
		else if (kind === 3) { if (qStar === -1) qStar = q; }
	}
	const br = hasBr ? (qBr >= 0 ? qBr : (qStar >= 0 ? qStar : 0)) : 0;
	const gz = hasGz ? (qGz >= 0 ? qGz : (qStar >= 0 ? qStar : 0)) : 0;
	if (br > 0 && br >= gz) return 'br';
	if (gz > 0) return 'gzip';
	return '';
}

/**
 * A qvalue (RFC 9110 12.4.2) in thousandths, or -1 when the text at `i` is not
 * one: `0` or `1`, optionally a dot and up to three digits, ended by OWS, `;`,
 * `,` or the end of the header. A value above 1 is not a qvalue.
 *
 * @param {string} header
 * @param {number} i
 * @param {number} len
 * @returns {number}
 */
function parseWeight(header, i, len) {
	if (i >= len) return -1;
	const lead = header.charCodeAt(i);
	if (lead !== 0x30 && lead !== 0x31) return -1;
	let value = (lead - 0x30) * 1000;
	i++;
	if (i < len && header.charCodeAt(i) === 0x2e) {
		i++;
		let scale = 100;
		let digits = 0;
		while (i < len && digits < 3) {
			const d = header.charCodeAt(i);
			if (d < 0x30 || d > 0x39) break;
			value += (d - 0x30) * scale;
			scale /= 10;
			digits++;
			i++;
		}
	}
	if (i < len) {
		const after = header.charCodeAt(i);
		if (after !== 0x20 && after !== 0x09 && after !== 0x3b && after !== 0x2c) return -1;
	}
	return value > 1000 ? -1 : value;
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
