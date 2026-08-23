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

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
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
			'Pass a ref that exists (UWS_REF=<sha|tag|branch>); the default is the commit the ' +
			'committed manifest already names, so a checkout missing that commit needs a fetch.\n' +
			String(err.message ?? err)
		);
	}
}

/**
 * The commit the committed manifest already names, which is what a regeneration
 * defaults to reading.
 *
 * Returns `null` before the manifest exists, or when what it carries is not a
 * full sha - the two cases where there is no pin to honour and following the
 * checkout is the only thing left to do.
 *
 * @returns {string | null}
 */
export function pinnedRef() {
	const at = join(HERE, 'uws-surface.json');
	if (!existsSync(at)) return null;
	try {
		const { uwsCommit } = JSON.parse(readFileSync(at, 'utf8'));
		// A full sha only. A branch or a tag can be moved under this adapter by
		// someone else's push, which is the thing being fixed rather than a
		// shorter spelling of it.
		return typeof uwsCommit === 'string' && /^[0-9a-f]{40}$/.test(uwsCommit) ? uwsCommit : null;
	} catch {
		return null;
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
 * Blank every comment and every string BODY, leaving code at its own offsets.
 *
 * Every extractor below asks the same question of uws's source: does this text
 * state a rule the build actually enforces? Text alone cannot answer it. uws
 * writes operator-facing prose into its own option values and its own comments,
 * and that prose says things like `allowZero: false` and quotes the sentences
 * its guards throw - so a regex over raw source reads a comment describing a
 * bound as though it were the bound. The manifest that results does not fail:
 * it states a contract the parity tests then agree with, and every one of them
 * passes.
 *
 * So the position is established first and the text is read second. Offsets,
 * lengths and newlines are preserved exactly, which is what lets a match found
 * in the blanked copy be sliced out of the original: the blanked copy proves
 * WHERE something sits, the original says WHAT it is.
 *
 * Quote characters survive and their contents do not, because a string literal
 * is still a value in the code - `('name', {...})` has to keep its shape - while
 * what is written inside it is prose. Comments go entirely; they are not code.
 * A template literal's `${...}` is blanked with the rest of its body, which
 * loses code positions rather than inventing them: the failure that leaves is a
 * rule read as absent, never a rule invented from prose.
 *
 * REGULAR EXPRESSION LITERALS ARE PART OF THIS, not a refinement of it. uws
 * matches header names with patterns like `/['"`]\s*set-cookie\s*['"`]/i`, and
 * a scanner that does not know a regex when it sees one reads that backtick as
 * the start of a template literal and blanks every line after it. The file then
 * yields no call sites at all - which this extractor does report, loudly, but
 * only because it counts what it found. Telling a regex from a division needs
 * the token before it, so that is tracked.
 *
 * @param {string} source
 * @returns {string} same length, same newlines, non-code blanked to spaces
 */
export function blankNonCode(source) {
	const out = source.split('');
	const word = /[\w$]/;
	// A `/` after a value is division; after one of these it can only begin a
	// pattern.
	const beforePattern = new Set([
		'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
		'void', 'throw', 'case', 'do', 'else', 'yield', 'await'
	]);
	// Bounded because an escape can be the last character in the file: writing
	// one past the end would append rather than overwrite, and every offset after
	// it would be a character out - which is the one thing callers rely on.
	const blank = (p) => {
		if (p < source.length && source[p] !== '\n') out[p] = ' ';
	};

	/** @type {string | null} */
	let inStr = null;
	let inLine = false;
	let inBlock = false;
	// The last character that was code and not whitespace, which is the only
	// thing that distinguishes `a / b` from `replace(/b/, ...)`.
	let prev = -1;

	for (let p = 0; p < source.length; p++) {
		const c = source[p];
		const n = source[p + 1];
		if (inLine) {
			if (c === '\n') inLine = false;
			else blank(p);
			continue;
		}
		if (inBlock) {
			blank(p);
			if (c === '*' && n === '/') {
				blank(p + 1);
				p++;
				inBlock = false;
			}
			continue;
		}
		if (inStr) {
			// The escape and the character it escapes both go, so an escaped
			// quote cannot be read as the end of the literal.
			if (c === '\\') {
				blank(p);
				blank(p + 1);
				p++;
				continue;
			}
			if (c === inStr) {
				inStr = null;
				prev = p;
			} else blank(p);
			continue;
		}
		if (c === '/' && n === '*') {
			blank(p);
			blank(p + 1);
			p++;
			inBlock = true;
			continue;
		}
		if (c === '/' && n === '/') {
			blank(p);
			blank(p + 1);
			p++;
			inLine = true;
			continue;
		}
		if (c === '/') {
			let pattern = true;
			if (prev >= 0) {
				const pc = source[prev];
				if (pc === ')' || pc === ']' || word.test(pc)) {
					pattern = false;
					if (word.test(pc)) {
						let s = prev;
						while (s > 0 && word.test(source[s - 1])) s--;
						if (beforePattern.has(source.slice(s, prev + 1))) pattern = true;
					}
				}
			}
			const end = pattern ? patternEnd(source, p) : -1;
			if (end !== -1) {
				for (let i = p + 1; i < end; i++) blank(i);
				p = end;
				prev = end;
				continue;
			}
		}
		if (c === '"' || c === "'" || c === '`') {
			inStr = c;
			continue;
		}
		if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prev = p;
	}
	return out.join('');
}

/**
 * The index of the `/` closing a regular expression literal opened at `open`,
 * or -1 when it does not close on its line - in which case it was a division
 * sign and not a pattern at all.
 *
 * @param {string} source
 * @param {number} open
 * @returns {number}
 */
function patternEnd(source, open) {
	let inClass = false;
	for (let p = open + 1; p < source.length; p++) {
		const c = source[p];
		if (c === '\\') {
			p++;
			continue;
		}
		if (c === '\n') return -1;
		if (inClass) {
			if (c === ']') inClass = false;
		} else if (c === '[') inClass = true;
		else if (c === '/') return p;
	}
	return -1;
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
	// Member names are identifiers, so the blanked copy carries everything this
	// reads. A string literal type spanning lines cannot fabricate a member and
	// a `//` inside one cannot blank the rest of a real declaration.
	const code = blankNonCode(source);
	const header = new RegExp(`export interface ${name}\\s*(<[^>]*>)?\\s*(extends [^{]+)?{`);
	const found = header.exec(code);
	if (!found) throw new Error(`interface ${name} not found in index.d.ts`);
	const open = code.indexOf('{', found.index);

	let depth = 0;
	let end = -1;
	for (let p = open; p < code.length; p++) {
		const c = code[p];
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

	const scrubbed = code.slice(open + 1, end);

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
export function nestedOptionKeys(source) {
	const code = blankNonCode(source);
	const start = code.indexOf('export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS');
	if (start === -1) throw new Error('uws no longer declares KNOWN_NESTED_WEBSOCKET_OPTION_KEYS; the nested parity dimension needs a new source.');
	const open = code.indexOf('{', start);
	// Balanced scan rather than a regex: the value is an object of `new Set([...])`
	// literals, so the first `}` is nowhere near the end. Scanned over the blanked
	// copy so a brace inside prose cannot end the declaration early.
	let depth = 0;
	let end = -1;
	for (let i = open; i < code.length; i++) {
		if (code[i] === '{') depth++;
		else if (code[i] === '}') {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end === -1) throw new Error('could not find the end of KNOWN_NESTED_WEBSOCKET_OPTION_KEYS.');
	const codeBody = code.slice(open, end + 1);
	const rawBody = source.slice(open, end + 1);
	/** @type {Record<string, string[]>} */
	const out = {};
	// Each entry is `key: new Set([...])` or `'quoted.key': new Set([...])`. The
	// entry SHAPE is matched in the blanked body, so only a real declaration is
	// read; the names and keys are then sliced out of the original at the offsets
	// that match found, because those are the one thing the blanking removes.
	const entry = /(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*new Set\(\[([^\]]*)\]\)/dg;
	let m;
	while ((m = entry.exec(codeBody)) !== null) {
		const quoted = m.indices[1];
		const name = quoted ? rawBody.slice(quoted[0], quoted[1]) : m[2];
		// The keys are found in the BLANKED bracket span and only then read out of
		// the original. Slicing the raw span and matching quotes there would count
		// a key that had been commented out INSIDE the brackets - the removal
		// still reads as a declaration, so a key uws deleted survives in the
		// manifest as one it still accepts.
		const [ks, ke] = m.indices[3];
		const keys = [...codeBody.slice(ks, ke).matchAll(/'([^']+)'/dg)]
			.map((k) => rawBody.slice(ks + k.indices[1][0], ks + k.indices[1][1]))
			.sort();
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
 * The `{...}` body of a named function declaration, or `null` when the source
 * does not declare one.
 *
 * Read so a rule can be looked for INSIDE the guard that implements it. These
 * modules validate a dozen options apiece, and the same words - a floor, a safe
 * integer, a comparison - appear in all of them, so a file-wide match answers a
 * question about a different option than the one being asked about.
 *
 * @param {string} code source with comments and string bodies blanked
 * @param {string} name the declared function
 * @returns {string | null}
 */
function functionBody(code, name) {
	const at = code.search(new RegExp(`function\\s+${name}\\s*\\(`));
	if (at === -1) return null;
	// Past the parameter list first: it carries its own braces (a destructured
	// options argument) and a `)` cannot be assumed to be the first one.
	const open = code.indexOf('(', at);
	const brace = code.indexOf('{', open + 1 + callArgs(code, open).length);
	if (brace === -1) return null;
	let depth = 0;
	for (let p = brace; p < code.length; p++) {
		if (code[p] === '{') depth++;
		else if (code[p] === '}') {
			depth--;
			if (depth === 0) return code.slice(brace, p + 1);
		}
	}
	return null;
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
	// Read against code, never against prose. uws documents this guard at length
	// in the comments above it and writes operator-facing text into the options
	// it validates, so raw source offers several convincing places to find a rule
	// that nothing runs.
	const guardsCode = blankNonCode(guardsSource);
	const indexCode = blankNonCode(indexSource);
	// And read inside the GUARD, not across the file. Every rule below is a
	// property of one function, so a match anywhere else in a module that
	// validates a dozen other options says nothing about this one.
	const body = functionBody(guardsCode, 'assertProtectiveNumber');
	if (!body) {
		throw new Error(
			'uws no longer declares assertProtectiveNumber as a function, so the protective-number ' +
			'ranges have no source. Fix the extractor rather than recording the last rule it read.'
		);
	}
	const floorRule = /const floor\s*=\s*allowZero\s*\?\s*(-?[\d.]+)\s*:\s*(-?[\d.]+)\s*;/.exec(body);
	if (!floorRule) {
		throw new Error(
			'uws no longer derives the protective-number floor from `allowZero`. The range dimension ' +
			'needs a new source - fix the extractor rather than letting it record the old rule.'
		);
	}
	const zeroFloor = Number(floorRule[1]);
	const nonZeroFloor = Number(floorRule[2]);
	// Whether the guard ENFORCES a ceiling, which is a different question from
	// whether the word appears anywhere near one. The mechanism is three things
	// together - the branch is entered only for a ceiling that was passed, the
	// value is compared against it, and the safe-integer rule rides along - and
	// the whole point of naming all three is that the presence of any one of them
	// proves nothing. `Number.isSafeInteger` in particular is an ordinary thing
	// for a validator to use elsewhere, so treating it as the signal reads a
	// ceiling into a guard that stopped comparing against one.
	//
	// The direction of that error is why it is worth this much care. A ceiling
	// recorded but not enforced makes the manifest STRICTER than uws, and the
	// parity gate then holds this adapter to a bound uws does not have - so this
	// adapter refuses a config that builds there. That is a failure invented
	// here rather than found, and it fails in the one direction the never-looser
	// test cannot see, because it is not looser.
	const enforcement = body.replace(/\s+/g, '');
	const ceilingEnforced =
		enforcement.includes('ceiling>0') &&
		enforcement.includes('value>ceiling') &&
		enforcement.includes('Number.isSafeInteger(value)');

	/** @type {Record<string, { allowZero: boolean, floor: number, ceiling: number | null, integerRequired: boolean }>} */
	const out = {};
	const call = /assertProtectiveNumber\s*\(/g;
	let m;
	while ((m = call.exec(indexCode)) !== null) {
		const open = indexCode.indexOf('(', m.index);
		// Two views of the same span: the blanked one to decide what the call
		// PASSES, the original to read the option name it passes.
		const args = callArgs(indexCode, open);
		const rawArgs = callArgs(indexSource, open);
		const key = /^\s*\w+\s*,\s*'([^']+)'/d.exec(args);
		// A call whose second argument is not a literal key name is not something
		// this extractor can record, and recording it wrongly is worse than not
		// recording it - so it fails rather than guesses.
		if (!key) {
			throw new Error(
				`a protective-number call site does not name its option as a string literal, so its ` +
				`range cannot be recorded: ${rawArgs.slice(0, 120).replace(/\s+/g, ' ')}`
			);
		}
		const [nameStart, nameEnd] = key.indices[1];
		const name = rawArgs.slice(nameStart, nameEnd);
		const allowZero = !/allowZero\s*:\s*false/.test(args);
		// A ceiling the guard does not compare against is an argument that goes
		// nowhere, so it is recorded as the nothing it enforces.
		const ceilingMatch = ceilingEnforced
			? /ceiling\s*:\s*(0x[0-9a-fA-F]+|[\d_]+)/.exec(args)
			: null;
		const ceiling = ceilingMatch ? Number(ceilingMatch[1].replace(/_/g, '')) : null;
		out[name] = {
			allowZero,
			floor: allowZero ? zeroFloor : nonZeroFloor,
			ceiling,
			// uws requires a SAFE INTEGER only where it also imposes a ceiling -
			// the two arrive together in its guard, because the reason for both is
			// the same fixed-width store on the receiving side. A ceiling survives
			// above only when the guard enforces it, so this follows from it.
			integerRequired: ceiling !== null
		};
	}
	if (Object.keys(out).length === 0) {
		throw new Error('parsed no protective-number call sites; the guard call shape changed.');
	}
	return out;
}

/**
 * The accepted range of each `upgradeAdmission` sub-key, read from the gate uws
 * builds rather than from the config guard.
 *
 * A SECOND SOURCE, because uws validates these in a different place from the
 * options above: the top-level protective numbers are asserted while the config
 * is read, and these four are asserted inside `createUpgradeAdmission`. That
 * split is not cosmetic - it is why the range dimension could not see them, and
 * why this adapter carried a looser rule for them than uws did without any test
 * noticing.
 *
 * THE RULE IS READ FROM THE CONDITION, not from the sentence next to it. A
 * diagnostic is text, and text survives the code it describes: a guard can be
 * loosened or deleted while its message stays behind in a comment or a string,
 * and a contract minted from that sentence describes a rule nothing runs. So
 * each bound is taken from the comparison that enforces it, and the message is
 * then required to AGREE with what the comparison does. Either half alone can
 * be wrong in silence; disagreement between them is the thing worth failing on,
 * and it fails here rather than reaching the manifest.
 *
 * @param {string} controllerSource uws's `src/runtime/utils/upgrade-admission.js` at the pin
 * @returns {Record<string, { allowZero: boolean, floor: number, ceiling: number | null, integerRequired: boolean }>}
 */
export function admissionBoundRanges(controllerSource) {
	const code = blankNonCode(controllerSource);
	/** @type {Record<string, { allowZero: boolean, floor: number, ceiling: number | null, integerRequired: boolean }>} */
	const out = {};
	// Each bound arrives as a binding and the guard that governs it:
	//
	//   const configuredMaxConcurrent = opts && opts.maxConcurrent;
	//   if (configuredMaxConcurrent !== undefined && (!Number.isSafeInteger(...) || ... < 0)) {
	//       throw new TypeError('upgradeAdmission.maxConcurrent must be a non-negative safe integer.');
	//   }
	//
	// Walking the bindings rather than the messages is what ties a rule to the
	// key it actually governs: the binding names the option, and the condition
	// that reads that binding is the only thing entitled to state its bound.
	const binding = /const\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*opts\s*(?:&&\s*opts\.|\?\.)\s*([A-Za-z_$][\w$]*)/g;
	let b;
	while ((b = binding.exec(code)) !== null) {
		const bound = admissionGuard(code, controllerSource, binding.lastIndex, b[1], b[2]);
		if (bound) out[b[2]] = bound;
	}
	if (Object.keys(out).length === 0) {
		throw new Error(
			'parsed no upgradeAdmission bound guards from uws. Either the gate stopped asserting ' +
			'them or it words the assertion differently now - fix the extractor rather than ' +
			'recording an empty contract, which would make the nested range test vacuous.'
		);
	}
	return out;
}

/**
 * The bound a single `upgradeAdmission` binding is held to, or `null` when the
 * gate does not guard it at all.
 *
 * An unguarded option is a real answer and is recorded as one by being left
 * out: nothing enforces it, so the manifest should not claim anything does. A
 * guard that IS present but shaped differently than this reads is not a real
 * answer - it is an extractor that has fallen behind uws - so that throws.
 *
 * @param {string} code the controller with comments and string bodies blanked
 * @param {string} source the controller as written
 * @param {number} from offset just past the binding
 * @param {string} held the local the binding introduces
 * @param {string} key the `upgradeAdmission` option it holds
 * @returns {{ allowZero: boolean, floor: number, ceiling: number | null, integerRequired: boolean } | null}
 */
function admissionGuard(code, source, from, held, key) {
	// `$` is legal in an identifier and special in a pattern.
	const h = held.replace(/\$/g, '\\$');
	const mentions = new RegExp(`\\b${h}\\b`);
	const test = /\bif\s*\(/g;
	test.lastIndex = from;
	let f;
	while ((f = test.exec(code)) !== null) {
		const open = code.indexOf('(', f.index);
		const condition = callArgs(code, open);
		if (!mentions.test(condition)) continue;

		// Structure exactly, spacing not at all: uws wraps this condition across
		// four lines and the line breaks are not the contract.
		const shape = new RegExp(
			`^${h}!==undefined&&\\(!Number\\.isSafeInteger\\(${h}\\)\\|\\|${h}(<=?)0\\)$`
		);
		const governed = shape.exec(condition.replace(/\s+/g, ''));
		if (!governed) {
			throw new Error(
				`the upgradeAdmission.${key} guard is no longer the shape this extractor reads: ` +
				`${condition.replace(/\s+/g, ' ').trim().slice(0, 160)}. Read the new bound from it ` +
				'rather than leaving the old one recorded, which would hold this adapter to a rule uws dropped.'
			);
		}
		// `< 0` admits zero; `<= 0` does not. The floor follows the comparison,
		// so a guard that tightened is recorded as tightened.
		const allowZero = governed[1] === '<';

		const close = open + 1 + condition.length;
		const opens = /^\s*\{\s*throw new TypeError\s*\(/.exec(code.slice(close + 1));
		if (!opens) {
			throw new Error(
				`the upgradeAdmission.${key} guard no longer throws directly, so what it refuses ` +
				'cannot be read from it. Fix the extractor rather than recording an unchecked rule.'
			);
		}
		const throwOpen = close + opens[0].length;
		const stated = /^\s*'([^']*)'\s*$/d.exec(callArgs(code, throwOpen));
		if (!stated) {
			throw new Error(
				`the upgradeAdmission.${key} diagnostic is no longer a single string literal, so the ` +
				'guard and the words it states cannot be compared.'
			);
		}
		const [ms, me] = stated.indices[1];
		const message = callArgs(source, throwOpen).slice(ms, me);
		const says = /^upgradeAdmission\.([A-Za-z_$][\w$]*) must be a (non-negative|positive) safe integer\.$/.exec(message);
		const wording = allowZero ? 'non-negative' : 'positive';
		if (!says || says[1] !== key || says[2] !== wording) {
			throw new Error(
				`the upgradeAdmission.${key} guard and its diagnostic disagree. The condition refuses ` +
				`anything but a ${wording} safe integer; the message says "${message}". One of them is ` +
				'wrong, and which one cannot be decided here - fix uws or the extractor before recording it.'
			);
		}
		return { allowZero, floor: allowZero ? 0 : 1, ceiling: null, integerRequired: true };
	}
	return null;
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
	// DEFAULT TO THE PIN, never to HEAD. Regenerating this manifest is normally a
	// CHECK that it still describes the commit it names - not an invitation to
	// adopt whatever the sibling checkout has moved to since. With HEAD as the
	// default, an ordinary `npm run probe:uws` re-pins this adapter to a tree
	// nobody reviewed; and because a prerelease version string does not change
	// on every commit, the only trace can be one sha in a diff whose version line
	// says nothing moved. Moving the pin is a deliberate act, so it is spelled
	// like one: UWS_REF=<sha>.
	const ref = process.env.UWS_REF || pinnedRef() || 'HEAD';
	const commit = execFileSync('git', ['rev-parse', ref], { cwd: uwsRoot, encoding: 'utf8' }).trim();
	const dts = showAtRef(uwsRoot, commit, 'src/index.d.ts');
	const pkg = JSON.parse(showAtRef(uwsRoot, commit, 'package.json'));
	const schema = showAtRef(uwsRoot, commit, 'protocol.schema.json');
	const indexSource = showAtRef(uwsRoot, commit, 'src/index.js');
	const guardsSource = showAtRef(uwsRoot, commit, 'src/config-guards.js');
	const admissionSource = showAtRef(uwsRoot, commit, 'src/runtime/utils/upgrade-admission.js');

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
		// The same dimension for the sub-keys, which uws asserts somewhere else
		// entirely - inside the gate it builds, not while it reads the config. That
		// split is why a looser rule for these went unnoticed here.
		nestedProtectiveNumbers: { upgradeAdmission: admissionBoundRanges(admissionSource) },
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
	const NESTED_RANGE_FLOOR = 4;
	const nestedCount = Object.keys(surface.nestedProtectiveNumbers.upgradeAdmission).length;
	if (nestedCount < NESTED_RANGE_FLOOR) {
		throw new Error(
			`extracted only ${nestedCount} upgradeAdmission bound guards from uws (expected at ` +
			`least ${NESTED_RANGE_FLOOR}). Fix the extractor rather than lowering the floor.`
		);
	}
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
	console.log(`  nestedProtectiveNumbers: ${nestedCount}`);
}

// Only when RUN, never when imported. `process.argv[1]` is the entry script, so
// this compares what node was asked to execute against this module's own URL.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
