import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse_as_bytes, parse_idle_timeout, parse_origin } from '../../src/runtime/utils/parse.js';

test('parse_idle_timeout accepts the range Bun accepts', () => {
	assert.equal(parse_idle_timeout('120'), 120);
	assert.equal(parse_idle_timeout(' 30 '), 30, 'surrounding space is tolerated');
	assert.equal(parse_idle_timeout('0'), 0, '0 disables the timeout');
	assert.equal(parse_idle_timeout('255'), 255, 'the highest value Bun accepts');
});

test('parse_idle_timeout throws rather than silently serving a different timeout', () => {
	// Bun refuses >255 with a message that does not name the variable, and every
	// other bad value would otherwise fall back to a default the operator did
	// not choose - which is how a streaming endpoint gets cut in production by a
	// number nobody set.
	for (const bad of ['256', '-1', '1.5', 'soon', '', ' ', 'Infinity', 'NaN']) {
		assert.throws(
			() => parse_idle_timeout(bad),
			/IDLE_TIMEOUT must be a whole number of seconds from 0 to 255/,
			`${JSON.stringify(bad)} must be refused`
		);
	}
});

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
