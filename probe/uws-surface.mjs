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
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const uwsRoot = findUws();
const ref = process.env.UWS_REF || 'HEAD';
const commit = execFileSync('git', ['rev-parse', ref], { cwd: uwsRoot, encoding: 'utf8' }).trim();
const dts = showAtRef(uwsRoot, commit, 'src/index.d.ts');
const pkg = JSON.parse(showAtRef(uwsRoot, commit, 'package.json'));

const surface = {
	// Provenance, so a stale or mis-sourced manifest is visible in review. The
	// commit matters as much as the version: it is what makes this reproducible
	// while the uws working tree is mid-change.
	uwsVersion: pkg.version,
	uwsRef: ref,
	uwsCommit: commit,
	platform: interfaceMembers(dts, 'Platform'),
	adapterOptions: interfaceMembers(dts, 'AdapterOptions'),
	webSocketOptions: interfaceMembers(dts, 'WebSocketOptions'),
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

const out = join(HERE, 'uws-surface.json');
writeFileSync(out, JSON.stringify(surface, null, '\t') + '\n');
console.log(`uws ${surface.uwsVersion} -> ${out}`);
for (const key of Object.keys(FLOORS)) console.log(`  ${key}: ${surface[key].length}`);
