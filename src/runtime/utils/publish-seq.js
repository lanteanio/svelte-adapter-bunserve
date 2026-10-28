/**
 * The rule for an explicit `seq` a publish carries.
 *
 * This is the PUBLISH side of the seq contract; utils/resume-input.js holds the
 * client side. They are deliberately different rules, and the asymmetry is the
 * point: this one decides what the server is willing to PUT on the wire, so it
 * may be strict, while the inbound one decides what a client may be holding
 * from an older server, so it must not be.
 *
 * Pure and dependency-free so the rule is unit-testable without a socket.
 */

/**
 * Refuse a seq whose value the wire's double space cannot keep distinct.
 *
 * Its own throw site and its own message: the value IS a positive integer, so
 * the legal-forms message would send a caller looking for a spelling mistake
 * that is not there. What is wrong is the magnitude, and the fix is a different
 * authority, so the message says that.
 *
 * @param {number | bigint} value
 * @param {string} [topic]
 * @returns {never}
 * @throws {TypeError} always
 */
export function throwUncarryableSeq(value, topic) {
	throw new TypeError(
		`seq ${typeof value === 'bigint' ? `${value}n` : value} exceeds the wire's safe-integer range ` +
		'(at most 9007199254740991)' + (topic === undefined ? '' : ` (topic "${topic}")`) + ': the seq ' +
		'space is IEEE-754 double, which stops having a neighbour at distance one above that, so ids a ' +
		'caller means to be different collapse onto a single value. Because watermarks advance on a ' +
		"strict greater-than, the second frame then fails to advance the client's watermark and resume " +
		'dedup goes ambiguous with nothing on the wire to notice by. Keep the wide id in the event data ' +
		'and give seq an authority inside the range, or offset it by a per-topic base; do not truncate, ' +
		'which destroys the ordering seq exists for'
	);
}

/**
 * Refuse a `seq` option that is none of the spellings the lanes accept.
 *
 * Separate from {@link throwUncarryableSeq} because the two say different
 * things: that one is about a number the wire cannot carry, this one about a
 * value that was never a seq option at all.
 *
 * @param {unknown} value
 * @param {string} [topic]
 * @returns {never}
 * @throws {TypeError} always
 */
export function throwInvalidSeq(value, topic) {
	throw new TypeError(
		'publish seq must be a positive integer number or bigint (an explicit authority\'s value), ' +
		'true (the in-memory counter), or false/null (no seq); received ' +
		`${typeof value === 'string' ? JSON.stringify(value) : String(value)}` +
		(topic === undefined ? '' : ` (topic "${topic}")`) +
		'. A seq that arrives as a string - from JSON, a Redis reply, a header, a form field - is the ' +
		'case this refuses: drawing the counter for it would publish a value from a different sequence ' +
		'space and leave the topic unmarked, so convert it at the boundary.'
	);
}

/**
 * Validate an EXPLICIT seq value - the number and bigint spellings of one
 * authority - and project it into the wire's seq space.
 *
 * That space is IEEE-754 double, and the range it carries FAITHFULLY is the
 * safe-integer range: at most 2^53 - 1. Both spellings are held to it.
 *
 * Above that range a double no longer has a neighbour at distance one, so two
 * ids a caller means to be different land on one value. Every max-seen guard
 * and every client watermark advances on a strict greater-than, so the second
 * frame does not advance the watermark and resume dedup goes ambiguous -
 * silently, on exactly the snowflake ids and large log offsets a caller reaches
 * for bigint to carry. The refusal is loud instead.
 *
 * Exact representability is NOT the test, though it looks like the natural one.
 * It fails on both ends. The JSON envelope serializes through `String(double)`,
 * which emits the shortest round-tripping decimal rather than the integer: 2^60
 * is an exact double and still reaches a subscriber as 1152921504606847000, a
 * number nobody issued. And in the band just above 2^53, where the gap is two,
 * an exactness test would take a caller's EVEN offsets and refuse the ODD ones
 * - a contract that fails on half a stream, by parity, is worse than one that
 * refuses the range outright.
 *
 * AT LEAST 1, not merely non-negative, because the binary frame RESERVES 0 as
 * its "no seq" sentinel. A stamped 0 vanishes for binary subscribers while the
 * JSON envelope carries `"seq":0`, so the two halves of one topic disagree
 * about whether the event had a seq at all. A negative seq is worse still: the
 * frame varint encodes -1 and parses it back as 127. And a fractional seq is
 * truncated on the frame but printed in full in the JSON envelope.
 *
 * @param {number | bigint} value
 * @param {string} [topic]
 * @returns {number}
 */
export function explicitSeqValue(value, topic) {
	if (typeof value === 'number') {
		if (Number.isSafeInteger(value) && value >= 1) return value;
		// An integer too large to be safe is a magnitude fault, not a spelling
		// one, and gets the message that says so.
		if (Number.isInteger(value) && value >= 1) throwUncarryableSeq(value, topic);
	} else if (typeof value === 'bigint' && value >= 1n) {
		// The typeof is load-bearing, not decoration: `>= 1n` is a VALUE
		// comparison, and a relational compare of a string against a bigint runs
		// StringToBigInt - so a bare `value >= 1n` would let `'7'` through this
		// arm and return 7, quietly accepting a spelling every caller refuses.
		//
		// Number.isSafeInteger then answers exactness and range together: a
		// bigint at or above 2^53 cannot land on a safe integer, and one below
		// converts exactly. No BigInt is allocated on the accepting path.
		const projected = Number(value);
		if (Number.isSafeInteger(projected)) return projected;
		throwUncarryableSeq(value, topic);
	}
	throwInvalidSeq(value, topic);
}

/**
 * A seq this server can put on BOTH wires and mean the same thing on each.
 *
 * The predicate form of {@link explicitSeqValue}'s accepting branch, for
 * callers that want a test rather than a throw. Number only: a bigint is a
 * spelling of the same authority, and a caller holding one asks the validator.
 *
 * @param {unknown} v
 * @returns {v is number}
 */
export function isValidPublishSeq(v) {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

/**
 * Resolve one batch entry's `seq` into its override form, speaking the same
 * table as the publish lanes so the entry spelling and the options spelling
 * cannot disagree.
 *
 * A refusal names the entry's POSITION. One bad value refuses the whole batch,
 * so without the index a caller handing over two hundred entries gets one
 * message and no way to tell which of them carried it; the array is the
 * caller's own, so the index is all they need.
 *
 * The catch refuses to dress up an error it did not cause: coercing the value
 * for the message runs user code (`Symbol.toPrimitive`), and something thrown
 * from there is the caller's, not a seq verdict.
 *
 * Every form other than `undefined` is an OVERRIDE of the batch's shared
 * options for this entry, which is what makes the entry lane and the options
 * lane one table rather than two.
 *
 * @param {unknown} value - the entry's `seq` field, read once by the caller
 * @param {string} topic
 * @param {number} [index] - the entry's position, named in a refusal
 * @returns {number | boolean | undefined} `undefined` inherits the batch
 *   options; a NUMBER is this entry's validated explicit authority; `true`
 *   draws the counter for this entry alone; `false` (the resolution of both
 *   `false` and `null`) leaves this entry seq-less
 */
export function resolveEntrySeq(value, topic, index) {
	try {
		if (value === undefined) return undefined;
		if (typeof value === 'number' || typeof value === 'bigint') {
			return explicitSeqValue(value, topic);
		}
		// `null` is a no-seq OVERRIDE, not an inherit. A per-row authority
		// column reading null means this row has no cluster seq, and inheriting
		// the batch's counter for it would mark the row with a value from
		// another space rather than leaving it unmarked as the column said.
		if (value === false || value === null) return false;
		if (value === true) return true;
		throwInvalidSeq(value, topic);
	} catch (error) {
		if (index === undefined || !(error instanceof TypeError)) throw error;
		throw new TypeError(`batch entry ${index}: ${error.message}`, { cause: error });
	}
}

/**
 * Resolve the SEND lanes' `seq` option - the gap-fill channel a resume hook
 * replays history through.
 *
 * Explicit forms only: number and bigint validate exactly as the publish lanes'
 * explicit authority does; `false`, `null` and absent mean no seq, the lanes'
 * historical shape. `true` throws its own message rather than the publish
 * table's, because a single-target send has no counter to draw - gap-fill
 * replays history that is ALREADY accounted, which is why an explicitly-seq'd
 * send stays side-effect-free: no counter advance, no max-seen record, no
 * resume capture.
 *
 * @param {unknown} opt
 * @returns {number | null}
 */
export function resolveSendSeq(opt) {
	if (opt === undefined || opt === false || opt === null) return null;
	if (typeof opt === 'number' || typeof opt === 'bigint') return explicitSeqValue(opt);
	throw new TypeError(
		"send seq must be an explicit positive integer number or bigint (a replay authority's value), " +
		'or false/null/absent for no seq; the send lanes never draw the in-memory counter'
	);
}
