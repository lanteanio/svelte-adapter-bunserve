// Extract the PUBLIC DX surface of svelte-adapter-uws, which leads this
// adapter, and write it to probe/uws-surface.json next to this file. Run with
// `npm run probe:uws`. The manifest is committed, so a uws release that adds,
// renames or removes public API shows up here as a diff - and
// test/unit/api-parity.test.mjs turns that diff into a failing test.
//
// Same contract as probe/bun-api-facts.mjs: this records what the OTHER repo
// declares, never what this one wishes it declared. Interpretation - which gaps
// are deliberate and which are debt - lives in the parity test's allowlists,
// where each entry carries a reason.
//
// uws's index.d.ts is the source of truth rather than its platform.js, because
// the .d.ts IS the published contract: it is what `types` resolves to for every
// consumer, and it distinguishes public API from whatever the implementation
// happens to expose.

import { writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Read a file out of the uws repo AT A COMMIT, never from its working tree.
 *
 * The working tree of a repo under active development is not a contract - a
 * half-finished API in someone's editor would end up recorded here as though it
 * had shipped, and the parity test would then hold this adapter to it. Reading
 * through `git show` pins the manifest to a state that actually exists in
 * history, and the resolved sha goes into the manifest so the provenance is
 * reviewable.
 *
 * @param {string} repo
 * @param {string} ref
 * @param {string} path
 * @returns {string}
 */
function showAtRef(repo, ref, path) {
	try {
		return execFileSync('git', ['show', `${ref}:${path}`], {
			cwd: repo,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024
		});
	} catch (err) {
		throw new Error(
			`could not read ${path} at ${ref} from ${repo}.\n` +
			'Pass a ref that exists (UWS_REF=<sha|tag|branch>); the default is HEAD.\n' +
			String(err.message ?? err)
		);
	}
}

/**
 * Locate the uws checkout. Explicit env var wins; otherwise the sibling
 * directory, which is how both repos sit on a dev machine.
 */
function findUws() {
	const candidates = [
		process.env.UWS_REPO,
		resolve(HERE, '..', '..', 'svelte-adapter-uws')
	].filter(Boolean);
	for (const c of candidates) {
		if (existsSync(join(c, 'src', 'index.d.ts'))) return c;
	}
	throw new Error(
		'svelte-adapter-uws checkout not found. Looked in:\n  ' +
		candidates.join('\n  ') +
		'\nSet UWS_REPO=/path/to/svelte-adapter-uws and re-run.\n' +
		'Refusing to write a manifest without it - an empty manifest would make ' +
		'the parity test pass while proving nothing.'
	);
}

/**
 * Member names declared directly on a top-level `export interface <name>`.
 *
 * Comments and strings are blanked before member detection so prose inside a
 * doc block can never be read as a member, and nested object/function types are
 * skipped by depth so only the interface's own members are collected.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string[]}
 */
export function interfaceMembers(source, name) {
	const header = new RegExp(`export interface ${name}\\s*(<[^>]*>)?\\s*(extends [^{]+)?{`);
	const found = header.exec(source);
	if (!found) throw new Error(`interface ${name} not found in index.d.ts`);
	const open = source.indexOf('{', found.index);

	let depth = 0;
	let end = -1;
	let inBlock = false;
	let inLine = false;
	/** @type {string | null} */
	let inStr = null;
	for (let p = open; p < source.length; p++) {
		const c = source[p];
		const n = source[p + 1];
		if (inLine) {
			if (c === '\n') inLine = false;
			continue;
		}
		if (inBlock) {
			if (c === '*' && n === '/') {
				inBlock = false;
				p++;
			}
			continue;
		}
		if (inStr) {
			if (c === '\\') p++;
			else if (c === inStr) inStr = null;
			continue;
		}
		if (c === '/' && n === '*') {
			inBlock = true;
			p++;
			continue;
		}
		if (c === '/' && n === '/') {
			inLine = true;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			inStr = c;
			continue;
		}
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				end = p;
				break;
			}
		}
	}
	if (end === -1) throw new Error(`interface ${name} is not closed`);

	const scrubbed = source
		.slice(open + 1, end)
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

	const members = new Set();
	let nest = 0;
	for (const line of scrubbed.split('\n')) {
		if (nest === 0) {
			const m = /^\s*(readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??\s*[:(<])/.exec(line);
			if (m) members.add(m[2]);
		}
		for (const ch of line) {
			if (ch === '{' || ch === '(' || ch === '[') nest++;
			else if (ch === '}' || ch === ')' || ch === ']') nest--;
		}
	}
	return [...members].sort();
}

/**
 * The `KNOWN_NESTED_WEBSOCKET_OPTION_KEYS` map uws declares for its own nested
 * validator, as `{ 'path.to.block': [key, ...] }`.
 *
 * Parsed rather than imported for the reason the rest of this file is: reading
 * through `git show` pins the manifest to a commit that exists in history,
 * while importing would take whatever is in someone's working tree.
 *
 * @param {string} source uws's `src/index.js` at the pinned commit
 * @returns {Record<string, string[]>}
 */
function nestedOptionKeys(source) {
	const start = source.indexOf('export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS');
	if (start === -1) throw new Error('uws no longer declares KNOWN_NESTED_WEBSOCKET_OPTION_KEYS; the nested parity dimension needs a new source.');
	const open = source.indexOf('{', start);
	// Balanced scan rather than a regex: the value is an object of `new Set([...])`
	// literals, so the first `}` is nowhere near the end.
	let depth = 0;
	let end = -1;
	for (let i = open; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end === -1) throw new Error('could not find the end of KNOWN_NESTED_WEBSOCKET_OPTION_KEYS.');
	const body = source.slice(open, end + 1);
	/** @type {Record<string, string[]>} */
	const out = {};
	// Each entry is `key: new Set([...])` or `'quoted.key': new Set([...])`.
	const entry = /(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*new Set\(\[([^\]]*)\]\)/g;
	let m;
	while ((m = entry.exec(body)) !== null) {
		const name = m[1] ?? m[2];
		const keys = [...m[3].matchAll(/'([^']+)'/g)].map((k) => k[1]).sort();
		if (keys.length) out[name] = keys;
	}
	if (Object.keys(out).length === 0) throw new Error('parsed no nested option blocks; the declaration shape changed.');
	return out;
}

/**
 * Read a balanced `(...)` argument list starting at the `(` of a call, with
 * quotes and comments respected so a brace or paren inside a message string
 * cannot end the scan early.
 *
 * @param {string} source
 * @param {number} open index of the opening `(`
 * @returns {string} the text between the parentheses
 */
export function callArgs(source, open) {
	let depth = 0;
	/** @type {string | null} */
	let inStr = null;
	let inLine = false;
	let inBlock = false;
	for (let p = open; p < source.length; p++) {
		const c = source[p];
		const n = source[p + 1];
		if (inLine) { if (c === '\n') inLine = false; continue; }
		if (inBlock) { if (c === '*' && n === '/') { inBlock = false; p++; } continue; }
		if (inStr) {
			if (c === '\\') p++;
			else if (c === inStr) inStr = null;
			continue;
		}
		if (c === '/' && n === '*') { inBlock = true; p++; continue; }
		if (c === '/' && n === '/') { inLine = true; continue; }
		if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
		if (c === '(') depth++;
		else if (c === ')') {
			depth--;
			if (depth === 0) return source.slice(open + 1, p);
		}
	}
	throw new Error('unbalanced argument list while reading a protective-number call site');
}

/**
 * The accepted VALUE RANGE of every option uws guards as a protective number.
 *
 * The flat key lists prove both adapters NAME an option. They cannot prove both
 * ACCEPT the same values for it, and that is a real difference: a window whose
 * floor is 0.001 on one adapter and 1 on the other is portable in name and not
 * in fact, so a config builds on one and fails the build on the other. That
 * exact difference reached this repo once, and nothing mechanical could see it
 * - it took a reader comparing two validators side by side.
 *
 * Read from uws's own validator at the pinned commit, for the same reason the
 * nested keys are: it is what uws actually enforces, so the record cannot drift
 * from the behaviour it claims to describe.
 *
 * @param {string} indexSource uws's `src/index.js` at the pinned commit
 * @param {string} guardsSource uws's `src/config-guards.js` at the pinned commit
 * @returns {Record<string, { allowZero: boolean, floor: number, ceiling: number | null, integerRequired: boolean }>}
 */
export function protectiveNumberRanges(indexSource, guardsSource) {
	// The floor rule lives in the guard rather than at the call sites, so it is
	// READ rather than assumed. A release that redefined what `allowZero` means
	// would otherwise be recorded here as though nothing had moved, and every
	// range in this manifest would be wrong in the same direction at once.
	const floorRule = /const floor\s*=\s*allowZero\s*\?\s*(-?[\d.]+)\s*:\s*(-?[\d.]+)\s*;/.exec(guardsSource);
	if (!floorRule) {
		throw new Error(
			'uws no longer derives the protective-number floor from `allowZero`. The range dimension ' +
			'needs a new source - fix the extractor rather than letting it record the old rule.'
		);
	}
	const zeroFloor = Number(floorRule[1]);
	const nonZeroFloor = Number(floorRule[2]);
	// Whether the guard has a ceiling MECHANISM, which is a separate question
	// from whether any call passes one. At the pinned commit there is none, so a
	// `ceiling` that appears later registers as a new mechanism AND a new bound
	// rather than as an option key the guard silently ignores.
	const ceilingSupported = /Number\.isSafeInteger/.test(guardsSource);

	/** @type {Record<string, { allowZero: boolean, floor: number, ceiling: number | null, integerRequired: boolean }>} */
	const out = {};
	const call = /assertProtectiveNumber\s*\(/g;
	let m;
	while ((m = call.exec(indexSource)) !== null) {
		const args = callArgs(indexSource, indexSource.indexOf('(', m.index));
		const key = /^\s*\w+\s*,\s*'([^']+)'/.exec(args);
		// A call whose second argument is not a literal key name is not something
		// this extractor can record, and recording it wrongly is worse than not
		// recording it - so it fails rather than guesses.
		if (!key) {
			throw new Error(
				`a protective-number call site does not name its option as a string literal, so its ` +
				`range cannot be recorded: ${args.slice(0, 120).replace(/\s+/g, ' ')}`
			);
		}
		const allowZero = !/allowZero\s*:\s*false/.test(args);
		const ceilingMatch = /ceiling\s*:\s*(0x[0-9a-fA-F]+|[\d_]+)/.exec(args);
		const ceiling = ceilingMatch ? Number(ceilingMatch[1].replace(/_/g, '')) : null;
		out[key[1]] = {
			allowZero,
			floor: allowZero ? zeroFloor : nonZeroFloor,
			ceiling,
			// uws requires a SAFE INTEGER only where it also imposes a ceiling -
			// the two arrive together in its guard, because the reason for both is
			// the same fixed-width store on the receiving side.
			integerRequired: ceilingSupported && ceiling !== null
		};
	}
	if (Object.keys(out).length === 0) {
		throw new Error('parsed no protective-number call sites; the guard call shape changed.');
	}
	return out;
}

/**
 * Read uws at the pinned commit and write the manifest.
 *
 * SPLIT FROM MODULE SCOPE so this file can be imported without running the
 * probe. The extractors above decide what the parity gate compares, which makes
 * them load-bearing, and an extractor nothing can drive is a manifest nobody
 * checked - the same failure the floors below exist to catch, one level up.
 * Running the file directly is unchanged.
 */
function main() {
	const uwsRoot = findUws();
	const ref = process.env.UWS_REF || 'HEAD';
	const commit = execFileSync('git', ['rev-parse', ref], { cwd: uwsRoot, encoding: 'utf8' }).trim();
	const dts = showAtRef(uwsRoot, commit, 'src/index.d.ts');
	const pkg = JSON.parse(showAtRef(uwsRoot, commit, 'package.json'));
	const schema = showAtRef(uwsRoot, commit, 'protocol.schema.json');
	const indexSource = showAtRef(uwsRoot, commit, 'src/index.js');
	const guardsSource = showAtRef(uwsRoot, commit, 'src/config-guards.js');

	const surface = {
		// Provenance, so a stale or mis-sourced manifest is visible in review. The
		// commit matters as much as the version: it is what makes this reproducible
		// while the uws working tree is mid-change.
		uwsVersion: pkg.version,
		uwsRef: ref,
		uwsCommit: commit,
		// The family protocol schema, recorded as a hash: this repo VENDORS a
		// byte-identical copy at its root (uws is the schema's home; the copy is
		// what ships to consumers and what the runtime reads its protocol
		// revision from), and the parity test compares the committed copy against
		// this hash so the two cannot drift apart silently.
		protocolSchemaSha256: createHash('sha256').update(schema, 'utf8').digest('hex'),
		platform: interfaceMembers(dts, 'Platform'),
		adapterOptions: interfaceMembers(dts, 'AdapterOptions'),
		webSocketOptions: interfaceMembers(dts, 'WebSocketOptions'),
		// The keys INSIDE the nested option blocks, which the flat lists above
		// cannot see. A whole sub-key can be missing here while the top-level name
		// matches on both sides - which is exactly how `upgradeAdmission.waitingRoom`
		// went unnoticed until it turned a working uws config into a build failure.
		//
		// Read from index.js rather than the .d.ts because uws already maintains
		// this as data for its own validator, so recording it costs nothing and
		// cannot drift from what uws actually accepts.
		nestedWebSocketOptions: nestedOptionKeys(indexSource),
		// The accepted VALUE RANGE behind each of those names. Two adapters can
		// declare the same option and disagree about what it accepts, and that
		// disagreement is invisible to every list above: it is a config that builds
		// on one adapter and fails the build on the other, which is the failure the
		// whole parity effort exists to remove.
		protectiveNumbers: protectiveNumberRanges(indexSource, guardsSource),
		exports: Object.keys(pkg.exports ?? {}).sort()
	};

	// Floors, not exact counts: this guards against a parser change silently
	// emitting a degenerate manifest that the parity test would then "pass"
	// against. An assertion that cannot fail is the failure mode this repo keeps
	// re-learning, and a manifest generator is a place it hides well.
	const FLOORS = { platform: 30, adapterOptions: 5, webSocketOptions: 5, exports: 5 };
	for (const [key, floor] of Object.entries(FLOORS)) {
		if (surface[key].length < floor) {
			throw new Error(
				`extracted only ${surface[key].length} ${key} entries from uws (expected at least ` +
				`${floor}). The .d.ts shape probably changed - fix the extractor rather than ` +
				'lowering the floor, and never commit a manifest this small.'
			);
		}
	}

	// The range dimension gets its own floor, because it is an object rather than
	// a list and would sail past the check above as a silent {}. A manifest with no
	// ranges makes the range test vacuous, which is the one outcome worse than not
	// having written it.
	const RANGE_FLOOR = 6;
	const rangeCount = Object.keys(surface.protectiveNumbers).length;
	if (rangeCount < RANGE_FLOOR) {
		throw new Error(
			`extracted only ${rangeCount} protective-number ranges from uws (expected at least ` +
			`${RANGE_FLOOR}). The guard call shape probably changed - fix the extractor rather than ` +
			'lowering the floor.'
		);
	}
	const out = join(HERE, 'uws-surface.json');
	writeFileSync(out, JSON.stringify(surface, null, '\t') + '\n');
	console.log(`uws ${surface.uwsVersion} -> ${out}`);
	for (const key of Object.keys(FLOORS)) console.log(`  ${key}: ${surface[key].length}`);
	console.log(`  protectiveNumbers: ${rangeCount}`);
}

// Only when RUN, never when imported. `process.argv[1]` is the entry script, so
// this compares what node was asked to execute against this module's own URL.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
