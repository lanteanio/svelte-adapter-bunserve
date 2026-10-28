import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const port = 8897;
await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath('build-base')], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe'
});
function get(path, method = 'GET') {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path, method, headers: { 'accept-encoding': 'identity' } }, res => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		req.setTimeout(5000, () => req.destroy(new Error('Static response timed out')));
		req.on('error', reject); req.end();
	});
}
try {
	await waitForServer(proc, port);
	const directory = fileURLToPath(new URL('../fixture/build-base/client/foo/_app/immutable/', import.meta.url));
	const relative = readdirSync(directory, { recursive: true }).find(name => /\.[\w-]{6,}\.js$/.test(name));
	assert.equal(typeof relative, 'string', 'the build contains a hashed JavaScript asset');
	const asset = '/foo/_app/immutable/' + relative.replaceAll('\\', '/');
	const bytes = readFileSync(join(directory, relative));
	for (const method of ['GET', 'HEAD']) {
		const response = await get(asset, method);
		assert.equal(response.status, 200);
		assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
		assert.equal(response.headers.etag, undefined);
		assert.equal(response.headers['last-modified'], undefined);
		assert.deepEqual(response.body, method === 'GET' ? bytes : Buffer.alloc(0));
	}
	for (const [target, policy] of [['/foo/test.txt', 'public, max-age=600'], ['/foo/_app/version.json', 'no-cache']]) {
		const response = await get(target);
		assert.equal(response.status, 200);
		assert.equal(response.headers['cache-control'], policy);
		assert.match(response.headers.etag, /^W\/".+"$/);
		assert.ok(response.body.byteLength > 0);
	}
	console.log('4 built static cache cases under a configured base path passed');
} finally { proc.kill(); await proc.exited; }
