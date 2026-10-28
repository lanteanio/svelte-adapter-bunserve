// The paths the adapter answers ahead of the app's routes, judged on the
// spellings that would reach the app's router as one of them.
//
// svelte-adapter-uws routes its exact mounts - the probes, the auth path, the
// WebSocket path where an admission limit answers its GETs - on the target as
// sent, so a target that SvelteKit's router would read as one of them without
// spelling it would reach the app as that path, and it refuses such a target
// with 400. This is that adapter's reading, carried across with the mount set
// passed in rather than kept beside a route table.
//
// On Bun it meets fewer spellings: Bun has resolved dot segments, encoded
// ones included, and turned backslashes into slashes in `req.url` before the
// handler runs (probe/bun-api-facts.report.md, request-target), so
// `/x/../healthz` arrives as `/healthz` and is that path for every lane and
// method - the probe's GET, the app's POST, the auth endpoint, a handshake.
// What is left to judge is an escape and SvelteKit's own suffixes:
// `/%68ealthz`, `/healthz/__data.json`, `/readyz/__route.js`.

/**
 * The paths answered ahead of the app's routes, as exact strings: the probes
 * that are on, the auth path when the handler mounts it, and the WebSocket
 * path while an admission limit makes its GETs the adapter's. Without a limit
 * those GETs go on to the app, and so do the path's pages, their data and its
 * other spellings, as on svelte-adapter-uws.
 *
 * @param {{ healthPath: string | false, readinessPath: string | false, authPath: string | null, wsPath: string | null }} paths
 *   `authPath` only when mounted, `wsPath` only under an admission limit
 * @returns {Set<string>}
 */
export function ownExactMounts({ healthPath, readinessPath, authPath, wsPath }) {
	const mounts = new Set();
	if (healthPath) mounts.add(healthPath);
	if (readinessPath) mounts.add(readinessPath);
	if (authPath) mounts.add(authPath);
	if (wsPath) mounts.add(wsPath);
	return mounts;
}

/**
 * An escape of an ASCII character. A target reaches the handler in visible
 * ASCII, every other byte re-escaped by Bun, so a mount is reached through its
 * ASCII letters alone, and decoding only these reads every escape that could
 * spell one. Nor can it throw, as a decoder for the whole of UTF-8 does on an
 * escape it cannot read.
 */
const ASCII_ESCAPE = /%([0-7][0-9a-f])/gi;
/** @param {string} _ @param {string} hex */
const asciiFromEscape = (_, hex) => String.fromCharCode(parseInt(hex, 16));

/**
 * The page path SvelteKit answers `path` for. A route-resolution request
 * (`/__route.js`) and a data request (`/__data.json`, `.html__data.json`) are
 * answered for the page in front of the suffix, and a data request for a page
 * spelled with a trailing slash carries that slash in a query parameter,
 * read here as SvelteKit reads it - parsed only when a mount is at stake.
 *
 * `/healthz/` is left to the application, and its data with it. It is not a
 * spelling of the mount: SvelteKit's router matches it to the same route as
 * `/healthz`, and whether it redirects the page, serves it or both is the
 * application's `trailingSlash`, which this cannot see. Refusing it would break
 * a page an app serves there on purpose.
 *
 * @param {Set<string>} mounts
 * @param {string} path
 * @param {string | undefined} query the query without its `?`
 */
function kitPagePath(mounts, path, query) {
	if (path.endsWith('/__route.js')) return path.slice(0, -11) || '/';
	let page;
	if (path.endsWith('/__data.json')) page = path.slice(0, -12);
	else if (path.endsWith('.html__data.json')) page = path.slice(0, -16) + '.html';
	else return path;
	// Parsed behind a `?` of its own: the constructor drops one leading `?`, and
	// a query that itself begins with one (`??name=1`) keeps it in the first
	// name, as the request URL SvelteKit parses does.
	if (query && (mounts.has(page + '/') || mounts.has(page || '/')) &&
		new URLSearchParams('?' + query).get('x-sveltekit-trailing-slash') === '1') page += '/';
	return page || '/';
}

/**
 * Whether `path`, read as SvelteKit's router reads it, is an exact mount that
 * the target `raw` does not spell.
 *
 * @param {Set<string>} mounts
 * @param {string} path the target, or a decoded reading of it
 * @param {string} raw the target
 * @param {string | undefined} query the query without its `?`
 */
export function entersExactMount(mounts, path, raw, query) {
	const page = kitPagePath(mounts, path, query);
	return page !== raw && mounts.has(page);
}

/**
 * Whether a request on `pathname` must be refused because it reads as one of
 * `mounts` it does not spell, as svelte-adapter-uws reads it: as a data or
 * route-resolution request for it, or through an escape of an ASCII
 * character. That reading is wider than SvelteKit's router in places - it
 * decodes an escaped `/` and an escaped suffix, which the router leaves alone -
 * and is kept wide to answer as that adapter does.
 *
 * @param {Set<string>} mounts
 * @param {string} pathname the path as Bun hands it on
 * @param {string} search the query with its `?`, or ''
 */
export function shadowsExactMount(mounts, pathname, search) {
	if (mounts.size === 0) return false;
	const query = search === '' ? undefined : search.slice(1);
	if (entersExactMount(mounts, pathname, pathname, query)) return true;
	return pathname.includes('%') &&
		entersExactMount(mounts, pathname.replace(ASCII_ESCAPE, asciiFromEscape), pathname, query);
}
