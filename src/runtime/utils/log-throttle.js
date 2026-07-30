/**
 * Whether one more occurrence of a repeating event deserves a log line.
 *
 * App hooks are called per frame, and a hook that throws on a client-shaped
 * input throws on EVERY frame: `topic.split(':')[1].toLowerCase()` throws for
 * `{"type":"subscribe","topic":"a"}`, and a client can send that in a loop. Each
 * throw was writing an error line plus a full stack trace to stderr, once per
 * frame - and stderr on a container is a synchronous write to the log pipe, so
 * it is event-loop stall and disk fill from a socket that has authenticated to
 * nothing.
 *
 * One-shot latching is the wrong answer here (unlike the config warnings, which
 * describe a static misconfiguration): a hook that starts throwing an hour into
 * a deployment must still be visible, and so must the fact that it is still
 * happening. So: every one of the first nine, then powers of ten. An operator
 * sees the problem immediately, sees that it is ongoing, and the volume is
 * logarithmic in the attacker's effort rather than linear.
 *
 * Pure so the schedule can be tested without a socket or a clock.
 *
 * @param {number} count - occurrences so far INCLUDING this one (1-based)
 * @returns {boolean}
 */
export function shouldLogOccurrence(count) {
	if (!Number.isFinite(count) || count < 1) return false;
	if (count < 10) return true;
	let power = 10;
	// Stops as soon as it meets or passes count, so this is log10(count) steps.
	while (power < count) power *= 10;
	return power === count;
}

/**
 * How long a category must be quiet before its schedule restarts.
 */
const DECAY_MS = 60_000;

/**
 * A throttle that DECAYS.
 *
 * The schedule above is monotonic, and a monotonic counter that never resets is
 * not just throttling - it is attacker-controlled evidence suppression. Roughly
 * 100k cheap frames (seconds of work on any of the lanes a client can drive)
 * pushes the next log line out to occurrence 1,000,000, and because the counters
 * are per-category rather than per-connection, an attacker on one socket
 * silences that category for every other connection on the process. The origin
 * refusal is the sharpest case: its whole reason for existing is that silence
 * there sends operators to `allowedOrigins: 'any'`.
 *
 * Restarting after a quiet window keeps an ONGOING problem visible while still
 * collapsing a burst.
 *
 * @param {() => number} clock - monotonic milliseconds
 * @returns {() => { log: boolean, count: number }}
 */
export function createLogThrottle(clock) {
	let count = 0;
	let last = -Infinity;
	return () => {
		const now = clock();
		if (now - last > DECAY_MS) count = 0;
		last = now;
		count++;
		return { log: shouldLogOccurrence(count), count };
	};
}
