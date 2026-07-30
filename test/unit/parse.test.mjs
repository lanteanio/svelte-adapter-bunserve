import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse_as_bytes, parse_origin } from '../../src/runtime/utils/parse.js';

test('parse_as_bytes plain number', () => {
	assert.equal(parse_as_bytes('1024'), 1024);
});

test('parse_as_bytes suffixes with and without trailing B', () => {
	assert.equal(parse_as_bytes('512K'), 512 * 1024);
	assert.equal(parse_as_bytes('512KB'), 512 * 1024);
	assert.equal(parse_as_bytes('2M'), 2 * 1024 * 1024);
	assert.equal(parse_as_bytes('1G'), 1024 * 1024 * 1024);
	assert.equal(parse_as_bytes(' 512k '), 512 * 1024);
});

test('parse_as_bytes zero is zero (donor-diverging unlimited semantics live downstream)', () => {
	assert.equal(parse_as_bytes('0'), 0);
});

test('parse_as_bytes rejects negatives, Infinity, and garbage as NaN', () => {
	assert.ok(Number.isNaN(parse_as_bytes('-100')));
	assert.ok(Number.isNaN(parse_as_bytes('Infinity')));
	assert.ok(Number.isNaN(parse_as_bytes('abc')));
});

test('parse_origin normalizes to URL origin', () => {
	assert.equal(parse_origin('https://example.com:8443/some/path'), 'https://example.com:8443');
	assert.equal(parse_origin(undefined), undefined);
});

test('parse_origin rejects non-http(s) and garbage', () => {
	assert.throws(() => parse_origin('ftp://example.com'));
	assert.throws(() => parse_origin('not a url'));
});
