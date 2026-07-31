/**
 * Validation for the two client-supplied resume quantities - the per-topic
 * watermark and the per-topic epoch - shared by BOTH lanes that feed them to
 * the app's `resume` hook: the `resume` frame's `lastSeenSeqs`/`lastSeenEpochs`
 * maps and the `subscribe` frame's `recover.offset`/`recover.epoch`.
 *
 * The two lanes hand the hook the SAME argument shape, so a value one lane
 * accepts and the other refuses makes the same client state produce two
 * different gap-fill decisions. They diverged once already - one lane tested
 * `Number.isFinite`, the other `Number.isInteger` - so the rules live here
 * rather than being restated per call site.
 *
 * Both rules are deliberately narrow. Refusing a value here does NOT clamp it:
 * it drops the topic from the map the hook gap-fills from, and the `resumed`
 * ack that follows still tells the client to switch to live. An over-strict
 * rule therefore MANUFACTURES the silent gap the resume barrier exists to
 * prevent. These check only what the wire itself cannot mean.
 *
 * Pure and dependency-free so the rules are unit-testable without a socket.
 */

/**
 * A watermark the client could legitimately be holding: a finite, non-negative
 * number.
 *
 * NOT required to be an integer, and NOT bounded to the safe-integer range.
 * The `{ seq: true }` counter lane produces small integers, but an explicit
 * `{ seq: <number> }` publish passes its value through VERBATIM (`stampSeq` in
 * handler/ws-state.js) - and that is the cluster-authoritative lane, the only
 * one the resume floor ever dedups against. Apps relay event-store cursors
 * through it, where snowflake ids, Kafka offsets and log sequence numbers run
 * past 2^53 as a matter of course. A watermark this server itself put on the
 * wire has to round-trip.
 *
 * Magnitude is the app's business, and the wire carries it exactly - the frame
 * varint round-trips 2^53 and beyond. The place an absurd value does damage is
 * the dedup floor, and that is bounded where the floor is built
 * (`flushResumeTopic` in handler/resume-buffer.js), against the topic's own
 * high-water mark. Not here, because this rule cannot see that mark.
 *
 * The lower bound is not symmetry. A negative seq is not merely unusual, it is
 * unrepresentable: the frame varint encodes -1 and parses it back as 127, so a
 * negative watermark names a frame no client can be holding. (`stampSeq` will
 * pass an explicit negative seq through to the wire, which is a defect on the
 * publish side rather than a reason to accept its echo here.)
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
 * `processEpoch()` is a random uint32 (`crypto.getRandomValues`), so the domain
 * is the non-negative integers. Unlike a watermark there is no app-supplied
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
