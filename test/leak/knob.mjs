/**
 * How the leak lane turns an environment variable into a number. `plan.mjs` is
 * the only caller: every knob is parsed there, once, so that the runner and the
 * gate cannot end up with different ideas of what the same variable meant.
 *
 * What this refuses is the reason it exists. `Number('60s')` is NaN, and a NaN
 * is not a small value - it is a value that behaves differently everywhere it
 * lands: an unfittable window in one place, a one-millisecond timeout in
 * another. Refusing at the parse is what keeps that from becoming a lane that
 * fails in a way nobody can read.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number, max?: number, integer?: boolean }} [range]
 *   `min` defaults to 1. Pass `{ min: 0 }` for the phase knobs that may be
 *   switched OFF - a zero cooldown or a zero resettle is a legitimate thing to
 *   ask for, and `plan.mjs` documents a measurement reproduced by setting
 *   `LEAK_RESETTLE_MS=0`.
 * @returns {number} the parsed value, or `fallback` when unset or blank
 */
export function knob(name, fallback, range = {}) {
	const { min = 1, max = Number.MAX_SAFE_INTEGER, integer = false } = range;
	// Trimmed BEFORE the blank test, because `Number('  ')` is 0 rather than
	// NaN: a trailing space in a CI env file would otherwise pass validation on
	// the knobs that allow zero and quietly switch that phase off.
	const raw = process.env[name]?.trim();
	// Blank is unset. This is what the `Number(process.env.X || default)`
	// spelling did before, and it is what the lane's own build env means when
	// it passes `NO_WS: ''`.
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`${name}=${JSON.stringify(raw)} is not a number`);
	}
	if (integer && !Number.isInteger(value)) {
		throw new Error(`${name}=${JSON.stringify(raw)} must be a whole number`);
	}
	// Bounds are named in the message. "not a positive number" for a deliberate
	// `0` reads as a parse failure and sends the reader looking for a typo.
	if (value < min || value > max) {
		throw new Error(`${name}=${JSON.stringify(raw)} is out of range; expected ${min} to ${max}`);
	}
	return value;
}

/**
 * The largest delay `setTimeout`/`setInterval` accept. Beyond it the delay does
 * not saturate - it overflows the 32-bit field and is re-clamped to ONE
 * millisecond, so an over-large delay fires immediately rather than late. That
 * is the same shape of failure as a NaN delay, reached through a different
 * door, so the lane refuses it in the same place.
 *
 * Two knobs reach a timer directly - the cooldown sleeps and the sample cadence
 * drives an interval. The windows are loop bounds rather than delays, and carry
 * this for a second-order reason: `plan.mjs` SUMS them into the runner's step
 * timeout, which is a delay.
 */
export const TIMER_MAX_MS = 2_147_483_647;
