import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setRuntimeEnv, resetRuntimeEnv } from '../../src/runtime/runtime.js';

globalThis.PRECOMPRESS = true;
globalThis.STATIC_CACHE_MAX = 1024;
globalThis.STATIC_DOTFILES = false;
const { cacheDir, serveStatic } = await import('../../src/runtime/handler/static-assets.js');
const { staticCache } = await import('../../src/runtime/handler/state.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-representation-'));
after(() => { resetRuntimeEnv(); fs.rmSync(dir, { recursive: true, force: true }); });
const file = path.join(dir, 'asset.txt');
fs.writeFileSync(file, 'identity '.repeat(30));
fs.writeFileSync(file + '.br', 'brotli bytes');
fs.writeFileSync(file + '.gz', 'gzip bytes');
const now = Date.UTC(2026, 9, 10, 12);
fs.utimesSync(file, new Date(now), new Date(now - 86400000));
setRuntimeEnv({ clock: { now: () => now } });
cacheDir(dir, '/representation', false, { expires: 'Sun, 11 Oct 2026 12:00:00 GMT', 'content-location': '/asset.txt', 'strict-transport-security': 'max-age=31536000', 'content-security-policy': "default-src 'self'", 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
const entry = staticCache.get('/representation/asset.txt');

test('filesystem mtimes and complete 304 policy metadata are preserved', () => {
	assert.equal(new Headers(entry.headers).get('last-modified'), new Date(now - 86400000).toUTCString());
	const res = serveStatic(entry, new Headers({ 'if-none-match': '*', 'accept-encoding': 'br' }));
	assert.equal(res.status, 304);
	assert.equal(res.headers.get('expires'), 'Sun, 11 Oct 2026 12:00:00 GMT');
	assert.equal(res.headers.get('content-location'), '/asset.txt');
	assert.equal(res.headers.get('etag'), entry.brEtag);
	for (const [key, value] of entry.brHeaders) {
		assert.equal(res.headers.get(key), ['content-type', 'content-encoding', 'content-disposition'].includes(key) ? null : value, key);
	}
});

test('ranges use negotiated bytes, total length, and headers for GET and HEAD', async () => {
	for (const encoding of ['br', 'gzip']) {
		const buffer = encoding === 'br' ? entry.brBuffer : entry.gzBuffer;
		const headers = new Headers({ 'accept-encoding': encoding, range: 'bytes=2-5' });
		const res = serveStatic(entry, headers);
		assert.equal(res.status, 206);
		assert.equal(res.headers.get('content-encoding'), encoding);
		assert.equal(res.headers.get('accept-ranges'), 'bytes');
		assert.equal(res.headers.get('content-range'), `bytes 2-5/${buffer.length}`);
		assert.deepEqual(Buffer.from(await res.arrayBuffer()), buffer.subarray(2, 6));
		const head = serveStatic(entry, headers, true);
		assert.equal(head.headers.get('content-length'), '4');
		assert.equal(await head.text(), '');
		const outside = serveStatic(entry, new Headers({ 'accept-encoding': encoding, range: 'bytes=100-' }));
		assert.equal(outside.status, 416);
		assert.equal(outside.headers.get('content-range'), `bytes */${buffer.length}`);
	}
});

test('weak If-Range never selects partial bytes and wildcard matches an untagged asset', () => {
	const res = serveStatic(entry, new Headers({ 'accept-encoding': 'br', range: 'bytes=0-3', 'if-range': entry.brEtag }));
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('content-encoding'), 'br');
	const immutable = { ...entry, etag: '', brEtag: '', gzEtag: '' };
	assert.equal(serveStatic(immutable, new Headers({ 'if-none-match': '*' })).status, 304);
});

for (const [label, size] of [['memory', 200], ['disk', 2048]]) {
	test(`${label} entries omit unreliable dates but keep validators for every representation`, () => {
		for (const [name, mtime] of [['future', now + 86400000], ['old', Date.UTC(1899, 0, 1)], ['past', Date.UTC(2020, 0, 1)]]) {
			const target = path.join(dir, `${label}-${name}.txt`);
			fs.writeFileSync(target, 'x'.repeat(size));
			fs.writeFileSync(target + '.br', 'br');
			fs.writeFileSync(target + '.gz', 'gz');
			fs.utimesSync(target, new Date(mtime), new Date(mtime));
		}
		// A direct stat value exercises the historical guard even on platforms
		// whose filesystem bindings wrap pre-epoch timestamps into future dates.
		const statSync = fs.statSync;
		try {
			fs.statSync = (target, ...args) => {
				const stat = statSync(target, ...args);
				return String(target).endsWith('-old.txt')
					? Object.assign(Object.create(stat), { mtimeMs: Date.UTC(1899, 0, 1) }) : stat;
			};
			cacheDir(dir, '/dates', false);
		} finally { fs.statSync = statSync; }
		for (const name of ['future', 'old', 'past']) {
			const candidate = staticCache.get(`/dates/${label}-${name}.txt`);
			assert.equal(Boolean(candidate.file), label === 'disk');
			for (const coding of ['identity', 'br', 'gzip']) {
				const headers = { 'accept-encoding': coding };
				const full = serveStatic(candidate, new Headers(headers), true);
				assert.equal(full.status, 200);
				const modified = full.headers.get('last-modified');
				assert.equal(modified, name === 'past' ? 'Wed, 01 Jan 2020 00:00:00 GMT' : null);
				assert.equal(serveStatic(candidate, new Headers({ ...headers, 'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT' }), true).status, name === 'past' ? 304 : 200);
				assert.equal(serveStatic(candidate, new Headers({ ...headers, 'if-unmodified-since': 'Sat, 01 Jan 2000 00:00:00 GMT' }), true).status, name === 'past' ? 412 : 200);
				const tagged = serveStatic(candidate, new Headers({ ...headers, 'if-none-match': full.headers.get('etag') }), true);
				assert.equal(tagged.status, 304);
				assert.equal(tagged.headers.get('last-modified'), modified);
			}
		}
	});
}
