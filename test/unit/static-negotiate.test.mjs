import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negotiateEncoding, representationEtag } from '../../src/runtime/utils/static-negotiate.js';

const BOTH = { hasBr: true, hasGz: true };
const NONE = { hasBr: false, hasGz: false };

test('no accept-encoding yields identity', () => {
	assert.equal(negotiateEncoding('', BOTH), '');
});

test('brotli wins over gzip when both are acceptable and available', () => {
	assert.equal(negotiateEncoding('gzip, deflate, br', BOTH), 'br');
});

test('gzip is chosen when brotli is unavailable', () => {
	assert.equal(negotiateEncoding('gzip, deflate, br', { hasBr: false, hasGz: true }), 'gzip');
});

test('identity when no variant exists, whatever the client accepts', () => {
	assert.equal(negotiateEncoding('gzip, deflate, br', NONE), '');
});

test('identity when the client accepts nothing we have', () => {
	assert.equal(negotiateEncoding('deflate', BOTH), '');
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
