// Concatenated, never passed as a base: `new URL('//upload/big', base)` reads
// `upload` as an authority and `/big` as the path, while SvelteKit is handed
// the whole target as a path.
const BUDGET_ORIGIN = 'http://body-limit.invalid';

/** Canonical pathname used only for conservative transport-budget matching. */
function canonicalPath(target) {
	// Match both URL normalization and SvelteKit's decoded route segments.
	const path = new URL(BUDGET_ORIGIN + target).pathname;
	return decodeURIComponent(path).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/** Validate data-only rules at build time and again when the runtime starts. */
export function normalizeBodyLimits(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new TypeError('bodyLimits must be an array');
	return value.map((rule) => {
		if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
			Object.keys(rule).some(key => !['path', 'prefix', 'methods', 'bytes'].includes(key))) {
			throw new TypeError('bodyLimits rules accept path, prefix, methods and bytes');
		}
		if (typeof rule.path !== 'string' || !rule.path.startsWith('/') ||
			rule.path.startsWith('//') || /[?#%\\\s]/.test(rule.path) ||
			rule.path.split('/').some(part => part === '.' || part === '..')) {
			throw new TypeError('bodyLimits.path must be an absolute decoded pathname without query, fragment or dot segments');
		}
		if (rule.prefix !== undefined && typeof rule.prefix !== 'boolean') throw new TypeError('bodyLimits.prefix must be boolean');
		if (!Number.isSafeInteger(rule.bytes) || rule.bytes < 0) throw new TypeError('bodyLimits.bytes must be a nonnegative safe integer');
		if (rule.methods !== undefined && (!Array.isArray(rule.methods) || rule.methods.length === 0 ||
			!rule.methods.every(method => typeof method === 'string' && /^[A-Z]+$/.test(method)))) {
			throw new TypeError('bodyLimits.methods must be a nonempty array of uppercase HTTP methods');
		}
		// The transport never reads a GET or HEAD body, so a rule for either
		// could never apply.
		if (rule.methods !== undefined && rule.methods.some(method => method === 'GET' || method === 'HEAD')) {
			throw new TypeError('bodyLimits.methods cannot name GET or HEAD: their bodies are never read');
		}
		return { path: canonicalPath(rule.path), prefix: rule.prefix === true, bytes: rule.bytes,
			...(rule.methods === undefined ? {} : { methods: [...new Set(rule.methods)] }) };
	});
}

/**
 * The normalized rules as the source text the build substitutes. The build
 * replaces the placeholder everywhere in the runtime file, its `global`
 * comment included, so a `*` and `/` adjacent in a path would end that
 * comment early; `\/` is the same character inside a JSON or JS string.
 */
export function serializeBodyLimits(rules) {
	return JSON.stringify(rules).replaceAll('*/', '*\\/');
}

/** Every matching rule narrows the ceiling; a large-upload rule never raises it. */
export function requestBodyLimit(rules, method, target, ceiling) {
	if (rules.length === 0) return ceiling;
	let path;
	try { path = canonicalPath(target); } catch { return 0; }
	let limit = ceiling;
	for (const rule of rules) {
		if (rule.methods && !rule.methods.includes(method)) continue;
		if (path === rule.path || (rule.prefix && (rule.path === '/' || path.startsWith(rule.path + '/')))) {
			limit = Math.min(limit, rule.bytes);
		}
	}
	return limit;
}
