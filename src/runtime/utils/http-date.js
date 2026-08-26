import { wallEpoch } from '../runtime.js';

/**
 * Parse an HTTP-date, strictly.
 *
 * `Date.parse` is the obvious thing to reach for and the wrong one: it accepts
 * ISO 8601, bare years, `Month Day Year`, and a good deal else that no HTTP
 * sender may produce. A precondition that honours those is a precondition that
 * can be satisfied by a header the RFC says is unintelligible - so
 * `If-Modified-Since: 2026-01-01` would win a 304, and a mangled proxy header
 * could win a 412. Only the three formats RFC 9110 s5.6.7 defines are read
 * here; anything else is NaN, which every caller treats as "the client said
 * nothing about time".
 *
 * All three are accepted because the RFC requires recipients to accept all
 * three, even though only IMF-fixdate may be SENT. The obsolete two are dead
 * on the wire and cost twenty lines to keep honest.
 *
 * @module runtime/utils/http-date
 */

const MONTHS = {
	Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
	Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

// Written out rather than composed from shared fragments: three regexes that
// each read as the format they accept is worth more here than the two lines
// deduplication would save.

// Sun, 06 Nov 1994 08:49:37 GMT - the only form a sender may generate.
const IMF_FIXDATE =
	/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
// Sunday, 06-Nov-94 08:49:37 GMT
const RFC850 =
	/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
// Sun Nov  6 08:49:37 1994 - the day is space-padded, not zero-padded.
const ASCTIME =
	/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * Epoch milliseconds for a validated field set, or NaN when the fields do not
 * describe a real instant.
 *
 * The round-trip check is what refuses `31 Feb`: Date.UTC rolls it forward to
 * March rather than failing, and a precondition comparing against a date the
 * client did not write is worse than one that ignores the header.
 *
 * @param {number} year
 * @param {number} month - 0-11
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @returns {number}
 */
function utcOf(year, month, day, hour, minute, second) {
	if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return NaN;
	const ms = Date.UTC(year, month, day, hour, minute, second);
	const back = new Date(ms); // determinism-allow: reads the value computed on the line above, never a clock
	if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month || back.getUTCDate() !== day) {
		return NaN;
	}
	return ms;
}

/**
 * The four-digit year an rfc850-date's two digits mean.
 *
 * RFC 9110 s5.6.7: a timestamp more than 50 years in the future is the most
 * recent past year ending in those digits. That rule is relative to now, so it
 * reads the clock through the runtime seam like everything else here.
 *
 * @param {number} twoDigit
 * @param {number} nowMs
 * @returns {number}
 */
function expandYear(twoDigit, nowMs) {
	const nowYear = new Date(nowMs).getUTCFullYear(); // determinism-allow: reads the seam value passed in, never a clock
	const candidate = Math.floor(nowYear / 100) * 100 + twoDigit;
	return candidate - nowYear > 50 ? candidate - 100 : candidate;
}

/**
 * An HTTP-date as epoch milliseconds, or NaN when the value is not one.
 *
 * @param {string} value
 * @param {number} [nowMs] - the instant an rfc850-date's two-digit year is
 *   read against; defaults to the runtime clock
 * @returns {number}
 */
export function parseHttpDate(value, nowMs = NaN) {
	let m = IMF_FIXDATE.exec(value);
	if (m) {
		return utcOf(Number(m[3]), MONTHS[/** @type {keyof MONTHS} */ (m[2])], Number(m[1]),
			Number(m[4]), Number(m[5]), Number(m[6]));
	}
	m = ASCTIME.exec(value);
	if (m) {
		return utcOf(Number(m[6]), MONTHS[/** @type {keyof MONTHS} */ (m[1])], Number(m[2]),
			Number(m[3]), Number(m[4]), Number(m[5]));
	}
	m = RFC850.exec(value);
	if (m) {
		const year = expandYear(Number(m[3]), Number.isNaN(nowMs) ? wallEpoch() : nowMs);
		return utcOf(year, MONTHS[/** @type {keyof MONTHS} */ (m[2])], Number(m[1]),
			Number(m[4]), Number(m[5]), Number(m[6]));
	}
	return NaN;
}

/**
 * The whole seconds an HTTP-date names, or NaN. Preconditions compare at
 * second precision because that is all an HTTP-date carries.
 *
 * @param {string} value
 * @param {number} [nowMs]
 * @returns {number}
 */
export function httpDateSeconds(value, nowMs = NaN) {
	const ms = parseHttpDate(value, nowMs);
	return Number.isNaN(ms) ? NaN : Math.floor(ms / 1000);
}
