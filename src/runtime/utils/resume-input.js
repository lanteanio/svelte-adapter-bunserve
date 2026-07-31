/**
 * Validation for the two client-supplied resume quantities - the per-topic
 * watermark and the per-topic epoch - shared by BOTH lanes that feed them to
 * the app's `resume` hook: the `resume` frame's `lastSeenSeqs`/`lastSeenEpochs`
 * maps and the `subscribe` frame's `recover.offset`/`recover.epoch`.
 *
 * The two lanes hand the hook the SAME argument shape, so a value one lane
 * accepts and the other refuses makes the same client state produce two
 * different gap-fill decisions. They diverged once already - one lane tested
 * `Number.isFinite`, the other `Number.isInteger`, and neither bounded the
 * magnitude - so the rules live here rather than being restated per call site.
 *
 * Pure and dependency-free so the rules are unit-testable without a socket.
 */

/**
 * A watermark the server could actually have issued: a non-negative safe
 * integer.
 *
 * Both bounds carry weight. Seqs are counter-stamped integers, so a fractional
 * watermark is not a value this server ever produced. The safe-integer ceiling
 * is what keeps the resume floor honest: `flushResumeTopic` drops every held
 * frame whose seq is `<= floor`, so a watermark of `1e308` echoed back by a
 * hook as its covered seq silently discards the whole cutover window - the
 * exact silent gap the barrier exists to prevent. Past 2^53 the arithmetic a
 * hook does on it (`seq + 1`) stops being exact anyway.
 *
 * @param {unknown} v
 * @returns {v is number}
 */
export function isValidResumeSeq(v) {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * An epoch the server could actually have issued.
 *
 * `processEpoch()` is a random uint32 (`crypto.getRandomValues`), so the domain
 * is the non-negative integers. No upper bound is imposed: an app running its
 * own cluster-wide epoch scheme may legitimately number above 2^32, and the
 * value is only ever compared for equality, never used in arithmetic that a
 * large magnitude would corrupt.
 *
 * @param {unknown} e
 * @returns {e is number}
 */
export function isValidResumeEpoch(e) {
	return typeof e === 'number' && Number.isInteger(e) && e >= 0;
}
