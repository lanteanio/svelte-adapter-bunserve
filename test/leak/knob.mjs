/**
 * How the leak lane reads its command-line flags. `plan.mjs` is the only
 * caller: every flag is parsed there, once, so that the runner and the gate
 * cannot end up with different ideas of what the same flag meant.
 *
 * The named flags are `--minutes`, `--scenario` and `--out`. Both
 * `--name value` and `--name=value` are accepted. The first occurrence of a
 * flag supplies its value; later occurrences do not override it.
 * Invalid first values are refused before the runner starts a fixture build.
 */

/**
 * Every `--name` token in argv with its value, or a description of what is
 * wrong with them.
 *
 * @param {string[]} argv the arguments after the script name
 * @returns {Map<string, string>}
 */
export function parseFlags(argv) {
	/** @type {Map<string, string>} */
	const flags = new Map();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith('--')) {
			throw new Error(`unexpected argument ${JSON.stringify(token)}; flags are --minutes, --scenario and --out`);
		}
		const eq = token.indexOf('=');
		const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
		if (flags.has(name)) {
			if (eq < 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++;
			continue;
		}
		let value;
		if (eq >= 0) {
			value = token.slice(eq + 1);
		} else {
			value = argv[i + 1];
			// A flag given as the LAST argument, or followed by another flag, has
			// no value: `--out --minutes 2` would otherwise write the record into
			// a directory called `--minutes` and measure for the default window,
			// which is two surprises for one typo.
			if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
			i++;
		}
		// Trimmed, so a value quoted with a stray space in a CI matrix does not
		// name a scenario or a directory nobody meant.
		flags.set(name, value.trim());
	}
	return flags;
}

/**
 * Refuse a flag the lane does not know. A mistyped flag name would otherwise
 * be ignored in silence and the lane would run its defaults, which for
 * `--scenarios ws` means three scenarios for nine minutes instead of one for
 * three.
 *
 * @param {Map<string, string>} flags
 * @param {string[]} known
 */
export function refuseUnknownFlags(flags, known) {
	for (const name of flags.keys()) {
		if (!known.includes(name)) {
			throw new Error(`unknown flag --${name}; flags are ${known.map((k) => '--' + k).join(', ')}`);
		}
	}
}

/**
 * @param {Map<string, string>} flags
 * @param {string} name
 * @param {number} fallback used when the flag is absent
 * @param {{ min?: number, max?: number, integer?: boolean }} [range]
 *   `min` defaults to 1. Values outside the inclusive range are refused.
 * @returns {number}
 */
export function numberFlag(flags, name, fallback, range = {}) {
	const { min = 1, max = Number.MAX_SAFE_INTEGER, integer = false } = range;
	const raw = flags.get(name);
	if (raw === undefined) return fallback;
	// Empty is refused rather than defaulted: `--minutes=${VAR}` with the
	// variable unset would otherwise measure the default window and report it
	// as the one asked for.
	if (raw === '') throw new Error(`--${name} needs a value`);
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`--${name} ${JSON.stringify(raw)} is not a number`);
	}
	if (integer && !Number.isInteger(value)) {
		throw new Error(`--${name} ${JSON.stringify(raw)} must be a whole number`);
	}
	if (value < min || value > max) {
		throw new Error(`--${name} ${JSON.stringify(raw)} is out of range; expected ${min}..${max}`);
	}
	return value;
}

/**
 * @param {Map<string, string>} flags
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
export function stringFlag(flags, name, fallback) {
	const raw = flags.get(name);
	if (raw === undefined) return fallback;
	if (raw === '') throw new Error(`--${name} needs a value`);
	return raw;
}

/**
 * The largest delay `setTimeout`/`setInterval` accept. Beyond it the delay does
 * not saturate - it overflows the 32-bit field and is re-clamped to ONE
 * millisecond, so an over-large delay fires immediately rather than late. That
 * is the same shape of failure as a NaN delay, reached through a different
 * door, so the lane refuses it in the same place.
 *
 * The window is a loop bound rather than a delay, and carries this for a
 * second-order reason: `plan.mjs` SUMS it into the runner's step timeout,
 * which is a delay.
 */
export const TIMER_MAX_MS = 2_147_483_647;
