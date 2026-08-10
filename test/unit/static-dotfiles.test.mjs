import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Static serving refuses dot-segment paths by default.
//
// The threat is not a crafted request but an accidental file: static/ is a
// plain directory app authors drop things into, and what lands there by
// mistake - a stray .env, an .htpasswd, an editor backup, an unpacked .git -
// was served verbatim to anyone who guessed the name. adapter-node refuses
// dotfiles, so an app migrating to this adapter silently gained exposure.
//
// The exclusion is decided once at index time: the cache never holds the
// entry, so there is no per-request check to bypass and an encoded traversal
// decodes to a key that is not there. .well-known/* keeps working - RFC 8615
// discovery (security.txt, ACME HTTP-01 challenges) is documented served
// behavior - with the carve-out at the first segment only, and never for a
// dotfile inside the directory.
//
// Three layers share one predicate: the pure rule, the build-time scan that
// warns about what serving will refuse, and the index-time walk itself. The
// served surface is asserted end to end over a real Bun in
// test/live/static-dotfiles-check.mjs.

import { excludedDotPath } from '../../src/runtime/utils/dot-path.js';
import { listExcludedDotPaths } from '../../src/static-scan.js';
import { assertScalarOptions, KNOWN_ADAPTER_OPTIONS } from '../../src/adapter-options.js';

globalThis.PRECOMPRESS = false;
globalThis.STATIC_CACHE_MAX = 1024 * 1024;
globalThis.STATIC_DOTFILES = false;
globalThis.ENV_PREFIX = '';

register('../helpers/manifest-loader.mjs', import.meta.url);

const { cacheDir } = await import('../../src/runtime/handler/static-assets.js');
const { staticCache } = await import('../../src/runtime/handler/state.js');

const MARKER = 'leaked-if-served';

test('the predicate refuses a dot segment anywhere in the path', () => {
	assert.equal(excludedDotPath('.env'), true);
	assert.equal(excludedDotPath('.htpasswd'), true);
	assert.equal(excludedDotPath('.git'), true);
	assert.equal(excludedDotPath('.envrc'), true);
	assert.equal(excludedDotPath('a/.hidden'), true);
	assert.equal(excludedDotPath('a/.hidden/b'), true);
	assert.equal(excludedDotPath('a/b/.DS_Store'), true);
	assert.equal(excludedDotPath('.'), true);
	assert.equal(excludedDotPath('..'), true);
});

test('the predicate serves ordinary paths, including dots inside a segment', () => {
	assert.equal(excludedDotPath('foo.txt'), false);
	assert.equal(excludedDotPath('a/b/c.png'), false);
	assert.equal(excludedDotPath('a..b/c'), false);
	assert.equal(excludedDotPath('a/well.known'), false);
	assert.equal(excludedDotPath('robots.txt'), false);
});

test('the predicate exempts .well-known at the first segment only', () => {
	assert.equal(excludedDotPath('.well-known'), false);
	assert.equal(excludedDotPath('.well-known/security.txt'), false);
	assert.equal(excludedDotPath('.well-known/acme-challenge/token'), false);
	// Not an escape hatch: nested placement and dotfiles inside are refused.
	assert.equal(excludedDotPath('x/.well-known/y'), true);
	assert.equal(excludedDotPath('.well-known/.hidden'), true);
	// And the exemption is one exact spelling, not a family. A prefix match, a
	// whole-path prefix or a case-insensitive compare would each hand an
	// attacker a directory name that reads like the allow-listed one and is
	// not it - which is the whole boundary this predicate draws.
	assert.equal(excludedDotPath('.well-knownx/a'), true);
	assert.equal(excludedDotPath('.well-known-old/a'), true);
	assert.equal(excludedDotPath('.well-known.bak/a'), true);
	assert.equal(excludedDotPath('.WELL-KNOWN/a'), true);
	assert.equal(excludedDotPath('.Well-Known/a'), true);
});

test('the build scan lists every refused path once and never enters a refused directory', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-dot-scan-'));
	try {
		fs.writeFileSync(path.join(tmp, '.env'), 'x');
		fs.mkdirSync(path.join(tmp, '.git'));
		fs.writeFileSync(path.join(tmp, '.git', 'config'), 'x');
		fs.mkdirSync(path.join(tmp, '.well-known'));
		fs.writeFileSync(path.join(tmp, '.well-known', 'ok.txt'), 'x');
		fs.writeFileSync(path.join(tmp, '.well-known', '.bad'), 'x');
		fs.mkdirSync(path.join(tmp, 'deep'));
		fs.writeFileSync(path.join(tmp, 'deep', '.hidden.txt'), 'x');
		fs.writeFileSync(path.join(tmp, 'deep', 'ok.txt'), 'x');
		fs.writeFileSync(path.join(tmp, 'root.txt'), 'x');
		// Precompressed siblings: the build can compress a dotfile it wrote, and
		// the warning must name the offender once, not three times.
		fs.writeFileSync(path.join(tmp, '.packed.txt'), 'x');
		fs.writeFileSync(path.join(tmp, '.packed.txt.br'), 'x');
		fs.writeFileSync(path.join(tmp, '.packed.txt.gz'), 'x');

		assert.deepEqual(listExcludedDotPaths(tmp), [
			'.env',
			'.git/',
			'.packed.txt',
			'.well-known/.bad',
			'deep/.hidden.txt'
		]);
		// `.git/` collapsed to one entry, so its contents were never enumerated.
		assert.equal(listExcludedDotPaths(tmp).includes('.git/config'), false);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('the build scan returns nothing for a missing directory', () => {
	assert.deepEqual(listExcludedDotPaths(path.join(os.tmpdir(), 'bunserve-no-such-dir-xyz')), []);
});

test('the index-time walk never caches a dot-segment path, and keeps .well-known', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-dot-index-'));
	try {
		fs.writeFileSync(path.join(tmp, 'ok.txt'), 'served');
		fs.writeFileSync(path.join(tmp, '.secret'), MARKER);
		fs.mkdirSync(path.join(tmp, '.git'));
		fs.writeFileSync(path.join(tmp, '.git', 'config'), MARKER);
		fs.mkdirSync(path.join(tmp, 'nested'));
		fs.writeFileSync(path.join(tmp, 'nested', 'ok.txt'), 'served');
		fs.writeFileSync(path.join(tmp, 'nested', '.hidden'), MARKER);
		fs.mkdirSync(path.join(tmp, 'nested', '.hidden-dir'));
		fs.writeFileSync(path.join(tmp, 'nested', '.hidden-dir', 'inner.txt'), MARKER);
		fs.mkdirSync(path.join(tmp, '.well-known'));
		fs.writeFileSync(path.join(tmp, '.well-known', 'security.txt'), 'served');
		fs.writeFileSync(path.join(tmp, '.well-known', '.bad'), MARKER);
		// The carve-out is FIRST SEGMENT ONLY, and this is the tree that proves
		// the walk applies it that way rather than per directory entry: a walk
		// testing the basename would exempt this `.well-known` too and index
		// the file inside it, which is precisely the escape hatch the rule
		// exists to close.
		fs.mkdirSync(path.join(tmp, 'uploads'));
		fs.mkdirSync(path.join(tmp, 'uploads', '.well-known'));
		fs.writeFileSync(path.join(tmp, 'uploads', '.well-known', 'leak.txt'), MARKER);

		cacheDir(tmp, '/dot-probe', false);

		assert.ok(staticCache.get('/dot-probe/ok.txt'), 'ordinary file is indexed');
		assert.ok(staticCache.get('/dot-probe/nested/ok.txt'), 'nested ordinary file is indexed');
		assert.ok(staticCache.get('/dot-probe/.well-known/security.txt'), '.well-known is indexed');

		assert.equal(staticCache.get('/dot-probe/.secret'), undefined);
		assert.equal(staticCache.get('/dot-probe/.git/config'), undefined);
		assert.equal(staticCache.get('/dot-probe/nested/.hidden'), undefined);
		assert.equal(staticCache.get('/dot-probe/nested/.hidden-dir/inner.txt'), undefined);
		assert.equal(staticCache.get('/dot-probe/.well-known/.bad'), undefined);
		assert.equal(
			staticCache.get('/dot-probe/uploads/.well-known/leak.txt'),
			undefined,
			'a nested .well-known is not an escape hatch'
		);

		// No cached entry carries the marker under ANY key. The per-key
		// assertions above would still pass if the walk had indexed a refused
		// file under some other spelling.
		for (const [key, entry] of staticCache) {
			const body = entry.buffer ? Buffer.from(entry.buffer).toString('utf8') : '';
			assert.equal(body.includes(MARKER), false, `${key} must not hold refused bytes`);
		}
	} finally {
		staticCache.clear();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('a refused directory is never read, not merely filtered at the leaf', () => {
	// The difference is invisible in the cache - both shapes index nothing -
	// and it is the whole reason the check sits before the recursion: an
	// unpacked .git is thousands of entries, and reading them to throw them
	// away is boot cost paid on every deploy. So this asserts the READ, by
	// counting the walk's own readdirSync calls. Patching the property on the
	// node:fs default export reaches the module object the runtime holds.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-dot-descend-'));
	const realReaddir = fs.readdirSync;
	/** @type {string[]} */
	const read = [];
	try {
		fs.mkdirSync(path.join(tmp, '.git'));
		fs.writeFileSync(path.join(tmp, '.git', 'config'), MARKER);
		fs.mkdirSync(path.join(tmp, '.git', 'objects'));
		fs.writeFileSync(path.join(tmp, '.git', 'objects', 'blob'), MARKER);
		fs.mkdirSync(path.join(tmp, 'assets'));
		fs.writeFileSync(path.join(tmp, 'assets', 'ok.txt'), 'served');

		// @ts-expect-error - a spy of the same shape, restored below
		fs.readdirSync = (dir, ...rest) => {
			read.push(String(dir));
			return realReaddir(dir, ...rest);
		};
		cacheDir(tmp, '/descend', false);
	} finally {
		fs.readdirSync = realReaddir;
		staticCache.clear();
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	// Compared RELATIVE to the scratch root: an absolute temp path is not ours
	// to assume anything about, and one that happens to contain a dot segment
	// (a `my.gitlab-cache` directory, say) would fail this on correct code and
	// accuse the walk of descending into `.git`.
	const walked = read.map((d) => path.relative(tmp, d));
	assert.equal(walked.some((d) => d.split(path.sep)[0] === '.git'), false, `walked into ${JSON.stringify(walked)}`);
	assert.equal(walked.includes('assets'), true, 'an ordinary directory is still walked');
});

test('the opt-in indexes every dotfile', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-dot-optin-'));
	globalThis.STATIC_DOTFILES = true;
	try {
		fs.writeFileSync(path.join(tmp, '.secret'), MARKER);
		fs.mkdirSync(path.join(tmp, 'nested'));
		fs.writeFileSync(path.join(tmp, 'nested', '.hidden'), MARKER);

		cacheDir(tmp, '/dot-optin', false);

		assert.ok(staticCache.get('/dot-optin/.secret'), 'the opt-out restores indexing');
		assert.ok(staticCache.get('/dot-optin/nested/.hidden'));
	} finally {
		globalThis.STATIC_DOTFILES = false;
		staticCache.clear();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('staticDotfiles is a known option, validated as a boolean at factory time', () => {
	assert.ok(KNOWN_ADAPTER_OPTIONS.includes('staticDotfiles'));
	assert.throws(
		() => assertScalarOptions({ staticDotfiles: 'true' }),
		/`staticDotfiles` must be true or false/,
		'a truthy string must not read as opting in'
	);
	// The message says which boolean is safe, not just that a boolean is wanted.
	assert.throws(() => assertScalarOptions({ staticDotfiles: 1 }), /\.well-known/);
	// Rendering a bad value must not itself throw a different error.
	assert.throws(() => assertScalarOptions({ staticDotfiles: 1n }), /must be true or false/);
	assert.throws(
		() => assertScalarOptions({ staticDotfiles: Object.create(null) }),
		/must be true or false/
	);
	assert.doesNotThrow(() => assertScalarOptions({ staticDotfiles: true }));
	assert.doesNotThrow(() => assertScalarOptions({ staticDotfiles: false }));
	assert.doesNotThrow(() => assertScalarOptions({}), 'an absent option is not invented');
});
