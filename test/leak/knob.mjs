/**
 * Every tuning knob this lane reads goes through here, and it lives in its own
 * file because BOTH the runner and the harness read the same variables: the
 * runner derives its step timeout from the windows, the harness runs them. A
 * second copy of this parsing is how one of them ends up validating and the
 * other quietly producing NaN.
 *
 * A mistyped value - `LEAK_DURATION_MS=60s` - would otherwise become NaN and
 * then, depending on which side read it, either hand the verdict an empty
 * sample set to be satisfied by or set a step timeout of one millisecond.
 *
 * @param {string} name
 * @param {number} fallback
 */
export function knob(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name}=${JSON.stringify(raw)} is not a positive number`);
	}
	return value;
}
