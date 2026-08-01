// - Helpers -----------------------------------------------------------------

/**
 * @param {string} value
 * @returns {number}
 */
export function parse_as_bytes(value) {
	const str = value.trim();
	const last = str[str.length - 1]?.toUpperCase();
	// Strip trailing 'B' (e.g. "512KB" -> "512K")
	const normalized = last === 'B' ? str.slice(0, -1) : str;
	const suffix = normalized[normalized.length - 1]?.toUpperCase();
	const multiplier =
		{ K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 }[suffix] ?? 1;
	const result = Number(multiplier !== 1 ? normalized.slice(0, -1) : normalized) * multiplier;
	// NaN already throws via downstream callers; reject negative and
	// non-finite values too so a stray '-100' or 'Infinity' in env can
	// never silently disable a size cap or wrap to a giant positive
	// in arithmetic.
	if (!Number.isFinite(result) || result < 0) return NaN;
	return result;
}

/**
 * Seconds a connection may sit idle before Bun closes it, for `IDLE_TIMEOUT`.
 *
 * Bun accepts 0-255 and THROWS above that, so the range is enforced here where
 * the message can name the variable, rather than surfacing as a bare
 * "Bun.serve expects idleTimeout to be 255 or less" at boot. 0 disables the
 * timeout entirely (measured - see the http-idle-timeout section of the facts
 * report). Throws rather than falling back to a default: an operator who typed
 * a timeout wants that timeout, and silently serving a different one is how a
 * streaming endpoint gets cut in production by a value nobody chose.
 *
 * @param {string} value
 * @returns {number}
 */
export function parse_idle_timeout(value) {
	const str = value.trim();
	const result = Number(str);
	if (str === '' || !Number.isInteger(result) || result < 0 || result > 255) {
		throw new Error(
			`IDLE_TIMEOUT must be a whole number of seconds from 0 to 255, received ${JSON.stringify(value)}. ` +
			'0 disables the idle timeout; Bun refuses anything above 255.'
		);
	}
	return result;
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
export function parse_origin(value) {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	let url;
	try {
		url = new URL(trimmed);
	} catch (error) {
		throw new Error(
			`Invalid ORIGIN: '${trimmed}'. ORIGIN must be a valid URL with http:// or https:// protocol.`,
			{ cause: error }
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(
			`Invalid ORIGIN: '${trimmed}'. Only http:// and https:// protocols are supported.`
		);
	}
	return url.origin;
}
