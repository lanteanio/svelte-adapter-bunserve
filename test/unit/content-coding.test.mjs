// Accept-Encoding negotiation (src/runtime/utils/static-negotiate.js), the
// function both the static lane and the single-chunk SSR lane call.
//
// Weighted coding, list grammar and fast-path boundaries from RFC 9110 12.5.3.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { negotiateEncoding } from '../../src/runtime/utils/static-negotiate.js';

const both = (header) => negotiateEncoding(header, true, true);

describe('negotiateEncoding', () => {
	it('serves brotli for the headers browsers actually send', () => {
		assert.equal(both('gzip, deflate, br, zstd'), 'br');
		assert.equal(both('gzip, deflate, br'), 'br');
		assert.equal(both('deflate, gzip, br, zstd'), 'br');
		assert.equal(both('br'), 'br');
	});

	it('serves gzip when brotli is not offered, and identity when nothing is', () => {
		assert.equal(both('gzip, deflate'), 'gzip');
		assert.equal(both('gzip'), 'gzip');
		assert.equal(both('deflate'), '');
		assert.equal(both(''), '');
		assert.equal(both('identity'), '');
	});

	it('a q=0 is a refusal, whatever else the header says', () => {
		assert.equal(both('br;q=0, gzip'), 'gzip');
		assert.equal(both('gzip, br;q=0'), 'gzip');
		assert.equal(both('br;q=0.0, gzip;q=0.000'), '');
		assert.equal(both('br;q=0'), '');
		assert.equal(both('gzip;q=0, deflate'), '');
	});

	it('the highest weight wins, and the server preference breaks a tie', () => {
		assert.equal(both('gzip;q=1.0, br;q=0.5'), 'gzip');
		assert.equal(both('gzip;q=0.8, br;q=0.9'), 'br');
		assert.equal(both('gzip;q=0.5, br;q=0.5'), 'br');
		assert.equal(both('br;q=0.001, gzip;q=0.002'), 'gzip');
		// Listed order carries no preference of its own.
		assert.equal(both('gzip, br'), 'br');
	});

	it('a wildcard stands for every coding not named, at its own weight', () => {
		assert.equal(both('*'), 'br');
		assert.equal(both('*;q=0.5'), 'br');
		assert.equal(both('*;q=0, gzip'), 'gzip');
		assert.equal(both('*;q=0.1, gzip;q=0.5'), 'gzip');
		assert.equal(both('*;q=0.9, gzip;q=0.5'), 'br');
		assert.equal(both('*;q=0'), '');
		assert.equal(both('identity;q=0, *;q=0'), '');
		// gzip reached through the wildcard alone, with brotli refused by name.
		assert.equal(both('br;q=0, *'), 'gzip');
	});

	it('the fast path takes a lowercase weightless listing, even after a refusal in another case', () => {
		// The line the module draws on purpose (see its header): a coding listed
		// twice in two letter cases is answered by the fast path's listing. Pinned
		// so moving the line is a visible change, not a silent one.
		assert.equal(both('BR;q=0, br'), 'br');
		assert.equal(negotiateEncoding('GZIP;q=0, gzip', false, true), 'gzip');
		// A capitalised spelling on its own always takes the full pass.
		assert.equal(both('BR;q=0, gzip'), 'gzip');
		assert.equal(both('Br, gzip;q=0.5'), 'br');
	});

	it('only the codings the server holds are candidates', () => {
		assert.equal(negotiateEncoding('gzip, deflate, br', false, true), 'gzip');
		assert.equal(negotiateEncoding('gzip, deflate, br', true, false), 'br');
		assert.equal(negotiateEncoding('br', false, true), '');
		assert.equal(negotiateEncoding('*', false, false), '');
		assert.equal(negotiateEncoding('gzip', false, false), '');
	});

	it('coding names are case-insensitive tokens, not substrings', () => {
		assert.equal(both('GZIP, BR'), 'br');
		assert.equal(both('Gzip'), 'gzip');
		// A token that merely contains the letters is a different coding.
		assert.equal(both('sbr'), '');
		assert.equal(both('brotli'), '');
		assert.equal(both('xgzip'), '');
		assert.equal(both('gzipx'), '');
		assert.equal(both('x-gzip'), '');
	});

	it('tolerates the whitespace and empty elements the list grammar allows', () => {
		assert.equal(both('  gzip , br '), 'br');
		assert.equal(both('gzip,,br'), 'br');
		assert.equal(both(','), '');
		assert.equal(both('gzip ; q=0 , br'), 'br');
		assert.equal(both('gzip;q=0 ,br'), 'br');
		assert.equal(both('\tbr\t'), 'br');
	});

	it('reads only the q parameter and leaves the default weight on one it cannot read', () => {
		assert.equal(both('br;level=5, gzip;q=0.5'), 'br');
		assert.equal(both('br;foo=bar;q=0, gzip'), 'gzip');
		assert.equal(both('br;Q=0, gzip'), 'gzip');
		// Not a qvalue: no digits, above one, wrong punctuation. The coding
		// keeps its default weight rather than being refused or preferred.
		assert.equal(both('br;q=abc, gzip;q=0.5'), 'br');
		assert.equal(both('br;q=2, gzip;q=0.5'), 'br');
		assert.equal(both('br;q=, gzip;q=0.5'), 'br');
		assert.equal(both('br;q=0.5x, gzip;q=0.6'), 'br');
		assert.equal(both('br;q=1.5, gzip;q=0.6'), 'br');
		// A weight above 1 is not a qvalue either: gzip keeps 1 and loses the
		// tie to brotli rather than outranking it.
		assert.equal(both('gzip;q=1.5, br;q=1'), 'br');
		// More than three decimals is outside the grammar too.
		assert.equal(both('br;q=0.0001, gzip;q=0.5'), 'br');
		assert.equal(both('br;q=1.000, gzip'), 'br');
		assert.equal(both('br;q=0., gzip;q=0.5'), 'gzip');
	});

	it('the first listing of a coding is the one that counts', () => {
		assert.equal(both('br, br;q=0, gzip'), 'br');
		assert.equal(both('br;q=0, br'), '');
		assert.equal(both('*;q=0, *, gzip'), 'gzip');
	});

	it('a weight separated from its coding by whitespace is still its weight', () => {
		// The one-search path must not read `br ;q=0` as a weightless listing.
		assert.equal(both('br ;q=0, gzip'), 'gzip');
		assert.equal(both('br\t; q=0, gzip'), 'gzip');
		assert.equal(both('gzip, br ; q=0.5'), 'gzip');
		assert.equal(both(' br , gzip'), 'br');
	});

	it('the one-search path leaves a spelling inside another token to the full pass', () => {
		assert.equal(both('x-br, br'), 'br');
		assert.equal(both('sbr, gzip'), 'gzip');
		assert.equal(both('gzip, x-gzip'), 'gzip');
		assert.equal(negotiateEncoding('x-gzip', false, true), '');
		assert.equal(negotiateEncoding('x-gzip, gzip', false, true), 'gzip');
	});
});
