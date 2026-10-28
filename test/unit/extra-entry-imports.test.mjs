import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { writeAndCloseRollupBundle, extraEntryImports } from '../../src/build-rollup-lifecycle.js';

// The build imports each discovered `__` entry by the file Rollup wrote for it.
//
// Built from the entry name, the import would miss: Rollup rewrites characters
// it will not put in a file name, so an entry named `__a#b` is written as
// `__a_b.js` (and `__a%b`, sanitized to the same name, as `__a_b2.js`), and an
// apostrophe in a name would end a quoted specifier and break the whole
// generated index. These run a real Rollup build with the resolver the
// adapter's build uses and import the index the helper produced, so the
// entries' side effects are what prove it. The build's own discovery of the
// entries is driven end to end by test/live/extra-entries-check.mjs.

/** @type {string[]} */
const dirs = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NAMES = ['__a#b', '__a%b', "__it's", '__plain'].sort();

/**
 * Write the entries under `src`, build them from `readFrom` (the same
 * directory, or a link to it), and import the index the helper writes.
 *
 * @param {string} root
 * @param {string} src
 * @param {string} readFrom
 * @returns {Promise<{ lines: string, ran: unknown }>}
 */
async function buildAndImport(root, src, readFrom) {
	const out = path.join(root, 'out');
	const marker = `__extraEntryProbe_${process.pid}_${Math.random().toString(36).slice(2)}`;
	for (const name of NAMES) {
		writeFileSync(
			path.join(src, `${name}.js`),
			`(globalThis[${JSON.stringify(marker)}] ??= []).push(${JSON.stringify(name)});\n`
		);
	}
	const input = Object.fromEntries(NAMES.map((name) => [name, `${readFrom}/${name}.js`]));
	const bundle = await rollup({ input, plugins: [nodeResolve({ preferBuiltins: true })] });
	const written = await writeAndCloseRollupBundle(bundle, { dir: path.join(out, 'server'), format: 'esm' });
	const lines = extraEntryImports(written, readFrom, NAMES);
	writeFileSync(path.join(out, 'index.mjs'), lines + '\n');
	await import(pathToFileURL(path.join(out, 'index.mjs')).href);
	return { lines, ran: /** @type {any} */ (globalThis)[marker] };
}

test('entries whose names Rollup rewrites, or that carry an apostrophe, are imported and run in order', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'extra-entries-'));
	dirs.push(root);
	const src = path.join(root, 'src');
	mkdirSync(src);
	const { lines, ran } = await buildAndImport(root, src, src);
	assert.ok(!lines.includes('__a#b.js') && !lines.includes('__a%b.js'),
		`imported by the entry name, not the file Rollup wrote:\n${lines}`);
	assert.deepEqual(ran, NAMES, 'every entry ran, in load order');
});

test('entries read through a symlinked directory are matched by their real path', async () => {
	// The resolver reports each entry by its real path, so a project reached
	// through a link would otherwise match no chunk, and the rewritten names
	// would be imported by entry name: `./server/__a#b.js` is a fragment, not
	// a file.
	const root = mkdtempSync(path.join(tmpdir(), 'extra-entries-link-'));
	dirs.push(root);
	const src = path.join(root, 'real');
	const link = path.join(root, 'link');
	mkdirSync(src);
	// A junction on Windows needs no privilege; elsewhere the type is ignored.
	symlinkSync(src, link, 'junction');
	const { lines, ran } = await buildAndImport(root, src, link);
	assert.ok(!lines.includes('__a#b.js') && !lines.includes('__a%b.js'),
		`a linked entry fell back to its entry name:\n${lines}`);
	assert.deepEqual(ran, NAMES, 'every entry ran, in load order');
});

test('the build handle is closed after the write, and after a failed write too', async () => {
	// close() is what runs closeBundle hooks; Rollup does not close a build on
	// its own after a successful write.
	/** @type {string[]} */
	const calls = [];
	const ok = /** @type {any} */ ({
		write: async () => { calls.push('write'); return { output: [] }; },
		close: async () => { calls.push('close'); }
	});
	assert.deepEqual(await writeAndCloseRollupBundle(ok, {}), { output: [] });
	assert.deepEqual(calls, ['write', 'close']);

	calls.length = 0;
	const failing = /** @type {any} */ ({
		write: async () => { calls.push('write'); throw new Error('disk full'); },
		close: async () => { calls.push('close'); }
	});
	await assert.rejects(writeAndCloseRollupBundle(failing, {}), /disk full/);
	assert.deepEqual(calls, ['write', 'close']);
});
