import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPath } from './harness.mjs';

const build = dirname(buildPath());
const { cacheDir, serveStatic } = await import(pathToFileURL(join(build, 'handler/static-assets.js')).href);
const { staticCache } = await import(pathToFileURL(join(build, 'handler/state.js')).href);
const dir = mkdtempSync(join(tmpdir(), 'bunserve-overflow-'));
try {
 const file = join(dir, 'large.txt');
 writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1, 65));
 writeFileSync(file + '.br', 'brotli representation');
 writeFileSync(file + '.gz', 'gzip representation');
 cacheDir(dir, '/overflow-test', false);
 const entry = staticCache.get('/overflow-test/large.txt');
 assert.ok(entry.file);
 assert.equal(entry.buffer, undefined);
 for (const [encoding, expected] of [['br', 'brotli representation'], ['gzip', 'gzip representation']]) {
  const headers = new Headers({ 'accept-encoding': encoding, range: 'bytes=2-5' });
  const res = serveStatic(entry, headers);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-encoding'), encoding);
  assert.equal(res.headers.get('content-range'), `bytes 2-5/${expected.length}`);
  assert.equal(await res.text(), expected.slice(2, 6));
  const head = serveStatic(entry, headers, true);
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal(await head.text(), '');
 }
 console.log('Bun.file ranges passed for Brotli and gzip, GET and HEAD');
} finally {
 rmSync(dir, { recursive: true, force: true });
}
