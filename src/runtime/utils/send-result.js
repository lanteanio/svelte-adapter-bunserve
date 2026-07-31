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
 * the edge - every JSON envelope from utils/envelope.js and every control
 * frame from utils/control-frame.js and utils/ack-frame.js is a string with
 * at least `{"type":` in it - but the facade's send() and publish() route
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
