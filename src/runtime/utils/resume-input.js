/**
 * Validation for subscribe recover offsets and epochs before the app resume hook.
 * Resume frames forward their maps directly to the hook.
 */

/**
 * A watermark the client could legitimately be holding: a finite, non-negative
 * number.
 *
 * NOT required to be an integer, and NOT bounded to the safe-integer range.
 * The `{ seq: true }` counter lane produces small integers, but an explicit
 * `{ seq: <number> }` publish carries the app's own cursor - and that is the
 * cluster-authoritative lane, the only one the resume floor ever dedups
 * against. Apps relay event-store cursors through it, where snowflake ids,
 * Kafka offsets and log sequence numbers run past 2^53 as a matter of course.
 * A watermark this server itself put on the wire has to round-trip.
 *
 * The publish side is STRICTER than this (utils/publish-seq.js requires an
 * integer of AT LEAST 1, since 0 is the binary frame's "no seq" sentinel), and
 * the gap is deliberate rather than an inconsistency to close. This rule
 * governs what a client may be HOLDING - from an older build, or from another
 * node in a cluster - so tightening it to match would drop those topics from
 * the gap-fill map and manufacture the silent gap the barrier exists to
 * prevent. Note that 0 is precisely such a value: never emitted, but "seen
 * nothing yet" is a real thing for a client to be holding. Refusing on the
 * publish side throws, at the app that chose the value; refusing here would
 * cost a client its history.
 *
 * Magnitude is the app's business, and the wire carries it exactly - the frame
 * varint round-trips 2^53 and beyond. The place an absurd value does damage is
 * the dedup floor, and that is bounded where the floor is built
 * (`flushResumeTopic` in handler/resume-buffer.js), against the topic's own
 * high-water mark. Not here, because this rule cannot see that mark.
 *
 * The lower bound is not symmetry. A negative seq is not merely unusual, it is
 * unrepresentable: the frame varint encodes -1 and parses it back as 127, so a
 * negative watermark names a frame no client can be holding - which is why the
 * publish side refuses to emit one at all.
 *
 * @param {unknown} v
 * @returns {v is number}
 */
export function isValidResumeSeq(v) {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * An epoch the server could actually have issued: a non-negative integer.
 *
 * `processEpoch()` is a random uint32 (drawn through the runtime seam, from
 * node:crypto in the default env), so the domain is the non-negative
 * integers. Unlike a watermark there is no app-supplied
 * lane widening it - an epoch is only ever minted by the server and echoed
 * back - so integrality is safe to require here in a way it is not above. No
 * ceiling: an app running its own cluster-wide epoch scheme may number past
 * 2^32, and the value is only ever compared for equality, never used in
 * arithmetic a large magnitude would corrupt.
 *
 * @param {unknown} e
 * @returns {e is number}
 */
export function isValidResumeEpoch(e) {
	return typeof e === 'number' && Number.isInteger(e) && e >= 0;
}
