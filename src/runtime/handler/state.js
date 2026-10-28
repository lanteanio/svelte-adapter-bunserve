/**
 * Shared runtime state for the HTTP handler graph. Kept in its own module so
 * static-assets.js, ssr.js, lifecycle.js, and server.js share one instance
 * without circular imports.
 */

/**
 * In-memory static file cache: url pathname -> StaticEntry.
 *
 * A StaticEntry is either memory-resident (`buffer` set, plus optional
 * `brBuffer` / `gzBuffer` precompressed variants) or an overflow entry
 * (`file` set to the absolute on-disk path, `size` to its byte length, plus
 * optional `brFile`/`gzFile` on-disk variant paths with their sizes) served
 * through Bun.file's kernel sendfile path instead of heap memory.
 *
 * `headers` holds the identity representation's response headers; `brHeaders`
 * / `gzHeaders` hold each coding's, precomputed at index time (own validator,
 * coding and range support - see variantHeaders). The `*NotModified` lists are the
 * subset a 304 for that representation carries, baked alongside them.
 *
 * @typedef {{
 *   buffer?: Buffer,
 *   brBuffer?: Buffer,
 *   gzBuffer?: Buffer,
 *   file?: string,
 *   size?: number,
 *   brFile?: string,
 *   brSize?: number,
 *   gzFile?: string,
 *   gzSize?: number,
 *   etag: string,
 *   brEtag?: string,
 *   gzEtag?: string,
 *   mtimeSec?: number,
 *   lastModified?: string,
 *   hasBr?: boolean,
 *   hasGz?: boolean,
 *   headers: [string, string][],
 *   brHeaders?: [string, string][],
 *   gzHeaders?: [string, string][],
 *   notModified?: [string, string][],
 *   brNotModified?: [string, string][],
 *   gzNotModified?: [string, string][]
 * }} StaticEntry
 * @type {Map<string, StaticEntry>}
 */
export const staticCache = new Map();

/**
 * Prerendered pages written directory-style (about/index.html): the bare path
 * ("/about") is tracked here so tryPrerendered() can redirect it to the
 * canonical trailing-slash form.
 * @type {Set<string>}
 */
export const prerenderedDirStyle = new Set();

/**
 * Bounded cache for decoded URI pathnames (see static-assets.js decodePath).
 * @type {Map<string, string | null>}
 */
export const decodeCache = new Map();

export const counters = {
	/** SSR renders and streaming responses still producing or awaiting cancellation. */
	inFlightCount: 0,

	/**
	 * True once graceful shutdown has begun; the readiness route reports 503
	 * while this is set.
	 */
	draining: false
};

/** Abort controllers retained until their HTTP response completes. */
export const requestSignals = new Set();
