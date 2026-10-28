/**
 * Header names the static file handler manages itself, which `staticHeaders`
 * must not override. These are written per-response by serveStatic
 * (`content-type`, `content-encoding`, `content-range`), set by the server
 * from the body (`content-length`, `date`), a conditional-request validator
 * (`etag`, `last-modified` - both drive 304/412 evaluation, so an app-chosen
 * value would make the preconditions answer for a date the file does not
 * have), or correctness-sensitive caching/negotiation headers whose value
 * depends on the specific asset (`cache-control` differs for immutable vs
 * mutable assets; `vary` must keep `Accept-Encoding` so compressed variants
 * cache correctly; `accept-ranges` advertises the range support the handler
 * actually implements). `staticHeaders` may ADD any other header - CSP, HSTS,
 * X-Frame-Options, Referrer-Policy, Permissions-Policy, custom `x-*` headers -
 * and may override the adapter's own default `x-content-type-options`.
 * @type {Set<string>}
 */
export const RESERVED_STATIC_HEADER_KEYS = new Set([
	'content-type',
	'content-encoding',
	'content-range',
	'content-length',
	'date',
	'etag',
	'last-modified',
	'vary',
	'cache-control',
	'accept-ranges'
]);

/**
 * The `content-disposition` value for a downloadable asset, with the filename
 * made safe for the quoted-string it is going into, as svelte-adapter-uws
 * builds it.
 *
 * The quote and the backslash would end or escape that quoted-string. The
 * control characters matter more: a filename is legal on POSIX with a newline
 * in it, and a newline written into a header ends the field on the wire - the
 * rest of the name then lands as further headers, or, after a blank line, as a
 * second response body.
 *
 * Handed over as its UTF-8 bytes, one character each. Bun's Headers take a
 * value as bytes and refuse a character above 0xFF, so a name with a Polish
 * L-stroke (U+0141) in it would fail the response, and one inside Latin-1
 * would go out as its single Latin-1 byte; as UTF-8 bytes both go out as uWS
 * writes them for svelte-adapter-uws.
 *
 * @param {string} basename
 * @returns {string}
 */
export function contentDispositionValue(basename) {
	const value = `attachment; filename="${basename.replace(/[\x00-\x1f\x7f"\\]/g, '')}"`;
	return Buffer.from(value, 'utf8').toString('latin1');
}

/**
 * Merge user-configured static response headers into a static entry's
 * precomputed header tuples. Runs once per file at index time (not per
 * request), so the per-request serveStatic path is unchanged.
 *
 * User keys are lowercased; reserved keys (see `RESERVED_STATIC_HEADER_KEYS`)
 * are skipped so they can never break transfer / caching / conditional-request
 * correctness. A non-reserved key that already exists in the base tuples (e.g.
 * the default `x-content-type-options`) is replaced in place - user intent wins
 * - and a new key is appended. Returns a new array; the input is not mutated.
 *
 * @param {[string, string][]} baseHeaders - precomputed entry header tuples (lowercased keys)
 * @param {Record<string, string> | null | undefined} staticHeaders
 * @returns {[string, string][]}
 */
export function mergeStaticHeaders(baseHeaders, staticHeaders) {
	if (!staticHeaders) return baseHeaders;
	/** @type {[string, string][]} */
	const merged = baseHeaders.map((t) => [t[0], t[1]]);
	for (const rawKey of Object.keys(staticHeaders)) {
		const key = rawKey.toLowerCase();
		if (RESERVED_STATIC_HEADER_KEYS.has(key)) continue;
		const value = String(staticHeaders[rawKey]);
		const idx = merged.findIndex((t) => t[0] === key);
		if (idx >= 0) merged[idx][1] = value;
		else merged.push([key, value]);
	}
	return merged;
}

/**
 * Resolve a prevalidated custom Cache-Control value for one build output path.
 * Paths are relative to the configured SvelteKit base. A trailing slash is a
 * directory-tree selector; any other pattern is an exact asset selector.
 *
 * @param {string} relPath - slash-separated path relative to the indexed directory
 * @param {{ pattern: string, cacheControl: string }[] | null | undefined} rules
 * @returns {string}
 */
export function resolveStaticCacheControl(relPath, rules) {
	if (!rules?.length) return '';
	const assetPath = relPath[0] === '/' ? relPath : `/${relPath}`;
	let best = '';
	let bestLength = -1;
	for (let index = 0; index < rules.length; index++) {
		const { pattern, cacheControl } = rules[index];
		const matches = pattern.endsWith('/')
			? assetPath.startsWith(pattern)
			: assetPath === pattern;
		if (matches && pattern.length > bestLength) {
			best = cacheControl;
			bestLength = pattern.length;
		}
	}
	return best;
}
