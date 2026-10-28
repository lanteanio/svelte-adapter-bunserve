import assert from 'node:assert/strict';
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';
const port = 8856;
await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe'
});
function raw(method, path, encoding = '') {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path, method, headers: { 'accept-encoding': encoding } }, res => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('error', reject);
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on('error', reject);
		req.setTimeout(5000, () => req.destroy(new Error('HTTP test timeout')));
		req.end();
	});
}
try {
	await waitForServer(proc, port);
	const path = '/head-contract';
	const identity = await raw('GET', path);
	assert.equal(identity.status, 200);
	assert.equal(identity.body.length, 4096);
	for (const [accept, expected] of [
		['gzip, br;q=0', 'gzip'], ['gzip;q=1, br;q=0.5', 'gzip'],
		['*', 'br'], ['br;q=0, *', 'gzip'], ['notbr, xgzip', ''],
		['BR;q=0, br', 'br'], ['br;q=0, br', ''],
		['br;q=0.0001, gzip;q=0.5', 'br'], ['gzip;q=1.5, br;q=1', 'br'],
		['identity;q=0, *;q=0', '']
	]) {
		const get = await raw('GET', path, accept);
		assert.equal(get.headers['content-encoding'] ?? '', expected, accept);
		const decoded = expected === 'br' ? brotliDecompressSync(get.body) : expected === 'gzip' ? gunzipSync(get.body) : get.body;
		assert.deepEqual(decoded, identity.body, accept);
		assert.equal(get.headers.vary?.toLowerCase().includes('accept-encoding') ?? false, !!expected, accept);
		const head = await raw('HEAD', path, accept);
		assert.equal(head.status, 200);
		assert.equal(head.headers['content-encoding'], undefined, accept);
		assert.equal(head.headers.vary, undefined, accept);
		assert.equal(head.body.length, 0, accept);
	}
	for (const stream of [false, true]) for (const length of [false, true]) {
		const id = String(Number(stream)) + String(Number(length));
		const query = '?id=' + id + (stream ? '&stream' : '') + (length ? '&length' : '');
		const head = await raw('HEAD', path + query, 'br');
		assert.equal(head.status, 200);
		assert.equal(head.body.length, 0);
		assert.equal(head.headers['content-encoding'], undefined);
		assert.equal(head.headers['content-length'], length ? (stream ? '6' : '4096') : undefined);
		const inspect = await raw('GET', path + '?inspect&id=' + id);
		assert.deepEqual(JSON.parse(inspect.body), { reads: 0, cancels: 1 }, query);
	}
	console.log('10 weighted SSR GET/HEAD pairs and 4 unread HEAD cancellation cases passed');
} finally {
	proc.kill();
	await proc.exited;
}
