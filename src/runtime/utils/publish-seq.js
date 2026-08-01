/**
 * The rule for an explicit `{ seq: <number> }` a publish carries.
 *
 * This is the PUBLISH side of the seq contract; utils/resume-input.js holds the
 * client side. They are deliberately different rules, and the asymmetry is the
 * point: this one decides what the server is willing to PUT on the wire, so it
 * may be strict, while the inbound one decides what a client may be holding
 * from an older server or another node in a cluster, so it must not be.
 *
 * Pure and dependency-free so the rule is unit-testable without a socket.
 */

/**
 * A seq this server can put on BOTH wires and mean the same thing on each: an
 * integer of at least 1.
 *
 * NO UPPER BOUND. The frame varint carries any magnitude exactly - 2^53 and
 * 1e308 both round-trip - and apps relay event-store cursors through this lane,
 * where snowflake ids, Kafka offsets and log sequence numbers run past 2^53 as
 * a matter of course. A ceiling here would refuse cursors the wire handles
 * perfectly well.
 *
 * AT LEAST 1, not merely non-negative, because the binary frame RESERVES 0 as
 * its "no seq" sentinel (see `sendWire`, which stamps 0 to mean exactly that).
 * A stamped 0 therefore vanishes for binary subscribers while the JSON envelope
 * carries `"seq":0`, so the two halves of the same topic disagree about whether
 * the event had a seq at all. The counter lane and every shipped authority
 * (Redis INCR) are 1-based; a 0-based external source must offset by 1.
 *
 * NOT NEGATIVE, for the sharper version of the same problem: a negative seq is
 * unrepresentable rather than ambiguous - the frame varint encodes -1 and parses
 * it back as 127, so the two wires carry different numbers for one event and the
 * watermark the client stores is a value the server never meant.
 *
 * AN INTEGER, for the same parity reason once more: the varint truncates a
 * fractional seq while the JSON envelope prints it in full, so 1.5 reaches the
 * two wires as 1 and as 1.5.
 *
 * Note the contrast with `isValidResumeSeq`, which accepts a fractional
 * watermark. That is not an oversight there: refusing a watermark drops its
 * topic from the gap-fill map, so an over-strict inbound rule manufactures the
 * silent gap the resume barrier exists to prevent. Refusing here costs a
 * warning and a seq-less publish instead, which is why this side can be exact.
 *
 * @param {unknown} v
 * @returns {v is number}
 */
export function isValidPublishSeq(v) {
	return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}
