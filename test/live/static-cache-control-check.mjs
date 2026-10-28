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
const { staticCache } = await import('../fixture/build/handler/state.js');
const server = start('127.0.0.1', 0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-cache-policy-'));
const unicodePolicy = 'private, x-note="Gr\u00fc\u00dfe"';
const rules = [
	{ pattern: '/tree/', cacheControl: 'public, max-age=60' },
	{ pattern: '/tree/deep/exact.txt', cacheControl: 'no-store' },
	{ pattern: '/tree/deep/', cacheControl: 'private, max-age=20' },
	{ pattern: '/page/', cacheControl: 'public, max-age=90' },
	{ pattern: '/unicode.txt', cacheControl: unicodePolicy },
	{ pattern: '/_app/', cacheControl: 'no-store' }
];

function request(target, method, coding, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: server.port, path: target, method,
			headers: { 'accept-encoding': coding, ...headers } }, res => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		req.setTimeout(5000, () => req.destroy(new Error('static cache policy request timed out')));
		req.on('error', reject); req.end();
	});
}

const cases = [
	['tree/item.txt', 'public, max-age=60', 200],
	['tree/deep/exact.txt', 'no-store', 200],
	['tree/deep/other.txt', 'private, max-age=20', 200],
	['tree/big.txt', 'public, max-age=60', 5 * 1024 * 1024],
	['outside.txt', 'no-cache', 200],
	['unicode.txt', unicodePolicy, 200],
	['_app/immutable/app.js', 'public, max-age=31536000, immutable', 200],
	['page/index.html', 'public, max-age=90', 200]
];
let passed = 0;
try {
	const bodies = new Map();
	for (const [name, , size] of cases) {
		const target = path.join(dir, name); const body = Buffer.alloc(size, 97);
		const variants = { identity: body, br: zlib.brotliCompressSync(body), gzip: zlib.gzipSync(body) };
		bodies.set(name, variants); fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, body); fs.writeFileSync(target + '.br', variants.br); fs.writeFileSync(target + '.gz', variants.gzip);
	}
	cacheDir(dir, '/policy-base', true, { 'x-policy': 'retained' }, rules);
	cacheDir(dir, '/policy-pages', false, null, rules);
	assert.ok(staticCache.get('/policy-base/tree/big.txt').file, 'native disk lane is exercised');
	assert.ok(staticCache.get('/policy-base/tree/item.txt').buffer, 'native memory lane is exercised');
	for (const [name, policy] of cases) for (const coding of ['identity', 'br', 'gzip']) {
		const target = '/policy-base/' + name;
		const wirePolicy = Buffer.from(policy, 'utf8').toString('latin1');
		for (const method of ['GET', 'HEAD']) {
			const full = await request(target, method, coding);
			assert.equal(full.status, 200, `${method} ${coding} ${name}`);
			assert.equal(full.headers['cache-control'], wirePolicy); assert.equal(full.headers['x-policy'], 'retained');
			assert.equal(full.headers['content-encoding'], coding === 'identity' ? undefined : coding);
			assert.deepEqual(full.body, method === 'HEAD' ? Buffer.alloc(0) : bodies.get(name)[coding]);
			const tagged = await request(target, method, coding, { 'if-none-match': full.headers.etag || '*' });
			assert.equal(tagged.status, 304); assert.equal(tagged.headers['cache-control'], wirePolicy);
			assert.equal(tagged.headers['x-policy'], 'retained'); assert.equal(tagged.headers['content-type'], undefined);
			assert.equal(tagged.body.length, 0); passed++;
		}
		if (!name.includes('/immutable/')) {
			const ranged = await request(target, 'GET', coding, { range: 'bytes=0-3' });
			assert.equal(ranged.status, 206); assert.equal(ranged.headers['cache-control'], wirePolicy);
			assert.deepEqual(ranged.body, bodies.get(name)[coding].subarray(0, 4)); passed++;
		}
	}
	const page = await request('/policy-pages/page/', 'GET', 'identity');
	assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'public, max-age=90'); passed++;
	for (const coding of ['identity', 'br', 'gzip']) {
		const configured = await request('/test.txt', 'GET', coding);
		assert.equal(configured.status, 200); assert.equal(configured.headers['cache-control'], 'public, max-age=600', 'factory option reaches the built server');
		const tagged = await request('/test.txt', 'HEAD', coding, { 'if-none-match': configured.headers.etag });
		assert.equal(tagged.status, 304); assert.equal(tagged.headers['cache-control'], 'public, max-age=600'); passed++;
	}
	console.log(`static-cache-control: ${passed} native policy/coding cases passed`);
} finally {
	await server.stop(true);
	fs.rmSync(dir, { recursive: true, force: true });
}
