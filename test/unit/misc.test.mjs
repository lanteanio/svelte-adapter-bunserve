import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestId } from '../../src/runtime/utils/request-id.js';
import { mimeLookup } from '../../src/runtime/utils/mime.js';
import { isDedupBufferable } from '../../src/runtime/handler/ssr-dedup.js';

test('resolveRequestId accepts a printable token and trims it', () => {
	assert.equal(resolveRequestId('  req-123  '), 'req-123');
});

test('resolveRequestId rejects absent, empty, oversized, and non-printable input', () => {
	assert.equal(resolveRequestId(undefined), null);
	assert.equal(resolveRequestId(''), null);
	assert.equal(resolveRequestId('   '), null);
	assert.equal(resolveRequestId('x'.repeat(129)), null);
	assert.equal(resolveRequestId('has space'), null);
	assert.equal(resolveRequestId('line' + String.fromCharCode(10) + 'break'), null);
	assert.equal(resolveRequestId('ansi' + String.fromCharCode(27) + '[31m'), null);
});

test('mimeLookup maps known extensions case-insensitively and falls back to octet-stream', () => {
	assert.equal(mimeLookup('app.js'), 'text/javascript');
	assert.equal(mimeLookup('IMAGE.PNG'), 'image/png');
	assert.equal(mimeLookup('archive.tar.gz'), 'application/gzip');
	assert.equal(mimeLookup('noextension'), 'application/octet-stream');
	assert.equal(mimeLookup('weird.xyz'), 'application/octet-stream');
});

test('isDedupBufferable excludes event streams only', () => {
	assert.equal(isDedupBufferable(new Response('x', { headers: { 'content-type': 'text/event-stream' } })), false);
	assert.equal(isDedupBufferable(new Response('x', { headers: { 'content-type': 'TEXT/EVENT-STREAM; charset=utf-8' } })), false);
	assert.equal(isDedupBufferable(new Response('x', { headers: { 'content-type': 'text/html' } })), true);
	assert.equal(isDedupBufferable(new Response('x')), true);
});
