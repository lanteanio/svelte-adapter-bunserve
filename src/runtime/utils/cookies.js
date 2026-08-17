// The cookie jar the auth preflight hook is handed: read what the request
// carried, and accumulate the `Set-Cookie` lines the adapter writes onto the
// response.
//
// This exists because a session cookie cannot reliably be refreshed on a
// WebSocket handshake. A `Set-Cookie` on the 101 is silently dropped by
// Cloudflare Tunnel and other strict edge proxies, so the family refreshes it on
// an ordinary HTTP POST before the socket opens - and that POST needs the same
// `get` / `set` / `delete` an app already knows from SvelteKit's `cookies`.
//
// Mirrors svelte-adapter-uws's module of the same name, for the reason
// `rate-limiter.js` gives about its own port: an app's `authenticate` hook is
// the same code on both adapters, so the cookie it sets has to reach the browser
// with the same attributes from both. Serialization is also the wrong place to
// be inventive - the character classes below are each keeping a specific
// injection out, and a copy written from the shape would reproduce the shape and
// miss one.
//
// Pure: no clock, no globals, no runtime imports.

/**
 * Parse a `Cookie` header into a name/value bag.
 *
 * NULL-PROTOTYPE, deliberately. A request carrying `__proto__=evil` would
 * otherwise write through the inherited setter of an ordinary `{}` and every
 * later `cookies.get('toString')` in the process could read an attacker's
 * value. A bag with no prototype chain closes that at the parse boundary rather
 * than asking every reader to remember.
 *
 * @param {string | null | undefined} cookieHeader
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
	/** @type {Record<string, string>} */
	const cookies = Object.create(null);
	if (!cookieHeader) return cookies;
	for (const pair of cookieHeader.split(';')) {
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		const value = pair.substring(eq + 1).trim();
		// RFC 6265 permits a quoted value; the quotes are syntax, not content.
		const unquoted = value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"'
			? value.slice(1, -1)
			: value;
		const name = pair.substring(0, eq).trim();
		try {
			cookies[name] = decodeURIComponent(unquoted);
		} catch {
			// A value that is not valid percent-encoding is kept verbatim rather
			// than dropped: `decodeURIComponent` throws on a lone `%`, and a
			// cookie some other service wrote is not this adapter's to discard.
			cookies[name] = unquoted;
		}
	}
	return cookies;
}

/**
 * A cookie NAME may not carry a separator or a control character: RFC 6265
 * defines it as a token, and anything outside that either ends the name early
 * for some parser or splits the header for another.
 */
const COOKIE_NAME_INVALID = /[\s"(),/:;<=>?@[\\\]{}\x00-\x1f\x7f]/;

/**
 * A cookie VALUE may not carry CTLs (CR/LF is response splitting), `;` (ends
 * the value and starts an attribute), `,` (some parsers split `Set-Cookie` on
 * it), whitespace, or DEL.
 */
const COOKIE_VALUE_INVALID = /[,;\s\x00-\x1f\x7f]/;

/**
 * `Path` and `Domain` share the value class for the same reasons, and reach it
 * from app code that may have built them out of client input.
 */
const COOKIE_ATTR_INVALID = /[,;\s\x00-\x1f\x7f]/;

const VALID_SAMESITE = new Set(['strict', 'lax', 'none']);

/**
 * @typedef {object} CookieSerializeOptions
 * @property {string} [path]
 * @property {string} [domain]
 * @property {Date} [expires]
 * @property {number} [maxAge] seconds
 * @property {boolean} [httpOnly]
 * @property {boolean} [secure]
 * @property {boolean} [partitioned]
 * @property {'strict' | 'lax' | 'none' | boolean} [sameSite]
 * @property {boolean} [encode] default true; `false` writes the value as given
 */

/**
 * Serialize one name/value/options triple into a `Set-Cookie` line.
 *
 * `path` is optional HERE and required by `createCookies`: this is the
 * attribute serializer, and the required-path contract belongs to the API an
 * app calls.
 *
 * Throws rather than dropping an offending attribute. A cookie that silently
 * loses its `Secure` or its `Path` is a scope change the app never asked for,
 * and the caller is the only party that can decide what to do about it.
 *
 * @param {string} name
 * @param {string} value
 * @param {CookieSerializeOptions} [options]
 * @returns {string}
 */
export function serializeCookie(name, value, options = {}) {
	if (typeof name !== 'string' || name.length === 0 || COOKIE_NAME_INVALID.test(name)) {
		throw new Error(`Invalid cookie name: '${name}'`);
	}
	const encoded = options.encode === false ? value : encodeURIComponent(value);
	if (COOKIE_VALUE_INVALID.test(encoded)) {
		throw new Error(`Invalid cookie value for '${name}'`);
	}
	if (options.domain !== undefined) {
		if (typeof options.domain !== 'string' || COOKIE_ATTR_INVALID.test(options.domain)) {
			throw new Error(`Invalid Domain attribute for cookie '${name}'`);
		}
	}
	if (options.path !== undefined) {
		if (typeof options.path !== 'string' || COOKIE_ATTR_INVALID.test(options.path)) {
			throw new Error(`Invalid Path attribute for cookie '${name}'`);
		}
	}
	let out = name + '=' + encoded;
	if (options.domain !== undefined) out += '; Domain=' + options.domain;
	if (options.path !== undefined) out += '; Path=' + options.path;
	if (options.expires !== undefined) {
		// CHECKED like every other attribute, and it was the one that was not.
		// `toUTCString` is called on whatever was handed in, so a duck-typed or
		// subclassed date returns arbitrary text straight into the header - and an
		// `Invalid Date` renders the literal words, a stray space inside an
		// attribute, with nothing anywhere saying so. Requiring a real Date with a
		// real time is what makes the rendered value a date at all.
		if (!(options.expires instanceof Date) || !Number.isFinite(options.expires.getTime())) {
			throw new Error(`Invalid Expires for cookie '${name}': expected a valid Date`);
		}
		out += '; Expires=' + options.expires.toUTCString();
	}
	if (options.maxAge !== undefined) {
		if (!Number.isFinite(options.maxAge)) {
			throw new Error(`Invalid Max-Age for cookie '${name}': ${options.maxAge}`);
		}
		out += '; Max-Age=' + Math.floor(options.maxAge);
	}
	if (options.httpOnly) out += '; HttpOnly';
	if (options.secure) out += '; Secure';
	if (options.partitioned) out += '; Partitioned';
	if (options.sameSite !== undefined && options.sameSite !== false) {
		const raw = options.sameSite === true ? 'strict' : options.sameSite;
		const normalized = String(raw).toLowerCase();
		if (!VALID_SAMESITE.has(normalized)) {
			throw new Error(`Invalid SameSite for cookie '${name}': ${options.sameSite}`);
		}
		out += '; SameSite=' + normalized[0].toUpperCase() + normalized.slice(1);
	}
	return out;
}

/**
 * A SvelteKit-shaped cookie jar over one request.
 *
 * The request URL is REQUIRED, exactly as SvelteKit requires it: the `Secure`
 * default and relative `Path` resolution are both derived from it, so a
 * defaulted argument here would be fail-open - a caller that forgot it would
 * quietly write session cookies without `Secure`.
 *
 * @param {string | null | undefined} cookieHeader raw `Cookie` header
 * @param {string | URL} requestUrl drives the `Secure` default and resolves
 *   relative cookie paths
 */
export function createCookies(cookieHeader, requestUrl) {
	if (requestUrl === undefined || requestUrl === null || requestUrl === '') {
		throw new Error(
			'createCookies requires the request URL: the Secure default and relative Path ' +
			'resolution are derived from it'
		);
	}
	const parsed = parseCookies(cookieHeader);
	const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
	/** @type {CookieSerializeOptions} */
	const defaults = {
		httpOnly: true,
		sameSite: 'lax',
		// Everything except plain-http localhost, which is the one origin a
		// browser will not send a Secure cookie back to and the one an app is
		// developed against.
		secure: !(url.hostname === 'localhost' && url.protocol === 'http:')
	};
	/**
	 * Keyed by name + path + domain, which is the tuple a browser treats as one
	 * cookie: two `set()` calls in one hook that differ only in path are two
	 * cookies, and two that agree are one.
	 * @type {Map<string, string>}
	 */
	const outgoing = new Map();

	/**
	 * @param {string} name
	 * @param {string | undefined} path
	 * @param {string | undefined} domain
	 */
	function key(name, path, domain) {
		return name + '\0' + (path || '') + '\0' + (domain || '');
	}

	/** @param {CookieSerializeOptions | undefined} options */
	function requirePath(options) {
		if (options?.path === undefined) {
			throw new Error('You must specify a `path` when setting or deleting cookies');
		}
	}

	const api = {
		/**
		 * @param {string} name
		 * @returns {string | undefined}
		 */
		get(name) {
			return parsed[name];
		},
		/**
		 * A COPY, so a caller holding it cannot write back into the jar - and so
		 * it is an ordinary object rather than the null-prototype bag, which is
		 * what an app iterating or spreading it expects.
		 * @returns {Record<string, string>}
		 */
		getAll() {
			return { ...parsed };
		},
		/**
		 * @param {string} name
		 * @param {string} value
		 * @param {CookieSerializeOptions & { path: string }} options
		 */
		set(name, value, options) {
			requirePath(options);
			const resolved = { ...defaults, ...options };
			// SvelteKit resolves a relative path against the request URL before
			// serializing. Without it `Path=sub` reaches the browser, which
			// discards it for the RFC 6265 default path - a silent scope change
			// from what the caller asked for.
			if (typeof resolved.path === 'string' && resolved.path[0] !== '/') {
				resolved.path = new URL(resolved.path, url).pathname;
			}
			outgoing.set(key(name, resolved.path, resolved.domain), serializeCookie(name, value, resolved));
			// Readable back through `get` in the same hook: an app that sets a
			// session cookie and then reads it should see what it just wrote.
			parsed[name] = value;
		},
		/**
		 * @param {string} name
		 * @param {CookieSerializeOptions & { path: string }} options
		 */
		delete(name, options) {
			requirePath(options);
			api.set(name, '', {
				...options,
				expires: new Date(0), // determinism-allow: the fixed Unix epoch, which is what expires a cookie immediately - not a clock read
				maxAge: 0
			});
			delete parsed[name];
		},
		/**
		 * Drain the accumulated `Set-Cookie` lines. The adapter's, not the app's.
		 * @returns {string[]}
		 */
		_serialize() {
			return [...outgoing.values()];
		}
	};
	return api;
}
