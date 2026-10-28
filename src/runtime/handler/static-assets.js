import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPath, prerendered, base } from '../manifest-bridge.js';
import { mimeLookup } from '../utils/mime.js';
import { excludedDotPath } from '../utils/dot-path.js';
import { contentDispositionValue, mergeStaticHeaders, resolveStaticCacheControl } from '../utils/static-headers.js';
import { representationEtag } from '../utils/static-negotiate.js';
import { planStaticResponse } from '../utils/static-plan.js';
import { now } from '../runtime.js';
import { resolvePrerendered } from '../utils/prerendered-path.js';
import { staticCache, prerenderedDirStyle, decodeCache } from './state.js';
import { response400 } from './http-helpers.js';

/* global PRECOMPRESS */
/* global STATIC_CACHE_MAX */
/* global STATIC_DOTFILES */

// File extensions that browsers cannot render inline. Serving these with
// Content-Disposition: attachment prompts a download dialog instead of
// showing a blank or error page.
const DOWNLOAD_EXTENSIONS = new Set([
	'.zip', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
	'.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.ipa',
	'.iso', '.img', '.bin'
]);

// Files larger than this stay OUT of the in-memory cache and are served from
// disk through Bun.file (kernel sendfile path). The cache identity - headers,
// ETag, range, 304 - is identical in both lanes; only the body source differs.
const CACHE_MAX_FILE_SIZE = STATIC_CACHE_MAX;

const NON_ASCII = /[^\x00-\x7f]/;

// This module sits one level below the runtime payload root (in handler/), but
// the client/ and prerendered/ asset directories the build emits live at that
// root next to the entry, so resolve up one level from this file's own location.
const __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Recursively walk a directory and call fn for each file.
 * @param {string} dir
 * @param {(relPath: string, absPath: string) => void} fn
 * @param {string} prefix
 */
function walk(dir, fn, prefix = '') {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir)) {
		const rel = prefix ? `${prefix}/${entry}` : entry;
		// Dot-segment paths never enter the index, so the request path has
		// nothing to bypass - the cache simply has no entry, and an encoded
		// traversal decodes to a key that is not there. A refused directory is
		// not descended into either, so an unpacked .git is never even read.
		// `.well-known` stays served; excludedDotPath carries the exact rule,
		// and the build warns about every path this skips.
		if (!STATIC_DOTFILES && excludedDotPath(rel)) continue;
		const abs = path.join(dir, entry);
		if (fs.statSync(abs).isDirectory()) {
			walk(abs, fn, rel);
		} else {
			fn(rel, abs);
		}
	}
}

// Only generated clean-path aliases need ownership metadata. If a real name
// is indexed later, remove its alias and the alias's redirect style together;
// otherwise a decomposed directory could make a real composed file redirect.
/** @type {Map<string, { entry: import('./state.js').StaticEntry, directory: boolean }>} */
const cleanAliases = new Map();

/** @param {string} name */
function removeCleanAlias(name) {
	const previous = cleanAliases.get(name);
	if (previous !== undefined) {
		const key = previous.directory ? name + '/' : name;
		if (staticCache.get(key) === previous.entry) staticCache.delete(key);
		if (previous.directory) prerenderedDirStyle.delete(name);
		cleanAliases.delete(name);
	}
}

/**
 * Register a prerendered page's canonical clean path and optional NFC alias.
 * @param {string} name - bare directory path, or canonical file-style path
 * @param {import('./state.js').StaticEntry} entry
 * @param {boolean} directory
 */
function cacheCleanPath(name, entry, directory) {
	removeCleanAlias(name);
	staticCache.set(directory ? name + '/' : name, entry);
	if (directory) prerenderedDirStyle.add(name);

	const composed = name.normalize('NFC');
	if (composed === name || !NON_ASCII.test(composed) ||
		staticCache.has(composed) || staticCache.has(composed + '/') ||
		prerenderedDirStyle.has(composed)) return;
	staticCache.set(directory ? composed + '/' : composed, entry);
	if (directory) prerenderedDirStyle.add(composed);
	cleanAliases.set(composed, { entry, directory });
}

/**
 * Load a directory into the static cache.
 * @param {string} dir
 * @param {string} urlPrefix
 * @param {boolean} immutable
 * @param {Record<string, string> | null} [staticHeaders] - app-configured
 *   headers merged into every static (and prerendered) response. See
 *   `mergeStaticHeaders`; reserved transfer/caching headers are never
 *   overridden.
 * @param {{ pattern: string, cacheControl: string }[] | null} [staticCacheControl]
 *   prevalidated path-specific cache policies, resolved once per file.
 */
export function cacheDir(dir, urlPrefix, immutable, staticHeaders = null, staticCacheControl = null) {
	const immutablePrefix = `${appPath.slice(base.length)}/immutable/`;
	walk(dir, (relPath, absPath) => {
		if (relPath.endsWith('.br') || relPath.endsWith('.gz')) return;

		const urlPath = `${urlPrefix}/${relPath}`;
		const contentType = mimeLookup(relPath);
		const stat = fs.statSync(absPath);

		/** @type {[string, string][]} */
		const headers = [
			['content-type', contentType],
			['x-content-type-options', 'nosniff'],
			['vary', 'Accept-Encoding'],
			['accept-ranges', 'bytes']
		];
		let etag = '';
		let mtimeSec;
		let lastModified;
		if (immutable && relPath.startsWith(immutablePrefix)) {
			headers.push(['cache-control', 'public, max-age=31536000, immutable']);
		} else {
			etag = `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
			// A future or pre-1900 file time cannot supply an HTTP date. Keep
			// the ETag, but omit Last-Modified and ignore date preconditions.
			if (stat.mtimeMs >= Date.UTC(1900, 0, 1) && stat.mtimeMs <= now()) {
				mtimeSec = Math.floor(stat.mtimeMs / 1000);
				lastModified = new Date(mtimeSec * 1000).toUTCString(); // determinism-allow: formats a held file time
			}
			const policy = resolveStaticCacheControl(relPath, staticCacheControl);
			// uWS writes header strings as UTF-8; Bun Headers requires byte strings.
			const cacheControl = policy ? Buffer.from(policy, 'utf8').toString('latin1') : 'no-cache';
			headers.push(['cache-control', cacheControl], ['etag', etag]);
			if (lastModified !== undefined) headers.push(['last-modified', lastModified]);
		}

		const ext = path.extname(relPath).toLowerCase();
		if (DOWNLOAD_EXTENSIONS.has(ext)) {
			headers.push(['content-disposition', contentDispositionValue(path.basename(relPath))]);
		}

		/** @type {import('./state.js').StaticEntry} */
		let entry;
		if (stat.size > CACHE_MAX_FILE_SIZE) {
			// Overflow lane: the absolute path is fixed at index time - request
			// paths are only ever exact-match Map keys, so no user input can
			// steer a disk read. Precompressed variants stay on disk too and are
			// recorded by path + size so content negotiation works identically
			// in both lanes.
			entry = { file: absPath, size: stat.size, etag, mtimeSec, lastModified, headers: mergeStaticHeaders(headers, staticHeaders) };
			if (PRECOMPRESS) {
				const brPath = absPath + '.br';
				const gzPath = absPath + '.gz';
				if (fs.existsSync(brPath)) {
					const brStat = fs.statSync(brPath);
					if (brStat.size < stat.size) { entry.brFile = brPath; entry.brSize = brStat.size; }
				}
				if (fs.existsSync(gzPath)) {
					const gzStat = fs.statSync(gzPath);
					if (gzStat.size < stat.size) { entry.gzFile = gzPath; entry.gzSize = gzStat.size; }
				}
			}
		} else {
			const buffer = fs.readFileSync(absPath);
			entry = { buffer, etag, mtimeSec, lastModified, headers: mergeStaticHeaders(headers, staticHeaders) };

			if (PRECOMPRESS) {
				const brPath = absPath + '.br';
				const gzPath = absPath + '.gz';
				if (fs.existsSync(brPath)) {
					const brBuf = fs.readFileSync(brPath);
					if (brBuf.byteLength < buffer.byteLength) entry.brBuffer = brBuf;
				}
				if (fs.existsSync(gzPath)) {
					const gzBuf = fs.readFileSync(gzPath);
					if (gzBuf.byteLength < buffer.byteLength) entry.gzBuffer = gzBuf;
				}
			}
		}

		// Bake each available coding's response headers AND validator now, so
		// serving one costs a single Headers construction at request time and
		// a conditional request compares against a string that already exists.
		// `hasBr`/`hasGz` are set here, together with the headers and validator
		// they gate, so negotiation can never select a coding whose response
		// was never baked - one place decides a coding exists.
		entry.notModified = notModifiedHeaders(entry.headers);
		if (entry.brBuffer || entry.brFile) {
			entry.brHeaders = variantHeaders(entry.headers, etag, 'br');
			entry.brNotModified = notModifiedHeaders(entry.brHeaders);
			entry.brEtag = representationEtag(etag, 'br');
			entry.brSize ??= entry.brBuffer.byteLength;
			entry.hasBr = true;
		}
		if (entry.gzBuffer || entry.gzFile) {
			entry.gzHeaders = variantHeaders(entry.headers, etag, 'gzip');
			entry.gzNotModified = notModifiedHeaders(entry.gzHeaders);
			entry.gzEtag = representationEtag(etag, 'gzip');
			entry.gzSize ??= entry.gzBuffer.byteLength;
			entry.hasGz = true;
		}

		removeCleanAlias(urlPath);
		staticCache.set(urlPath, entry);
		// Also under its composed form, as SvelteKit's Node adapter keys its
		// files: a name written decomposed, as some macOS tools write it, is found
		// for the composed spelling a browser sends. Never over a key a file
		// already holds, and a file's own name replaces such an alias, so a name
		// that normalizes onto another file's never shadows it. Only a composed
		// form that is still not ASCII: a target is ASCII, so such an alias is
		// reached through its encoded spelling alone, and a name that composes
		// to plain ASCII (a Kelvin sign) is not served for a target that is not
		// its name.
		const composed = urlPath.normalize('NFC');
		if (composed !== urlPath && NON_ASCII.test(composed) && !staticCache.has(composed)) staticCache.set(composed, entry);

		// Prerendered pages: register clean pathname aliases for the static fast
		// path and tryPrerendered().
		//
		// SvelteKit writes directory-style output (about/index.html) when
		// trailingSlash is 'always', and file-style (about.html) otherwise.
		// builder.prerendered.paths always lists "/about" (no trailing slash).
		//
		// For directory-style pages we register the trailing-slash form in
		// staticCache (served on the fast path) and track the bare path in
		// prerenderedDirStyle so tryPrerendered() can redirect /about -> /about/.
		// For file-style pages we register the bare path (no trailing slash).
		if (!immutable) {
			if (relPath === 'index.html') {
				if (urlPrefix) {
					// Base root with non-empty base: /base/ is canonical
					cacheCleanPath(urlPrefix, entry, true);
				} else {
					// Site root: / is already canonical
					cacheCleanPath('/', entry, false);
				}
			} else if (relPath.endsWith('/index.html')) {
				// Directory-style: trailing slash is canonical
				const cleanPath = `${urlPrefix}/${relPath.slice(0, -'/index.html'.length)}`;
				cacheCleanPath(cleanPath, entry, true);
			} else if (relPath.endsWith('.html')) {
				// File-style: bare path is canonical
				cacheCleanPath(`${urlPrefix}/${relPath.slice(0, -'.html'.length)}`, entry, false);
			}
		}
	});
}

/**
 * Derive the response headers for one content-coding of an asset, once at
 * index time. Each coding is a distinct representation: it carries its own
 * validator, coding, and byte-range coordinates. Precomputing these keeps per-request work to
 * a single Headers construction - the same cost as serving identity.
 *
 * @param {[string, string][]} base - the identity tuples (already merged with staticHeaders)
 * @param {string} etag - identity validator, '' for immutable assets
 * @param {'br' | 'gzip'} encoding
 * @returns {[string, string][]}
 */
function variantHeaders(base, etag, encoding) {
	/** @type {[string, string][]} */
	const out = [];
	for (const [key, value] of base) {
		if (key === 'etag') {
			out.push(['etag', representationEtag(etag, encoding)]);
			continue;
		}
		out.push([key, value]);
	}
	out.push(['content-encoding', encoding]);
	return out;
}

// Bake the representation's policy and cache metadata once per coding.
// Type, encoding and disposition describe a body that a 304 does not carry.
function notModifiedHeaders(base) {
	return base.filter(([key]) => key !== 'content-type' && key !== 'content-encoding' && key !== 'content-disposition');
}

export const clientDir = path.join(__dirname, 'client');

export const prerenderedDir = path.join(__dirname, 'prerendered');

// Built once: every member is a stable module-level table, so the prerendered
// lookup allocates nothing per request.
const prerenderedTables = {
	prerendered,
	dirStyle: prerenderedDirStyle,
	hasEntry: (p) => staticCache.has(p)
};

/**
 * Build the response Headers for the representation being served, from the
 * tuples precomputed for that coding at index time (see variantHeaders).
 *
 * @param {import('./state.js').StaticEntry} entry
 * @param {'' | 'br' | 'gzip'} encoding
 * @returns {Headers}
 */
function entryHeaders(entry, encoding) {
	if (encoding === 'br') return new Headers(/** @type {[string, string][]} */ (entry.brHeaders));
	if (encoding === 'gzip') return new Headers(/** @type {[string, string][]} */ (entry.gzHeaders));
	return new Headers(entry.headers);
}

/**
 * Serve a static cache entry as a Response. Pure request/header logic - the
 * caller (server.js fetch dispatch) hands the Request headers in, and Bun
 * transmits whatever Response comes back (Content-Length and Date are set by
 * the server from the body and clock).
 *
 * @param {import('./state.js').StaticEntry} entry
 * @param {Headers} requestHeaders
 * @param {boolean} headOnly
 * @returns {Response}
 */
export function serveStatic(entry, requestHeaders, headOnly = false) {
	const size = entry.buffer ? entry.buffer.byteLength : /** @type {number} */ (entry.size);

	const plan = planStaticResponse(
		entry,
		size,
		requestHeaders.get('range') || '',
		requestHeaders.get('if-range') || '',
		requestHeaders.get('if-none-match') || '',
		requestHeaders.get('accept-encoding') || '',
		requestHeaders.get('if-match') || '',
		requestHeaders.get('if-unmodified-since') || '',
		requestHeaders.get('if-modified-since') || ''
	);

	if (plan.status === 304) {
		// The baked tuple list for the representation this request selected, so
		// the validator the client is told to keep is the one it holds.
		const headers = plan.encoding === 'br'
			? entry.brNotModified
			: plan.encoding === 'gzip'
				? entry.gzNotModified
				: entry.notModified;
		return new Response(null, { status: 304, headers });
	}

	if (plan.status === 412) {
		return new Response(null, { status: 412 });
	}

	const repSize = plan.encoding === 'br' ? entry.brSize : plan.encoding === 'gzip' ? entry.gzSize : size;
	if (plan.status === 416) {
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${repSize}` }
		});
	}

	if (plan.status === 206) {
		const headers = entryHeaders(entry, plan.encoding);
		headers.set('content-range', `bytes ${plan.start}-${plan.end}/${repSize}`);
		const length = plan.end - plan.start + 1;
		if (headOnly) {
			headers.set('content-length', String(length));
			return new Response(null, { status: 206, headers });
		}
		const buffer = plan.encoding === 'br' ? entry.brBuffer : plan.encoding === 'gzip' ? entry.gzBuffer : entry.buffer;
		const file = plan.encoding === 'br' ? entry.brFile : plan.encoding === 'gzip' ? entry.gzFile : entry.file;
		const body = buffer ? buffer.subarray(plan.start, plan.end + 1)
			: Bun.file(file).slice(plan.start, plan.end + 1);
		return new Response(body, { status: 206, headers });
	}

	const encoding = plan.encoding;
	const headers = entryHeaders(entry, encoding);

	if (entry.buffer) {
		let body = entry.buffer;
		if (encoding === 'br') body = /** @type {Buffer} */ (entry.brBuffer);
		else if (encoding === 'gzip') body = /** @type {Buffer} */ (entry.gzBuffer);
		if (headOnly) {
			headers.set('content-length', String(body.byteLength));
			return new Response(null, { status: 200, headers });
		}
		return new Response(body, { status: 200, headers });
	}

	// Overflow lane: bytes from disk via Bun.file (kernel sendfile), with the
	// same representation selection as the memory lane.
	let file = /** @type {string} */ (entry.file);
	let fileSize = size;
	if (encoding === 'br') {
		file = /** @type {string} */ (entry.brFile);
		fileSize = /** @type {number} */ (entry.brSize);
	} else if (encoding === 'gzip') {
		file = /** @type {string} */ (entry.gzFile);
		fileSize = /** @type {number} */ (entry.gzSize);
	}
	if (headOnly) {
		headers.set('content-length', String(fileSize));
		return new Response(null, { status: 200, headers });
	}
	return new Response(Bun.file(file), { status: 200, headers });
}

// Bounded cache for decoded URI pathnames. Avoids repeated decodeURIComponent
// calls for the same encoded path. Evicts in INSERTION order, not use order: a
// hit returns without touching the entry's position, so a hot path inserted
// early is evicted ahead of a cold one inserted late. Keeping use order would
// cost a delete and a re-insert on every hit, which is the wrong trade for a
// cache this size whose miss costs one decodeURIComponent.
export const DECODE_CACHE_MAX = 256;

/**
 * Decode a URI-encoded pathname, returning a cached result when available.
 * Returns null if the pathname is malformed (invalid percent-encoding).
 * @param {string} pathname
 * @returns {string | null}
 */
function decodePath(pathname) {
	if (!pathname.includes('%')) return pathname;
	let result = decodeCache.get(pathname);
	if (result !== undefined) return result;
	try {
		result = decodeURIComponent(pathname);
	} catch {
		result = null;
	}
	if (decodeCache.size >= DECODE_CACHE_MAX) {
		decodeCache.delete(decodeCache.keys().next().value);
	}
	decodeCache.set(pathname, result);
	return result;
}

/**
 * Try to serve a prerendered page (or its canonical-form redirect).
 * Returns a Response when the path is prerendered (or malformed), null when
 * the request should continue to SSR.
 *
 * @param {string} pathname
 * @param {string} search - '' or '?...'
 * @param {Headers} requestHeaders
 * @param {boolean} headOnly
 * @returns {Response | null}
 */
export function tryPrerendered(pathname, search, requestHeaders, headOnly = false) {
	const decoded = decodePath(pathname);
	if (decoded === null) {
		return response400();
	}

	const decision = resolvePrerendered(decoded, search, prerenderedTables);

	if (decision.kind === 'redirect') {
		return new Response(null, {
			status: 308,
			headers: { location: decision.location }
		});
	}
	if (decision.kind === 'serve') {
		return serveStatic(
			/** @type {import('./state.js').StaticEntry} */ (staticCache.get(decision.path)),
			requestHeaders,
			headOnly
		);
	}
	return null;
}

/**
 * The static file a percent-encoded target names, for a file whose name a
 * browser encodes - a space, a non-ASCII letter. The fast path matches the
 * target as sent against the file's own name, and on Bun the target always
 * arrives encoded: Bun re-escapes raw bytes before the handler sees them.
 *
 * Decoded with `decodeURI`, as SvelteKit's Node adapter decodes before its own
 * file lookup, so an encoded `/` does not reach into a directory the path did
 * not name.
 *
 * @param {string} pathname a target carrying a `%`
 * @returns {import('./state.js').StaticEntry | undefined}
 */
export function encodedStaticEntry(pathname) {
	let name;
	try {
		name = decodeURI(pathname);
	} catch {
		return undefined;
	}
	return name === pathname ? undefined : staticCache.get(name);
}
