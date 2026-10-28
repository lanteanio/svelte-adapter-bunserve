import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negotiateEncoding, representationEtag } from '../../src/runtime/utils/static-negotiate.js';


test('no accept-encoding yields identity', () => {
	assert.equal(negotiateEncoding('', true, true), '');
});

test('brotli wins over gzip when both are acceptable and available', () => {
	assert.equal(negotiateEncoding('gzip, deflate, br', true, true), 'br');
});

test('gzip is chosen when brotli is unavailable', () => {
	assert.equal(negotiateEncoding('gzip, deflate, br', false, true), 'gzip');
});

test('identity when no variant exists, whatever the client accepts', () => {
	assert.equal(negotiateEncoding('gzip, deflate, br', false, false), '');
});

test('identity when the client accepts nothing we have', () => {
	assert.equal(negotiateEncoding('deflate', true, true), '');
});

test('representationEtag leaves identity and empty validators alone', () => {
	assert.equal(representationEtag('W/"abc-123"', ''), 'W/"abc-123"');
	assert.equal(representationEtag('', 'br'), '');
});

test('representationEtag makes each coding a distinct validator', () => {
	const base = 'W/"abc-123"';
	const br = representationEtag(base, 'br');
	const gz = representationEtag(base, 'gzip');
	assert.equal(br, 'W/"abc-123-br"');
	assert.equal(gz, 'W/"abc-123-gzip"');
	// The whole point: no two representations share a validator, so a
	// conditional or resumed request can never cross representations.
	assert.notEqual(br, base);
	assert.notEqual(gz, base);
	assert.notEqual(br, gz);
});

test('representationEtag keeps the weak prefix and quoting intact', () => {
	const tagged = representationEtag('W/"x"', 'br');
	assert.ok(tagged.startsWith('W/"'));
	assert.ok(tagged.endsWith('"'));
	assert.equal((tagged.match(/"/g) || []).length, 2);
});

test('representationEtag tolerates a malformed validator without corrupting it', () => {
	assert.equal(representationEtag('novalidator', 'br'), 'novalidator');
});

for (const [header, expected] of [
	['gzip, br;q=0', 'gzip'],
	['gzip;q=1, br;q=0.5', 'gzip'],
	['*', 'br'],
	['br;q=0, *;q=1', 'gzip'],
	['*;q=0, gzip', 'gzip'],
	['identity;q=0, *;q=0', ''],
	['GZIP;q=0.8, BR;q=0.3', 'gzip'],
	['notbr, xgzip', ''],
	['br;q=0, br;q=1, gzip', 'gzip'],
	['BR;q=0, br', 'br']
]) {
	test(`negotiates weighted coding ${header}`, () => {
		assert.equal(negotiateEncoding(header, true, true), expected);
	});
}
