/**
 * The in-flight-subscribe epoch: the thing that stops an unsubscribe from being
 * overtaken by a subscribe that is still sitting in the app's authorization
 * gate.
 *
 * The subscribe path awaits an app-supplied hook; the unsubscribe path is
 * synchronous. So an unsubscribe can begin AND FINISH between a subscribe's
 * gate call and its landing. Without this, the landing installs a subscription
 * the client already left - and because the unsubscribe was acked, the client
 * never asks again. An ex-member of a room keeps receiving it: a
 * confidentiality failure, not merely counter drift.
 *
 * A post-await `subs.has(topic)` re-check cannot detect it. The topic is absent
 * from the set in BOTH the never-subscribed case and the just-unsubscribed
 * case, and those two demand opposite outcomes. Only a generation counter
 * stamped before the await distinguishes them.
 *
 * The state also carries a running `inflight` TOTAL across topics, because the
 * per-connection subscription cap has to count gates that have been entered but
 * have not landed yet. Bun does not await the `message` handler, so a client can
 * pipeline thousands of subscribe frames that all enter the gate before any of
 * them installs; a cap that reads only the installed set sees zero every time
 * and bounds nothing. The total is maintained incrementally rather than summed
 * on demand: the caller checks it on every subscribe, and summing the map there
 * would make the pipelined case quadratic - turning the bound into its own
 * amplifier.
 *
 * Pure: every function takes the connection's state (or undefined) and returns a
 * value. No clock, no IO, no globals - so the ordering can be tested exhaustively
 * without a socket.
 *
 * @typedef {{ topics: Map<string, { epoch: number, inflight: number }>, inflight: number }} PendingState
 */

/**
 * Fresh per-connection state.
 *
 * @returns {PendingState}
 */
export function createPending() {
	return { topics: new Map(), inflight: 0 };
}

/**
 * Open an in-flight subscribe and return its token.
 *
 * @param {PendingState} state
 * @param {string} topic
 * @returns {number} token to hand back to settlePending
 */
export function beginPending(state, topic) {
	let entry = state.topics.get(topic);
	if (!entry) {
		entry = { epoch: 0, inflight: 0 };
		state.topics.set(topic, entry);
	}
	entry.inflight++;
	state.inflight++;
	return entry.epoch;
}

/**
 * Close the in-flight subscribe opened with `token`, and report whether the
 * subscription may still be installed.
 *
 * @param {PendingState | undefined} state
 * @param {string} topic
 * @param {number} token
 * @returns {boolean} false when an unsubscribe landed while the gate was awaiting
 */
export function settlePending(state, topic, token) {
	if (!state) return false;
	const entry = state.topics.get(topic);
	if (!entry) return false;
	// Drop the entry once nothing is in flight, so a connection that subscribes
	// and unsubscribes repeatedly does not accumulate one entry per topic it
	// ever touched.
	if (--entry.inflight <= 0) state.topics.delete(topic);
	// Clamped because a settle for an entry that was already dropped must not
	// drive the total negative and hand the cap free headroom.
	if (--state.inflight < 0) state.inflight = 0;
	return entry.epoch === token;
}

/**
 * Cancel every in-flight subscribe for `topic`. Bumping the generation is what
 * makes each outstanding token stale, so a gate that resolves later declines to
 * land.
 *
 * The in-flight total is deliberately NOT decremented here: those gates are
 * still running, still holding an app hook open, and still have to settle. They
 * stop counting when they do.
 *
 * @param {PendingState | undefined} state
 * @param {string} topic
 * @returns {boolean} whether anything was in flight to cancel
 */
export function tombstonePending(state, topic) {
	if (!state) return false;
	const entry = state.topics.get(topic);
	if (!entry || entry.inflight <= 0) return false;
	entry.epoch++;
	return true;
}

/**
 * Subscribes that have entered the authorization gate and not yet landed.
 *
 * @param {PendingState | undefined} state
 * @returns {number}
 */
export function pendingInflight(state) {
	return state ? state.inflight : 0;
}

/**
 * DISTINCT topics with a gate in flight.
 *
 * This is what the per-connection cap counts, not `inflight`. N concurrent
 * subscribes to one topic can only ever install one subscription - the landing
 * short-circuits on `subs.has(topic)` - so charging the cap N times refuses
 * subscribes the connection has every right to make. Also O(1): Map.size.
 *
 * @param {PendingState | undefined} state
 * @returns {number}
 */
export function pendingTopics(state) {
	return state ? state.topics.size : 0;
}
