/**
 * Control-frame recognition and the oversize refusal. Pure, because getting
 * either wrong is silent: a frame the demux wrongly claims is destroyed, and a
 * refusal with the wrong field names is discarded by the client that needed it.
 */

/**
 * Largest control frame the demux will parse, in BYTES.
 *
 * Bytes, not String.length: UTF-16 code units would let multi-byte text carry
 * up to four times this much into JSON.parse, so the enforced ceiling would not
 * be the documented one, and the size reported back would be measured on a
 * different dimension than the one that rejected it.
 */
export const CONTROL_FRAME_LIMIT = 8192;

/** The control types the demux consumes itself. */
export const CONSUMED_CONTROL_TYPES = ['subscribe', 'unsubscribe', 'subscribe-batch', 'hello', 'resume', 'request-n', 'ingress-bind'];

/** Subscribe batches apply this prefix and deny extra string topics. */
export const MAX_BATCH_TOPICS = 256;

/**
 * Longest run of whitespace either recogniser will step over between tokens.
 *
 * Shared so the cheap prefix test and the oversize test cannot disagree - which
 * they did, because one had a bound of 8 and the other used `\s*`. Sized to
 * clear `JSON.stringify(value, null, 8)`, the deepest indentation a
 * pretty-printing client realistically emits.
 */
const MAX_WS_RUN = 16;

/** The four characters JSON allows as whitespace, bounded. NOT `\s`. */
const JSON_WS = `[ \\t\\n\\r]{0,${MAX_WS_RUN}}`;

/**
 * Does this frame carry a control type the demux would actually handle?
 *
 * The cheap prefix test the hot path uses - "is byte 3 the `y` of `{"type`" -
 * is a heuristic, not proof: `{"type":...}` is the single most common
 * application envelope convention there is. Treating the heuristic as proof
 * when refusing an oversized frame destroys any large app message that happens
 * to match, and answers it with a protocol error the app never asked for.
 *
 * Scans a bounded prefix rather than parsing, because the whole point of the
 * ceiling is not paying JSON.parse on attacker-sized input.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isConsumedControlType(text) {
	// Anchored to `type` as the FIRST key, matching looksLikeControlFrame. The
	// two recognisers must agree about the same frame or the demux and the
	// oversize refusal disagree about what they are looking at.
	//
	// That makes "type first" a protocol requirement rather than an accident of
	// JSON.stringify, and it is documented as one at the top of handler/ws.js.
	// JSON defines no key order, so a client CAN legally send
	// `{"ref":1,"type":"subscribe"}` - but recognising that costs a scan on the
	// path every inbound frame takes: reorder-tolerant shapes measure 21-27
	// ns/frame against 4.1-4.8 ns for the character compare the cheap test
	// uses. Ranges, not points - the machine varies by roughly a third between
	// runs, so a single figure is not reproducible.
	// See bench/control-frame-prefix.mjs. Every client in the family emits
	// `type` first.
	//
	// The character class is the four characters JSON actually allows between
	// tokens, and the repetition is bounded by the SAME limit the cheap test
	// uses. `\s*` was neither: it is unbounded, and it matches NBSP, BOM,
	// U+2028, \f and \v, none of which are JSON whitespace. That produced seven
	// constructible frames the two recognisers disagreed about - including
	// `JSON.stringify(frame, null, 8)`, whose nine spaces put it past the cheap
	// test's window while this one still accepted it, so it reached the app as
	// ordinary data and never subscribed.
	const match = new RegExp(
		`^${JSON_WS}\\{${JSON_WS}"type"${JSON_WS}:${JSON_WS}"([^"]{0,40})"`
	).exec(text.slice(0, 96));
	return match !== null && CONSUMED_CONTROL_TYPES.includes(match[1]);
}

/**
 * The cheap prefix test the demux uses to decide whether a text frame is worth
 * parsing as a control frame.
 *
 * `JSON.stringify` puts the `y` of `{"type` at index 3, and that single
 * comparison is what keeps application traffic off the parse path. But it is
 * only true for compact output: a hand-written or pretty-printing client sends
 * `{ "type": "subscribe" }`, whose index 3 is `t`, and that frame was being
 * forwarded to the app as ordinary data and never subscribing - silently, with
 * no error either side. isConsumedControlType() tolerates the whitespace, so
 * the two recognisers disagreed about the same frame.
 *
 * The fast path is unchanged for compact frames (one charCodeAt). The fallback
 * costs one more comparison for every non-control frame - the first byte of an
 * application envelope is `{`, not whitespace, so it short-circuits there - and
 * only frames that genuinely begin with whitespace pay for the bounded scan.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeControlFrame(text) {
	let i = skipWhitespace(text, 0);
	// Must open an OBJECT. Checked before anything else because `["type"]` also
	// carries `y` at index 3 and the bare index test claimed it.
	if (text.charCodeAt(i) !== 0x7b) return false;
	i = skipWhitespace(text, i + 1);
	// `"type` compared character by character from wherever the first key
	// actually starts, so `{ "type": ... }` from a hand-written or
	// pretty-printing client is recognised. Anchoring at a fixed index instead
	// forwards those frames to the app as ordinary data, and the subscribe they
	// asked for never happens, silently.
	return (
		text.charCodeAt(i) === 0x22 &&
		text.charCodeAt(i + 1) === 0x74 &&
		text.charCodeAt(i + 2) === 0x79 &&
		text.charCodeAt(i + 3) === 0x70 &&
		text.charCodeAt(i + 4) === 0x65 &&
		text.charCodeAt(i + 5) === 0x22
	);
}

/**
 * Advance past JSON's four whitespace characters, bounded.
 *
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function skipWhitespace(text, i) {
	const limit = i + MAX_WS_RUN;
	while (i < limit) {
		const c = text.charCodeAt(i);
		if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
			i++;
			continue;
		}
		break;
	}
	return i;
}

/**
 * The oversized-control-frame refusal.
 *
 * Field names are `code` / `limit` / `size` because that is what the family's
 * client gates on: it checks `typeof msg.code === 'string'` and discards the
 * frame otherwise. Renaming `code` to something more natural silently defeats
 * the entire purpose of sending it - the developer whose control frame
 * overflowed gets no signal at all, which is the exact failure the frame exists
 * to prevent.
 *
 * @param {number} size - the offending frame's size in bytes
 * @returns {string}
 */
export function controlFrameTooLargeFrame(size) {
	return '{"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":' + CONTROL_FRAME_LIMIT +
		',"size":' + size + '}';
}

/**
 * Close code for a connection cut off for exhausting its control-frame budget.
 *
 * 4429, NOT 1008. Both family clients list 1008 in their TERMINAL_CLOSE_CODES
 * and stop reconnecting permanently on it, while 4429 is their THROTTLE code,
 * which reconnects with accelerated backoff. The budget is a limit a legitimate
 * client can reach by resubscribing a large enough set, so cutting the
 * connection must not permanently kill the page. Nothing is written before
 * the close (see refuseControlFlood).
 */
export const CONTROL_FLOOD_CLOSE_CODE = 4429;

/**
 * Close code for a connection whose gap-fill could not be completed AND could
 * not be told so.
 *
 * 1013 (Try Again Later), which both family clients classify as RETRY: they
 * reconnect on the ordinary backoff curve, and the reconnect resumes from the
 * last seq the client actually received, so the tail it missed is re-delivered
 * rather than lost. That is why closing here is a repair and not a punishment -
 * the alternative is a client that stays connected and silently wrong.
 *
 * Not 4429: this is not throttling, and the accelerated backoff that code
 * selects would be the wrong curve for a socket that needs time to drain.
 */
export const RESUME_INCOMPLETE_CLOSE_CODE = 1013;

// - Send-gate control frames -----------------------------------------------
// JSON control frames carrying no data body, JSON transport only. Routed
// through the existing JSON-control demux (byte[3] === 'y') on both ends; no
// new demux branch. ASCII-safe numeric serialization.

/**
 * Build the server-to-client window-grant control frame.
 * @param {number} count
 * @param {number} ttlMs
 * @returns {string}
 */
export function leaseGrantFrame(count, ttlMs) {
	return '{"type":"lease","count":' + (count | 0) + ',"ttlMs":' + (ttlMs | 0) + '}';
}

/**
 * Build the client-to-server window-replenish control frame.
 * @param {number} n
 * @returns {string}
 */
export function requestNFrame(n) {
	return '{"type":"request-n","n":' + (n | 0) + '}';
}
