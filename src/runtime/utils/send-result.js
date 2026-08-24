/**
 * The send-result shim: Bun's `ServerWebSocket.send()` return value translated
 * into the tri-state the platform and its consumers key on.
 *
 * The platform's callers were written against uWS, whose send() returns:
 *   0 = enqueued behind backpressure. WILL deliver. NOT a drop.
 *   1 = written to the socket.
 *   2 = dropped past maxBackpressure. This is the degrade-to-JSON /
 *       invalidate-resume signal, and it poisons per-connection wire state.
 *
 * Bun returns a different set (observed 2026-07-25, pinned in
 * probe/bun-api-facts.report.md under `send-return-codes`):
 *   >0 = bytes accepted
 *   -1 = backpressure applied (drain() fires once the socket settles)
 *    0 = rejected
 *
 * ORDERING CONTRACT - the reason this module is separate and pure:
 * Bun's `0` is AMBIGUOUS at the source. It was observed BOTH past the
 * backpressure limit AND on a genuinely closed, unburdened socket
 * (readyState 3). uWS distinguishes those two cases and its callers depend on
 * the distinction: a closed-socket send throws and is caught into the
 * closedWsAborts lane with no wire-state poison, while a `2` poisons wire
 * state as a real backpressure drop. So this mapping is exact ONLY for a
 * socket already known to be open. Every caller MUST run its closed check
 * BEFORE calling mapSendResult - see the facade in handler/ws-facade.js, which
 * throws on a closed socket so the closed case never reaches this function.
 * Calling this on a closed socket silently books a closed send as a
 * backpressure drop and poisons wire state for a connection that is already
 * gone.
 *
 * Pure and dependency-free so the mapping is unit-testable without a socket.
 */

/** Enqueued behind backpressure. Will deliver; not a drop. */
export const SEND_BACKPRESSURE = 0;

/** Written to the socket. */
export const SEND_SUCCESS = 1;

/** Dropped past the backpressure limit. Degrade / invalidate signal. */
export const SEND_DROPPED = 2;

/**
 * Translate one Bun send() result into the uWS tri-state.
 *
 * Only `-1` maps to "enqueued". Any other non-positive value maps to DROPPED,
 * including values Bun does not document today: claiming "will deliver" for an
 * unrecognized code would silently lose frames, whereas an over-eager DROPPED
 * costs a degrade-to-JSON and a resume invalidation that both self-heal. The
 * conservative direction is the one that cannot lose data.
 *
 * A zero-length payload returns 0 on an OPEN socket (probed, pinned in the
 * report under `send-return-codes`: send("") and a 0-byte binary both return 0
 * AND both frames are delivered on a healthy socket, while past the
 * backpressure limit the same call returns 0 and the frame is dropped). So
 * for empty payloads Bun's 0 is ambiguous a SECOND way, and this mapping
 * alone reads every empty send as DROPPED. The adapter's own frames never hit
 * the edge - every frame is a non-empty JSON string (envelopes from
 * utils/envelope.js open with `{"topic":`, control and ack frames from
 * utils/control-frame.js and utils/ack-frame.js with `{"type":`) - but the
 * facade's send() and publish() route
 * app-supplied payloads through this mapping, so the edge is reachable from
 * any app hook (`ws.send('')`). The facade's send() therefore discriminates
 * empty sends itself, using the socket's backlog (see handler/ws-facade.js);
 * any OTHER caller that hands this mapping the result of a possibly-empty
 * send must do the same or accept the conservative DROPPED.
 *
 * @param {unknown} result - the raw return value of Bun's `ws.send()`
 * @returns {0 | 1 | 2} the uWS tri-state
 */
export function mapSendResult(result) {
	if (typeof result !== 'number' || Number.isNaN(result)) return SEND_DROPPED;
	if (result > 0) return SEND_SUCCESS;
	if (result === -1) return SEND_BACKPRESSURE;
	return SEND_DROPPED;
}

/**
 * Whether a native FAN-OUT publish reached anyone.
 *
 * The sibling of {@link mapSendResult} for `server.publish()`, and it lives
 * beside it so the two cannot drift: the runtime answers both calls from the
 * same set of codes, and a rule stated twice is a rule that eventually
 * disagrees with itself.
 *
 * THREE ANSWERS, not two. The byte count when the frame went out, `-1` when a
 * subscriber is under backpressure and the frame was queued for it, and `0`
 * when it was DISCARDED or the topic had no subscriber. An earlier runtime
 * could not say the middle one - a frame discarded for a subscriber came back
 * as the byte count like any other - so the answer set widened rather than
 * changed meaning, and reading the result as a byte count that might be zero
 * silently loses both new cases.
 *
 * A QUEUED FRAME COUNTS AS REACHED. It is what the older runtime answered for
 * that same case, so treating `-1` as "nobody got it" changes what `publish()`
 * returns under an app that changed nothing - and an app that retries on
 * `false` then sends it twice, to a subscriber whose socket is already behind.
 *
 * ONLY THE DOCUMENTED CODES CLAIM DELIVERY, which is why this is not simply
 * `result !== 0`. An unrecognized negative, or a NaN, must not answer
 * "reached" - the same conservative direction `mapSendResult` takes, for the
 * same reason: being wrong toward "nobody got it" costs a resend, being wrong
 * toward "delivered" loses the frame silently, and only one of those
 * self-heals.
 *
 * Unlike `mapSendResult` this carries no closed-socket ordering contract:
 * a fan-out has no one socket to be closed, and the runtime answers `0` for
 * an empty topic rather than throwing.
 *
 * @param {unknown} result - the raw return value of `server.publish()`
 * @returns {boolean} whether at least one subscriber got it or has it queued
 */
export function publishReached(result) {
	if (typeof result !== 'number' || Number.isNaN(result)) return false;
	return result > 0 || result === -1;
}
