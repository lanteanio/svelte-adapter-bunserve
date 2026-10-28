import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

globalThis.PRECOMPRESS = true;
globalThis.STATIC_CACHE_MAX = 512;
globalThis.STATIC_DOTFILES = false;
const { cacheDir } = await import('../../src/runtime/handler/static-assets.js');
const { staticCache } = await import('../../src/runtime/handler/state.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-text-charset-'));
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const expectedTypes = {
	css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8',
	js: 'text/javascript; charset=utf-8', txt: 'text/plain; charset=utf-8',
	json: 'application/json', xml: 'text/xml', rtf: 'text/rtf',
	svg: 'image/svg+xml', bin: 'application/octet-stream'
};

for (const [lane, repetitions] of [['memory', 4], ['disk', 80]]) {
	test(`${lane} index preserves response MIME types and omits them from 304 metadata`, () => {
		const laneDir = path.join(dir, lane);
		fs.mkdirSync(laneDir);
		const body = Buffer.from('Gr\u00fc\u00dfe aus K\u00f6ln. \u65e5\u672c\u8a9e.\n'.repeat(repetitions));
		for (const ext of Object.keys(expectedTypes)) {
			const file = path.join(laneDir, 'sample.' + ext);
			fs.writeFileSync(file, body);
			fs.writeFileSync(file + '.br', zlib.brotliCompressSync(body));
			fs.writeFileSync(file + '.gz', zlib.gzipSync(body));
		}
		cacheDir(laneDir, '/charset-' + lane, false);
		for (const [ext, expected] of Object.entries(expectedTypes)) {
			const entry = staticCache.get(`/charset-${lane}/sample.${ext}`);
			assert.ok(lane === 'disk' ? entry.file : entry.buffer, `${ext}: ${lane} source`);
			assert.equal(entry.hasBr, true, ext);
			assert.equal(entry.hasGz, true, ext);
			for (const key of ['headers', 'brHeaders', 'gzHeaders']) {
				assert.equal(new Headers(entry[key]).get('content-type'), expected, `${ext}: ${key}`);
			}
			for (const key of ['notModified', 'brNotModified', 'gzNotModified']) {
				assert.equal(new Headers(entry[key]).get('content-type'), null, `${ext}: ${key}`);
			}
		}
	});
}
