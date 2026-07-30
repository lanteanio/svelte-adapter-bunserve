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
 * A zero-length payload plausibly returns 0 on an OPEN socket (unprobed edge -
 * Bun returns bytes accepted, and zero bytes accepted is zero). That would read
 * here as DROPPED. No caller can produce one: every payload routed through this
 * mapping is either a JSON envelope built by utils/envelope.js or a control
 * frame built by utils/control-frame.js and utils/ack-frame.js, and each of
 * those is a string literal with at least `{"type":` in it. That is a
 * STRUCTURAL property of the builders, not an assertion any of them makes - a
 * future caller that sends a caller-supplied payload must not route it through
 * this mapping without checking the length itself.
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
