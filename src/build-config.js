// Build-time configuration helpers for the adapter. Pure and dependency-free
// (no SvelteKit builder, no filesystem, no placeholder imports) so they are
// unit-testable in isolation - the build flow in index.js wires their output
// into the placeholder replace map.

import path from 'node:path';
import { RESERVED_STATIC_HEADER_KEYS } from './runtime/utils/static-headers.js';
import { readableCopy } from './runtime/utils/ws-options.js';

// RFC 7230 token charset - the legal alphabet for a header NAME.
const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * True when the value contains a C0 control character or DEL (CR/LF
 * injection included). A control character in a header value would make
 * Headers construction throw on EVERY static request at runtime; the build
 * must fail instead. charCode loop rather than a regex so the source stays
 * plain ASCII.
 * @param {string} value
 * @returns {boolean}
 */
function hasControlChar(value) {
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}

/**
 * @typedef {Object} NormalizedStaticHeaders
 * @property {Record<string, string> | null} headers - lowercased, reserved keys
 *   removed; `null` when nothing usable remains (so the placeholder serializes
 *   to `null` and the runtime merge is a no-op).
 * @property {string[]} dropped - reserved keys that were removed, for a
 *   build-time warning.
 */

/**
 * Validate and normalize the top-level `staticHeaders` adapter option. Throws
 * on a misshaped value (so the misconfig fails the build loudly) and strips
 * reserved transfer/caching headers the static handler manages itself.
 *
 * @param {unknown} input - the raw `staticHeaders` option value
 * @returns {NormalizedStaticHeaders}
 */
export function normalizeStaticHeaders(input) {
	if (input == null) return { headers: null, dropped: [] };
	// The copy comes before any inspection: Array.isArray and every key read
	// throw natively on a value that will not be read - a revoked Proxy, a
	// throwing getter - before the refusal below could name the option. A
	// value that cannot be read copies to null and is refused the same way.
	const copied = typeof input === 'object' ? readableCopy(input) : null;
	if (copied === null || Array.isArray(copied)) {
		throw new Error(
			"adapter option `staticHeaders` must be an object of string header values, " +
			"e.g. { 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' }."
		);
	}
	input = copied;
	/** @type {Record<string, string>} */
	const headers = {};
	/** @type {string[]} */
	const dropped = [];
	for (const rawKey of Object.keys(/** @type {Record<string, unknown>} */ (input))) {
		const value = /** @type {Record<string, unknown>} */ (input)[rawKey];
		if (typeof value !== 'string') {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` must be a string, got ${typeof value}.`
			);
		}
		if (!HEADER_NAME_TOKEN.test(rawKey)) {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` has an illegal header name - ` +
				"names must be RFC 7230 tokens (letters, digits, and !#$%&'*+.^_`|~-)."
			);
		}
		if (hasControlChar(value)) {
			throw new Error(
				`adapter option \`staticHeaders['${rawKey}']\` contains a control character - ` +
				'header values must be single-line printable text.'
			);
		}
		const key = rawKey.toLowerCase();
		if (RESERVED_STATIC_HEADER_KEYS.has(key)) {
			dropped.push(key);
			continue;
		}
		headers[key] = value;
	}
	return { headers: Object.keys(headers).length ? headers : null, dropped };
}

/**
 * What to tell the developer about imports the server bundle could not
 * resolve, judged by where each importer lives. The WebSocket handler's own
 * graph is read straight from project source with no Vite pass, so a
 * SvelteKit virtual module cannot resolve there. A file SvelteKit's server
 * build wrote - its own output, or a `__` entry a Vite plugin added to it -
 * has been through Vite already, and so has nothing a dependency ships, so
 * what is missing there is a package.
 *
 * @param {string[]} importers - each unresolved import's importer, as Rollup
 *   reports it (an absolute path, or 'unknown')
 * @param {string[]} serverOutputDirs - the server output directory under every
 *   spelling an importer can carry (as given, and its real path)
 * @returns {string[]} one paragraph per cause present, handler advice first
 */
export function unresolvedImportAdvice(importers, serverOutputDirs) {
	/** @param {string} file */
	const missingPackage = (file) =>
		file.split(/[\\/]/).includes('node_modules') ||
		serverOutputDirs.some((dir) => {
			const rel = path.relative(dir, file);
			return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
		});
	const advice = [];
	if (importers.some((file) => !missingPackage(file))) {
		advice.push(
			'The WebSocket handler is bundled straight from project source with no Vite ' +
			"pass, so SvelteKit's virtual modules ($app/*, $env/*) are not available to it. " +
			'Install the svelte-adapter-bunserve/vite build plugin, read process.env, or move code using those ' +
			'modules into a file the SvelteKit server bundle already includes and import it from there.'
		);
	}
	if (importers.some(missingPackage)) {
		advice.push(
			"SvelteKit's server build, a __ entry a Vite plugin added to it, or a dependency imports a " +
			'package that cannot be found from this project: install the package it names.'
		);
	}
	return advice;
}

/**
 * Validate and normalize path-specific Cache-Control rules. A rule without a
 * trailing slash matches one exact asset path; a trailing slash matches that
 * directory tree. Patterns are relative to SvelteKit's configured base path.
 *
 * @param {unknown} input - the raw `staticCacheControl` option value
 * @returns {{ pattern: string, cacheControl: string }[] | null}
 */
export function normalizeStaticCacheControl(input) {
	if (input == null) return null;
	if (!Array.isArray(input)) {
		throw new Error(
			"adapter option `staticCacheControl` must be an array of { pattern, cacheControl } rules."
		);
	}

	/** @type {{ pattern: string, cacheControl: string }[]} */
	const rules = [];
	const seen = new Set();
	for (let index = 0; index < input.length; index++) {
		const rule = input[index];
		if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
			throw new Error(`adapter option \`staticCacheControl[${index}]\` must be an object.`);
		}

		const record = /** @type {Record<string, unknown>} */ (rule);
		const unknown = Object.keys(record).filter((key) => key !== 'pattern' && key !== 'cacheControl');
		if (unknown.length) {
			throw new Error(
				`adapter option \`staticCacheControl[${index}]\` has unknown key(s): ${unknown.join(', ')}.`
			);
		}

		const pattern = record.pattern;
		if (typeof pattern !== 'string' || pattern[0] !== '/' ||
			/[\\?#*\u0000-\u001f\u007f]/.test(pattern) || /(^|\/)\.{1,2}(\/|$)/.test(pattern)) {
			throw new Error(
				`adapter option \`staticCacheControl[${index}].pattern\` must be an absolute, ` +
				"literal, query-free asset path such as '/fonts/' or '/logo.v2.svg'."
			);
		}
		if (seen.has(pattern)) {
			throw new Error(`adapter option \`staticCacheControl\` contains duplicate pattern '${pattern}'.`);
		}

		const cacheControl = record.cacheControl;
		if (typeof cacheControl !== 'string' || !cacheControl.trim() || /[\u0000-\u001f\u007f]/.test(cacheControl)) {
			throw new Error(
				`adapter option \`staticCacheControl[${index}].cacheControl\` must be a non-empty, single-line string.`
			);
		}

		seen.add(pattern);
		rules.push({ pattern, cacheControl: cacheControl.trim() });
	}

	// Resolve the most specific directory first regardless of declaration order.
	rules.sort((left, right) => right.pattern.length - left.pattern.length);
	return rules.length ? rules : null;
}
