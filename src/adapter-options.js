// Adapter option validation, split by what is wrong with the option.
//
// The failure this exists for is invisible to the people most likely to hit it.
// A TypeScript user typing `precomress: true` gets a type error before they
// save; someone writing a plain `svelte.config.js` gets NOTHING - the key is
// destructured away, the default applies, and the server runs happily with the
// option they set silently inert. That is a production knob that looks set and
// is not, which is a support ticket measured in hours.
//
// An UNKNOWN KEY warns and never throws. Refusing an unrecognised key would
// break forward compatibility between our own versions - an app pinning an
// older adapter while its config carries a key a newer one added should still
// boot. A warning names it without stopping the build.
//
// An UNUSABLE VALUE on a known key throws, at factory time, saying what the
// option accepts. A value the adapter cannot honour is not a compatibility
// question, and deferring it to boot - or to the first request that needed
// it - moves the failure far away from its cause.

/** Every option the adapter reads. Anything not in here draws a warning. */
export const KNOWN_ADAPTER_OPTIONS = [
	'out',
	'precompress',
	'envPrefix',
	'healthCheckPath',
	'readinessCheckPath',
	'staticCacheMaxFileSize',
	'staticHeaders',
	'websocket'
];

/**
 * Edit distance, bounded by an early exit. Only used to suggest a correction
 * for a misspelled option name, so it never runs on anything but two short
 * identifiers.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
	if (a === b) return 0;
	/** @type {number[]} */
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(
				prev[j] + 1,
				row[j - 1] + 1,
				prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
			);
		}
		prev = row;
	}
	return prev[b.length];
}

/**
 * The known option closest to `name`, when one is close enough to be worth
 * suggesting. The threshold scales with the name's length so a short key does
 * not match half the list, and a case-only difference always wins - that is the
 * single most common way this option surface is mistyped.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
export function suggestOption(name) {
	const lower = name.toLowerCase();
	const caseMatch = KNOWN_ADAPTER_OPTIONS.find((k) => k.toLowerCase() === lower);
	if (caseMatch) return caseMatch;
	const limit = name.length <= 6 ? 2 : 3;
	let best;
	let bestDistance = Infinity;
	for (const known of KNOWN_ADAPTER_OPTIONS) {
		const d = editDistance(lower, known.toLowerCase());
		if (d < bestDistance) {
			bestDistance = d;
			best = known;
		}
	}
	return bestDistance <= limit ? best : undefined;
}

/**
 * The unknown-key half. Returns a warning line per unrecognised top-level key,
 * so the caller can route them through the builder's logger. Returns an empty
 * array for a clean config, and never throws.
 *
 * @param {Record<string, unknown>} opts
 * @returns {string[]}
 */
export function unknownOptionWarnings(opts) {
	if (!opts || typeof opts !== 'object') return [];
	const warnings = [];
	for (const key of Object.keys(opts)) {
		if (KNOWN_ADAPTER_OPTIONS.includes(key)) continue;
		const suggestion = suggestOption(key);
		warnings.push(
			`adapter-bunserve: unknown option \`${key}\`, which the adapter does not read - it is having no effect.` +
			(suggestion ? ` Did you mean \`${suggestion}\`?` : '')
		);
	}
	return warnings;
}

/**
 * The unusable-value half, for the plainly-typed options. The ones with real shapes
 * (`websocket`, `staticHeaders`) have their own normalizers; this covers the
 * scalars, whose wrong values are the ones that fail quietly. A string given to
 * a boolean is the worst case in the set: `precompress: 'no'` is truthy, so the
 * option reads as ON while its author plainly meant OFF.
 *
 * @param {Record<string, unknown>} opts
 * @throws {Error} on the first unusable value
 */
export function assertScalarOptions(opts) {
	if (!opts || typeof opts !== 'object') return;

	for (const key of ['precompress']) {
		if (key in opts && typeof opts[key] !== 'boolean') {
			throw new Error(
				`adapter option \`${key}\` must be true or false - got ${JSON.stringify(opts[key])}. ` +
				'A non-boolean is not coerced: a string like "no" is truthy, so the option would read ' +
				'as enabled while plainly meaning the opposite.'
			);
		}
	}

	for (const key of ['out', 'envPrefix']) {
		if (key in opts && typeof opts[key] !== 'string') {
			throw new Error(
				`adapter option \`${key}\` must be a string - got ${JSON.stringify(opts[key])}.`
			);
		}
	}

	// Liveness path, held to the rule the readiness path already states. A path
	// without the leading slash can never match: the pathname compared against
	// it always starts with one, so the probe silently 404s forever.
	if ('healthCheckPath' in opts && opts.healthCheckPath !== false) {
		const value = opts.healthCheckPath;
		if (typeof value !== 'string' || value[0] !== '/') {
			throw new Error(
				`adapter option \`healthCheckPath\` must be an absolute path string starting with '/' ` +
				`(e.g. '/healthz'), or false to disable the liveness route - got ${JSON.stringify(value)}.`
			);
		}
	}
}
