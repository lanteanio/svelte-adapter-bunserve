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
export const CONSUMED_CONTROL_TYPES = ['subscribe', 'unsubscribe', 'subscribe-batch', 'hello'];

/**
 * Entries one `subscribe-batch` may carry.
 *
 * A batch beyond this is refused WHOLE (see batchTooLargeFrame) rather than
 * partly applied. Partial application is the worse contract on both sides: the
 * client has to diff what it sent against what it was told about, and the
 * server has to answer every dropped entry to tell it - which is what turned
 * one 8 KB frame into 800 KB of denials, since a frame that size holds four
 * thousand two-byte entries and each one bought a whole refusal frame.
 *
 * Refusing whole costs one frame no matter how many entries arrived, and no
 * client is left guessing: the batch either applied or it did not.
 *
 * Every client in the family chunks well below this - 200 topics and 8000
 * bytes, explicitly to stay under this limit and the parse ceiling - so the
 * refusal is unreachable for them.
 */
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
 * which reconnects with accelerated backoff. The budget is an operator-tunable
 * limit that a legitimate client can reach by resubscribing a large enough set,
 * so cutting the connection must not permanently kill the page.
 */
export const CONTROL_FLOOD_CLOSE_CODE = 4429;

/**
 * The oversized-batch refusal.
 *
 * An `error` frame rather than a `subscribe-denied`, and deliberately: a denial
 * answers for ONE topic, and the family client keys its denial store by topic
 * name. There is no topic this answers for, since the whole batch was refused,
 * and a denial carrying `topic: null` is discarded unseen by every client in
 * the family - their branch is guarded by `typeof msg.topic === 'string'`.
 * `code` is the field they gate on for frames that answer for no topic, which
 * is exactly what this is.
 *
 * @param {number} size - how many entries the batch actually carried
 * @returns {string}
 */
export function batchTooLargeFrame(size) {
	return '{"type":"error","code":"BATCH_TOO_LARGE","limit":' + MAX_BATCH_TOPICS +
		',"size":' + size + '}';
}

/**
 * The control-budget-exhausted refusal.
 *
 * Same `code` field the oversize refusal uses, and for the same reason: the
 * family client gates on `typeof msg.code === 'string'` and discards anything
 * else, so a differently-shaped frame is a frame the developer never sees.
 *
 * @param {number} limit - the budget in bytes per window
 * @returns {string}
 */
export function controlFloodFrame(limit) {
	return '{"type":"error","code":"CONTROL_FLOOD","limit":' + limit + '}';
}
