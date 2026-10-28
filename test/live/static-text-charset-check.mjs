// Content-Type declarations and unchanged UTF-8 bytes through the built server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { serverEnv } from './harness.mjs';

for (const [key, value] of Object.entries(serverEnv({}))) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
const { start } = await import('../fixture/build/server.js');
const { cacheDir } = await import('../fixture/build/handler/static-assets.js');
const server = start('127.0.0.1', 0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-text-charset-'));
const body = Buffer.from('Gr\u00fc\u00dfe aus K\u00f6ln. \u65e5\u672c\u8a9e.\n'.repeat(120));
const textTypes = {
	css: 'text/css', csv: 'text/csv', htm: 'text/html', html: 'text/html',
	ics: 'text/calendar', js: 'text/javascript', mjs: 'text/javascript',
	md: 'text/markdown', txt: 'text/plain', vtt: 'text/vtt', yaml: 'text/yaml', yml: 'text/yaml'
};
const expectedTypes = {
	...Object.fromEntries(Object.entries(textTypes).map(([ext, type]) => [ext, type + '; charset=utf-8'])),
	json: 'application/json', xml: 'text/xml', rtf: 'text/rtf', svg: 'image/svg+xml',
	png: 'image/png', bin: 'application/octet-stream'
};

function request(target, method, coding, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: server.port, path: target, method,
			headers: { 'accept-encoding': coding, ...headers } }, res => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		req.setTimeout(5000, () => req.destroy(new Error('static charset request timed out')));
		req.on('error', reject);
		req.end();
	});
}

let passed = 0;
try {
	for (const ext of Object.keys(expectedTypes)) {
		const file = path.join(dir, 'text.' + ext);
		fs.writeFileSync(file, body);
		fs.writeFileSync(file + '.br', zlib.brotliCompressSync(body));
		fs.writeFileSync(file + '.gz', zlib.gzipSync(body));
	}
	cacheDir(dir, '/charset-static', true);
	cacheDir(dir, '/charset-prerender', false);
	for (const method of ['GET', 'HEAD']) {
		for (const coding of ['identity', 'br', 'gzip']) {
			const decode = coding === 'br' ? zlib.brotliDecompressSync : coding === 'gzip' ? zlib.gunzipSync : bytes => bytes;
			for (const [ext, expected] of Object.entries(expectedTypes)) {
				const target = '/charset-static/text.' + ext;
				const full = await request(target, method, coding);
				assert.equal(full.status, 200, `${method} ${coding} .${ext}`);
				assert.equal(full.headers['content-type'], expected);
				assert.equal(full.headers['content-encoding'], coding === 'identity' ? undefined : coding);
				if (method === 'HEAD') assert.equal(full.body.length, 0);
				else assert.deepEqual(decode(full.body), body);
				assert.ok(full.headers.etag);
				const tagged = await request(target, method, coding, { 'if-none-match': full.headers.etag });
				assert.equal(tagged.status, 304);
				assert.equal(tagged.headers['content-type'], undefined);
				assert.equal(tagged.headers.etag, full.headers.etag);
				assert.equal(tagged.body.length, 0);
				passed++;
			}
			const prerender = await request('/charset-prerender/text', method, coding);
			assert.equal(prerender.status, 200);
			assert.equal(prerender.headers['content-type'], 'text/html; charset=utf-8');
			if (method === 'HEAD') assert.equal(prerender.body.length, 0);
			else assert.deepEqual(decode(prerender.body), body);
			passed++;
		}
	}
	console.log(`static-text-charset: ${passed} live cases passed`);
} finally {
	server.stop(true);
	fs.rmSync(dir, { recursive: true, force: true });
}
