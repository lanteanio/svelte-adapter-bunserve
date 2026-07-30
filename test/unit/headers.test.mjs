import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStaticHeaders, RESERVED_STATIC_HEADER_KEYS } from '../../src/runtime/utils/static-headers.js';
import { normalizeStaticHeaders } from '../../src/build-config.js';

test('mergeStaticHeaders returns base untouched when no overrides', () => {
	const base = [['vary', 'Accept-Encoding']];
	assert.equal(mergeStaticHeaders(base, null), base);
});

test('mergeStaticHeaders appends new keys and replaces existing non-reserved keys', () => {
	const base = [['x-content-type-options', 'nosniff'], ['vary', 'Accept-Encoding']];
	const merged = mergeStaticHeaders(base, { 'X-Frame-Options': 'DENY', 'x-content-type-options': 'custom' });
	assert.deepEqual(merged, [
		['x-content-type-options', 'custom'],
		['vary', 'Accept-Encoding'],
		['x-frame-options', 'DENY']
	]);
	// input not mutated
	assert.deepEqual(base, [['x-content-type-options', 'nosniff'], ['vary', 'Accept-Encoding']]);
});

test('mergeStaticHeaders never overrides reserved keys', () => {
	const base = [['vary', 'Accept-Encoding']];
	const merged = mergeStaticHeaders(base, { vary: 'Origin', etag: 'W/"x"' });
	assert.deepEqual(merged, [['vary', 'Accept-Encoding']]);
});

test('normalizeStaticHeaders null/absent input is a no-op', () => {
	assert.deepEqual(normalizeStaticHeaders(undefined), { headers: null, dropped: [] });
	assert.deepEqual(normalizeStaticHeaders(null), { headers: null, dropped: [] });
});

test('normalizeStaticHeaders lowercases keys and strips reserved keys loudly', () => {
	const r = normalizeStaticHeaders({ 'X-Frame-Options': 'DENY', ETag: 'W/"x"', 'Cache-Control': 'no-store' });
	assert.deepEqual(r.headers, { 'x-frame-options': 'DENY' });
	assert.deepEqual(r.dropped.sort(), ['cache-control', 'etag']);
});

test('normalizeStaticHeaders throws on non-object, non-string value, bad name, control chars', () => {
	assert.throws(() => normalizeStaticHeaders('nope'));
	assert.throws(() => normalizeStaticHeaders(['x']));
	assert.throws(() => normalizeStaticHeaders({ 'x-a': 42 }));
	assert.throws(() => normalizeStaticHeaders({ 'bad name': 'v' }));
	const crlf = String.fromCharCode(13) + String.fromCharCode(10);
	assert.throws(() => normalizeStaticHeaders({ 'x-a': 'line1' + crlf + 'x-injected: 1' }));
	assert.throws(() => normalizeStaticHeaders({ 'x-a': 'nul' + String.fromCharCode(0) + 'byte' }));
});

test('normalizeStaticHeaders returns null headers when everything was reserved', () => {
	const r = normalizeStaticHeaders({ ETag: 'x' });
	assert.equal(r.headers, null);
	assert.deepEqual(r.dropped, ['etag']);
});

test('reserved set covers the transfer/caching surface the handler owns', () => {
	for (const key of ['content-type', 'content-encoding', 'content-range', 'content-length', 'date', 'etag', 'vary', 'cache-control', 'accept-ranges']) {
		assert.ok(RESERVED_STATIC_HEADER_KEYS.has(key), key);
	}
});
