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
 * A session id the client could legitimately be presenting: 1 to 128 characters
 * of printable ASCII, with no quote or backslash.
 *
 * The value is opaque to the adapter. Whatever issued the previous session
 * minted it, and this lane hands it straight to the app's resume hook, which
 * queries a backend with it - so the rules are the ones that hold whatever the
 * app does downstream: a length bound, so one frame cannot hand the app
 * kilobytes of lookup key, and the character scan the topic rule already
 * applies. 128 is generous against the server's own `crypto.randomUUID()`
 * at 36, and against every id scheme that reaches for a UUID, a nanoid, hex or
 * base64.
 *
 * Printable ASCII rather than "no control byte", because those are not the same
 * bound and only the first one closes the class that matters. Barring `< 32`
 * alone still admits DEL, the C1 block, the bidi overrides and the line
 * separators U+2028 / U+2029 - which `JSON.stringify` emits RAW - so a value
 * that survives the scan can still corrupt a log line or a rendered admin
 * table. It is also what makes the bound unambiguous: over printable ASCII a
 * character IS a byte, so this cannot be argued past with a multi-byte id the
 * way a UTF-16 length bound can (`ref` is capped in BYTES for exactly that
 * reason).
 *
 * @param {unknown} v
 * @returns {v is string}
 */
export function isValidResumeSessionId(v) {
	if (typeof v !== 'string' || v.length === 0 || v.length > 128) return false;
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c < 32 || c > 126 || c === 34 || c === 92) return false;
	}
	return true;
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
