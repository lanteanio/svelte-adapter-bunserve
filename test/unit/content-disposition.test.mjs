import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contentDispositionValue } from '../../src/runtime/utils/static-headers.js';

// The content-disposition a downloadable asset carries: svelte-adapter-uws's
// value, made safe for its quoted-string, handed over as the UTF-8 bytes uWS
// writes for it, since a fetch Headers value is bytes.

const L_STROKE = String.fromCharCode(0x141);
const O_ACUTE = String.fromCharCode(0xf3);
const Z_ACUTE = String.fromCharCode(0x17a);
const U_UMLAUT = String.fromCharCode(0xdc);

test('quotes the name, without a quote, a backslash or a control character', () => {
	assert.equal(contentDispositionValue('report.zip'), 'attachment; filename="report.zip"');
	assert.equal(contentDispositionValue('a"b\\c.zip'), 'attachment; filename="abc.zip"');
	assert.equal(contentDispositionValue('a\nb\rc\x00d\x1fe\x7ff.zip'), 'attachment; filename="abcdef.zip"',
		'a newline would end the field on the wire');
	assert.equal(contentDispositionValue('a\tb.zip'), 'attachment; filename="ab.zip"');
});

test('carries a name outside ASCII as its UTF-8 bytes, which a Headers value can hold', () => {
	const name = L_STROKE + O_ACUTE + 'd' + Z_ACUTE + '.zip';
	const value = contentDispositionValue(name);
	assert.equal(Buffer.from(value, 'latin1').toString('utf8'), `attachment; filename="${name}"`);
	assert.doesNotThrow(() => new Headers([['content-disposition', value]]));
	assert.throws(() => new Headers([['content-disposition', `attachment; filename="${name}"`]]),
		'the name as it is cannot be a header value');
	// A Latin-1 name goes out as UTF-8 too, not as its one Latin-1 byte.
	const latin = contentDispositionValue(U_UMLAUT + 'bersicht.zip');
	assert.deepEqual([...Buffer.from(latin, 'latin1').subarray(22, 24)], [0xc3, 0x9c]);
});
