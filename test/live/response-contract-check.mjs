import assert from 'node:assert/strict';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';
const port = 8871;
await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath()], { env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe' });
function raw(method, path, headers = {}, body = '') {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
			const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('HTTP timeout'))); req.end(body);
	});
}
function prefix(method, path, headers, body) {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
			const chunks = [];
			const finished = new Promise((done, fail) => { res.on('end', () => done(Buffer.concat(chunks))); res.on('error', fail); });
			finished.catch(() => {});
			res.on('data', chunk => { chunks.push(chunk); if (chunks.length === 1) resolve({ req, res, chunk, finished }); });
			res.on('error', reject);
		});
		req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('first bytes timed out'))); req.end(body);
	});
}
const inspect = async id => JSON.parse((await raw('GET', '/response-contract?mode=inspect&id=' + id)).body);
let checks = 0;
try {
	await waitForServer(proc, port);
	for (const lane of ['anonymous', 'cookie', 'post']) {
		const method = lane === 'post' ? 'POST' : 'GET';
		const headers = { 'accept-encoding': 'gzip', ...(lane === 'cookie' ? { cookie: 'session=1' } : {}) };
		for (const [mode, expected] of [['array', 'ZABCDZ'], ['views', 'ABBCDZ'], ['text', 'a'.repeat(4096)], ['blob', 'a'.repeat(4096)], ['transforms', 'a'.repeat(4096)]]) {
			const result = await raw(method, '/response-contract?mode=' + mode + '&te', headers, method === 'POST' ? 'complete' : '');
			assert.equal(result.status, 200);
			const bytes = result.headers['content-encoding'] === 'gzip' ? gunzipSync(result.body) : result.body;
			assert.equal(bytes.toString(), expected);
			if (mode === 'views' && lane !== 'anonymous') {
				assert.equal(result.headers['transfer-encoding'], 'chunked');
				assert.equal(result.headers['content-length'], undefined);
			} else {
				assert.equal(result.headers['transfer-encoding'], undefined);
				assert.equal(Number(result.headers['content-length']), result.body.length);
			}
			if (['text', 'blob', 'transforms'].includes(mode)) assert.equal(result.headers['content-encoding'] ?? '', lane === 'cookie' ? '' : 'gzip');
			checks++;
		}
		const turns = await raw(method, '/response-contract?mode=turns', headers, method === 'POST' ? 'complete' : '');
		assert.equal(turns.status, 200); assert.equal(turns.body.toString(), 'turn\n'.repeat(4));
		assert.equal(turns.headers['content-encoding'], undefined); assert.equal(turns.headers['content-length'], undefined); checks++;
		for (const mode of ['deferred', 'sse', 'cancel']) {
			const id = lane + '-' + mode;
			const result = await prefix(method, '/response-contract?mode=' + mode + '&id=' + id + '&te', headers, method === 'POST' ? 'complete' : '');
			assert.equal(result.chunk.toString(), 'shell\n');
			assert.equal(result.res.headers['content-encoding'], undefined);
			if (mode === 'cancel') {
				result.req.destroy();
				let state;
				for (let i = 0; i < 100; i++) { state = await inspect(id); if (state.cancels === 1 && !state.locked) break; await new Promise(resolve => setImmediate(resolve)); }
				assert.equal(state.cancels, 1, id); assert.equal(state.locked, false, id);
			} else {
				await raw('GET', '/response-contract?mode=release&id=' + id);
				assert.equal((await result.finished).toString(), 'shell\ntail\n');
			}
			checks++;
		}
	}
	for (const cookie of [false, true]) {
		const id = 'head-' + cookie;
		const result = await raw('HEAD', '/response-contract?mode=text&length&te&id=' + id, { 'accept-encoding': 'gzip', ...(cookie ? { cookie: 'session=1' } : {}) });
		assert.equal(result.status, 200); assert.equal(result.headers['content-length'], '4096'); assert.equal(result.headers['transfer-encoding'], undefined); assert.equal(result.headers['content-encoding'], undefined);
		assert.deepEqual(await inspect(id), { pulls: 0, cancels: 1, locked: false }); checks++;
	}
	const auth = await raw('POST', '/__ws/auth?mode=response&te', { 'x-requested-with': 'XMLHttpRequest' });
	assert.equal(auth.status, 200); assert.equal(auth.headers['transfer-encoding'], undefined); assert.equal(Number(auth.headers['content-length']), auth.body.length); assert.ok(JSON.parse(auth.body).requestId); checks++;
	const cap = await prefix('GET', '/response-contract?mode=cap&id=cap-prefix', { 'accept-encoding': 'gzip' });
	assert.ok(cap.chunk.length > 0); assert.ok(cap.chunk.every(byte => byte === 120)); assert.equal(cap.res.headers['content-encoding'], undefined);
	await raw('GET', '/response-contract?mode=release&id=cap-prefix');
	const capBytes = await cap.finished;
	assert.equal(capBytes.length, 40 * 16 * 1024); assert.ok(capBytes.every(byte => byte === 120)); checks++;
	for (const mode of ['bad', 'bad-object']) for (const cookie of [false, true]) {
		const id = mode + '-' + cookie;
		const bad = await raw('GET', '/response-contract?mode=' + mode + '&id=' + id, cookie ? { cookie: 'session=1' } : {});
		assert.equal(bad.status, 500); const state = await inspect(id); assert.equal(state.cancels, 1); assert.equal(state.locked, false); checks++;
	}
	for (const mode of ['sse-views', 'sse-bad', 'sse-bad-object']) {
		const result = await prefix('GET', '/response-contract?mode=' + mode + '&id=' + mode, {});
		assert.equal(result.chunk.toString(), 'shell\n');
		await raw('GET', '/response-contract?mode=release&id=' + mode);
		const bytes = await result.finished.catch(() => null);
		if (mode === 'sse-views') assert.equal(bytes.toString(), 'shell\nABBCDZGr' + String.fromCharCode(0xfc) + 'n');
		else { const state = await inspect(mode); assert.equal(state.cancels, 1); assert.equal(state.locked, false); }
		checks++;
	}
	console.log(`${checks} response byte, framing and streaming native checks passed`);
} finally { proc.kill(); await proc.exited; }
