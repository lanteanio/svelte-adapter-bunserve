import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../../src/runtime/utils/range.js';

test('valid closed range', () => {
	assert.deepEqual(parseRange('bytes=0-499', 1000), { start: 0, end: 499 });
});

test('open-ended range runs to EOF', () => {
	assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
});

test('suffix range takes last N bytes', () => {
	assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 });
});

test('suffix larger than file clamps to whole file', () => {
	assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
});

test('end beyond EOF clamps to EOF', () => {
	assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
});

test('start past EOF is unsatisfiable (416 signal)', () => {
	assert.equal(parseRange('bytes=1000-', 1000), null);
	assert.equal(parseRange('bytes=99999-100000', 1000), null);
});

test('multi-range is ignored (200 signal)', () => {
	assert.equal(parseRange('bytes=0-499,600-700', 1000), false);
});

test('non-bytes unit is ignored', () => {
	assert.equal(parseRange('items=0-4', 1000), false);
});

test('missing dash is ignored', () => {
	assert.equal(parseRange('bytes=17', 1000), false);
});

test('non-digit tokens are ignored (RFC 7233 1*DIGIT)', () => {
	assert.equal(parseRange('bytes=1oops-5', 1000), false);
	assert.equal(parseRange('bytes=0-4x', 1000), false);
	assert.equal(parseRange('bytes= 0-4', 1000), false);
});

test('negative and inverted forms are ignored', () => {
	assert.equal(parseRange('bytes=5-2', 1000), false);
	assert.equal(parseRange('bytes=-0', 1000), false);
	assert.equal(parseRange('bytes=-', 1000), false);
});

test('zero-length file: any start is unsatisfiable', () => {
	assert.equal(parseRange('bytes=0-', 0), null);
});
