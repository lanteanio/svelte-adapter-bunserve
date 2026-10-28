import { test } from 'node:test';
import assert from 'node:assert/strict';

import { windowsReservedPath } from '../../src/runtime/utils/windows-path.js';

// The Windows reserved-character gate, svelte-adapter-uws's predicate, which
// server.js applies ahead of every decoding lane on win32: a `:` opens an NTFS
// alternate data stream and a `~` can name a file by its 8.3 short name, in
// the raw spelling and the decoded one, since the prerendered lookup, the
// encoded static lookup and SvelteKit's router all decode before they reach a
// file. Pure, so it runs on every platform.

test('refuses the raw spellings', () => {
	assert.equal(windowsReservedPath('/file.txt:stream'), true);
	assert.equal(windowsReservedPath('/LONGFI~1.TXT'), true);
	assert.equal(windowsReservedPath('/a/b:c/d'), true);
});

test('refuses the encoded spellings the decoding lanes would open', () => {
	assert.equal(windowsReservedPath('/file.txt%3Astream'), true);
	assert.equal(windowsReservedPath('/file.txt%3astream'), true);
	assert.equal(windowsReservedPath('/LONGFI%7E1.TXT'), true);
	assert.equal(windowsReservedPath('/LONGFI%7e1.TXT'), true);
	assert.equal(windowsReservedPath('/report%7Ev2.pdf'), true, 'a static name with a tilde, asked for encoded');
	assert.equal(windowsReservedPath('/caf%C3%A9%3Ax'), true, 'escaped elsewhere too');
});

test('passes ordinary paths, encoded or not', () => {
	for (const path of ['/', '/about', '/_app/immutable/chunk.js', '/caf%C3%A9', '/a%20b', '/a%2Fb']) {
		assert.equal(windowsReservedPath(path), false, path);
	}
});

test('reads one decoding, as the lanes do', () => {
	// `%253A` decodes to the literal `%3A`, which no file system call reads as
	// a colon.
	assert.equal(windowsReservedPath('/x%253Ay'), false);
});

test('leaves a path that does not decode to the lanes that refuse it', () => {
	assert.equal(windowsReservedPath('/x%'), false);
	assert.equal(windowsReservedPath('/x%ZZ'), false);
	assert.equal(windowsReservedPath('/x%E0%80'), false);
	assert.equal(windowsReservedPath('/x:%'), true, 'unless the raw spelling is already reserved');
});
