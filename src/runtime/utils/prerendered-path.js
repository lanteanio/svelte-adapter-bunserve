/**
 * Canonical-form resolution for prerendered pages.
 *
 * SvelteKit writes directory-style output (about/index.html) when
 * trailingSlash is 'always', and file-style (about.html) otherwise, while
 * `builder.prerendered.paths` always lists the bare "/about". Which form is
 * canonical therefore depends on how the page was written, and the wrong
 * answer is a redirect loop or a 404 on a page that exists.
 *
 * Dependency-free so the decision table is unit-testable: the caller injects
 * the tables and a cache-presence predicate, and performs the IO itself.
 */

/**
 * @typedef {{ kind: 'serve', path: string }
 *   | { kind: 'redirect', location: string }
 *   | { kind: 'miss' }} PrerenderedDecision
 */

/**
 * @param {string} decoded - decoded request pathname
 * @param {string} search - '' or '?...'
 * @param {{
 *   prerendered: { has(p: string): boolean },
 *   dirStyle: { has(p: string): boolean },
 *   hasEntry: (p: string) => boolean
 * }} tables
 * @returns {PrerenderedDecision}
 */
export function resolvePrerendered(decoded, search, tables) {
	const { prerendered, dirStyle, hasEntry } = tables;

	if (prerendered.has(decoded)) {
		// Directory-style page: the bare path is not canonical
		if (dirStyle.has(decoded)) {
			return { kind: 'redirect', location: decoded + '/' + search };
		}
		if (hasEntry(decoded)) {
			return { kind: 'serve', path: decoded };
		}
		// Listed as prerendered but absent from the cache - try the alternate
		// form rather than claiming the request
	}

	const alt = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded + '/';
	if (prerendered.has(alt)) {
		// Request carries a trailing slash and the prerendered path does not:
		// for a directory-style page the trailing-slash form IS canonical, so
		// serve it instead of redirecting
		if (dirStyle.has(alt) && decoded.endsWith('/')) {
			if (hasEntry(decoded)) return { kind: 'serve', path: decoded };
			// Canonical form, but nothing cached under it. Redirecting to the
			// bare path would bounce straight back here (the bare path of a
			// directory-style page redirects to the trailing-slash form), so
			// decline the request and let it 404 through SSR instead of
			// looping the client.
			return { kind: 'miss' };
		}
		return { kind: 'redirect', location: alt + search };
	}

	return { kind: 'miss' };
}
