import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, prerendered } from '../manifest-bridge.js';
import { mimeLookup } from '../utils/mime.js';
import { excludedDotPath } from '../utils/dot-path.js';
import { mergeStaticHeaders } from '../utils/static-headers.js';
import { representationEtag } from '../utils/static-negotiate.js';
import { planStaticResponse } from '../utils/static-plan.js';
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

/**
 * Load a directory into the static cache.
 * @param {string} dir
 * @param {string} urlPrefix
 * @param {boolean} immutable
 * @param {Record<string, string> | null} [staticHeaders] - app-configured
 *   headers merged into every static (and prerendered) response. See
 *   `mergeStaticHeaders`; reserved transfer/caching headers are never
 *   overridden.
 */
export function cacheDir(dir, urlPrefix, immutable, staticHeaders = null) {
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
		if (immutable && relPath.startsWith(`${manifest.appPath}/immutable/`)) {
			headers.push(['cache-control', 'public, max-age=31536000, immutable']);
		} else {
			etag = `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
			// Last-Modified rides beside the ETag, at the whole-second
			// precision HTTP dates carry: a cache that lost the ETag
			// revalidates by date, and without this header it re-downloads the
			// full body on every visit. Immutable assets skip it for the same
			// reason they skip the ETag - the versioned filename IS the
			// validator.
			mtimeSec = Math.floor(stat.mtimeMs / 1000);
			headers.push(
				['cache-control', 'no-cache'],
				['etag', etag],
				['last-modified', new Date(mtimeSec * 1000).toUTCString()] // determinism-allow: renders the file's own mtime, an input read from disk at index time - no clock is consulted
			);
		}

		const ext = path.extname(relPath).toLowerCase();
		if (DOWNLOAD_EXTENSIONS.has(ext)) {
			const basename = path.basename(relPath);
			// Strip characters that are not allowed in a quoted Content-Disposition filename.
			const safe = basename.replace(/["\\]/g, '');
			headers.push(['content-disposition', `attachment; filename="${safe}"`]);
		}

		/** @type {import('./state.js').StaticEntry} */
		let entry;
		if (stat.size > CACHE_MAX_FILE_SIZE) {
			// Overflow lane: the absolute path is fixed at index time - request
			// paths are only ever exact-match Map keys, so no user input can
			// steer a disk read. Precompressed variants stay on disk too and are
			// recorded by path + size so content negotiation works identically
			// in both lanes.
			entry = { file: absPath, size: stat.size, etag, mtimeSec, headers: mergeStaticHeaders(headers, staticHeaders) };
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
			entry = { buffer, etag, mtimeSec, headers: mergeStaticHeaders(headers, staticHeaders) };

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
		if (entry.brBuffer || entry.brFile) {
			entry.brHeaders = variantHeaders(entry.headers, etag, 'br');
			entry.brEtag = representationEtag(etag, 'br');
			entry.hasBr = true;
		}
		if (entry.gzBuffer || entry.gzFile) {
			entry.gzHeaders = variantHeaders(entry.headers, etag, 'gzip');
			entry.gzEtag = representationEtag(etag, 'gzip');
			entry.hasGz = true;
		}

		staticCache.set(urlPath, entry);

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
					staticCache.set(urlPrefix + '/', entry);
					prerenderedDirStyle.add(urlPrefix);
				} else {
					// Site root: / is already canonical
					staticCache.set('/', entry);
				}
			} else if (relPath.endsWith('/index.html')) {
				// Directory-style: trailing slash is canonical
				const cleanPath = `${urlPrefix}/${relPath.slice(0, -'/index.html'.length)}`;
				staticCache.set(cleanPath + '/', entry);
				prerenderedDirStyle.add(cleanPath);
			} else if (relPath.endsWith('.html')) {
				// File-style: bare path is canonical
				staticCache.set(`${urlPrefix}/${relPath.slice(0, -'.html'.length)}`, entry);
			}
		}
	});
}

/**
 * Derive the response headers for one content-coding of an asset, once at
 * index time. Each coding is a distinct representation: it carries its own
 * validator, and it does not advertise byte ranges (ranges are served from the
 * identity representation only). Precomputing these keeps per-request work to
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
		if (key === 'accept-ranges') continue;
		if (key === 'etag') {
			out.push(['etag', representationEtag(etag, encoding)]);
			continue;
		}
		out.push([key, value]);
	}
	out.push(['content-encoding', encoding]);
	return out;
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
		return new Response(null, { status: 304 });
	}

	if (plan.status === 412) {
		return new Response(null, { status: 412 });
	}

	if (plan.status === 416) {
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${size}` }
		});
	}

	if (plan.status === 206) {
		const headers = entryHeaders(entry, '');
		headers.set('content-range', `bytes ${plan.start}-${plan.end}/${size}`);
		const length = plan.end - plan.start + 1;
		if (headOnly) {
			headers.set('content-length', String(length));
			return new Response(null, { status: 206, headers });
		}
		const body = entry.buffer
			? entry.buffer.subarray(plan.start, plan.end + 1)
			: Bun.file(/** @type {string} */ (entry.file)).slice(plan.start, plan.end + 1);
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
