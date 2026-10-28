import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { unresolvedImportAdvice } from '../../src/build-config.js';

// The build refuses an import it cannot resolve rather than leaving a bare
// specifier to crash at startup, and says what to do about it. The advice
// depends on where the importer lives: the WebSocket handler's graph is read
// straight from project source, while the server output and every dependency
// have already been through Vite or ship ready to run.

const root = path.resolve('/project');
const tmp = path.join(root, '.svelte-kit', 'adapter-bunserve');
const realTmp = path.resolve('/real-disk/project/.svelte-kit/adapter-bunserve');
const dirs = [tmp, realTmp];

const isHandlerAdvice = (/** @type {string} */ s) => s.includes('WebSocket handler is bundled straight from project source');
const isPackageAdvice = (/** @type {string} */ s) => s.includes('install the package it names');

test('an import from the handler\'s own graph gets the handler advice', () => {
	const advice = unresolvedImportAdvice([path.join(root, 'src', 'ws-handler.js')], dirs);
	assert.equal(advice.length, 1);
	assert.ok(isHandlerAdvice(advice[0]), advice[0]);
});

test('an import from the server output, by either spelling of it, gets the package advice', () => {
	for (const dir of dirs) {
		const advice = unresolvedImportAdvice([path.join(dir, '__live-registry.js')], dirs);
		assert.equal(advice.length, 1, dir);
		assert.ok(isPackageAdvice(advice[0]), advice[0]);
	}
});

test('an import from inside a dependency gets the package advice', () => {
	// A bundled devDependency importing a package that is not installed: the
	// importer is neither the handler's source nor the server output.
	const advice = unresolvedImportAdvice([path.join(root, 'node_modules', 'foo', 'index.js')], dirs);
	assert.equal(advice.length, 1);
	assert.ok(isPackageAdvice(advice[0]), advice[0]);
});

test('both causes at once get both paragraphs, handler advice first', () => {
	const advice = unresolvedImportAdvice([path.join(tmp, 'index.js'), path.join(root, 'src', 'lib', 'db.js')], dirs);
	assert.equal(advice.length, 2);
	assert.ok(isHandlerAdvice(advice[0]) && isPackageAdvice(advice[1]), advice.join('\n'));
});

test('a directory beside the server output is not inside it', () => {
	// `adapter-bunserve-old` shares a prefix with `adapter-bunserve`; only a real
	// path containment counts.
	const advice = unresolvedImportAdvice([`${tmp}-old${path.sep}index.js`, 'unknown'], dirs);
	assert.equal(advice.length, 1);
	assert.ok(isHandlerAdvice(advice[0]), advice[0]);
});
