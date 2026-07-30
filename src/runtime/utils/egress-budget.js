/**
 * A fixed-window byte budget.
 *
 * The control-frame ack channel is inherently amplifying: a client names a topic
 * in a few bytes and is answered with a whole frame, and the per-entry answers
 * cannot be collapsed without breaking the family client. So the CHANNEL is
 * bounded rather than the protocol, and this is the arithmetic that bounds it.
 *
 * A fixed window, not a leaky bucket, and deliberately: the thing being
 * protected is a burst of egress from one socket, and a window that simply
 * restarts after it has elapsed costs two numbers and one comparison per frame.
 * A bucket would refill mid-burst, which is the opposite of what an ack channel
 * wants - a reconnect legitimately spends its whole allowance at once and then
 * goes quiet.
 *
 * The clock is injected for the same reason log-throttle.js injects one: the
 * window boundary is the branch worth testing, and it is untestable against a
 * real clock without waiting out the window.
 *
 * @param {number} limit - bytes allowed per window
 * @param {number} windowMs - how long a window lasts
 * @param {() => number} clock - monotonic milliseconds
 * @returns {(bytes: number) => boolean} false once this window is exhausted
 */
export function createByteBudget(limit, windowMs, clock) {
	let startedAt = -Infinity;
	let used = 0;
	return (bytes) => {
		const now = clock();
		if (now - startedAt > windowMs) {
			startedAt = now;
			used = 0;
		}
		used += bytes;
		// Inclusive: spending exactly the allowance is within it. The charge is
		// recorded even when it is refused, so the caller cannot walk the budget
		// past its limit by retrying with smaller frames.
		return used <= limit;
	};
}
