import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const dir = mkdtempSync(join(tmpdir(), 'bunserve-framing-'));
const file = join(dir, 'body.txt');
writeFileSync(file, 'file body');
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
	const path = new URL(req.url).pathname;
	if (path === '/string') return new Response('caf\u00e9');
	if (path === '/bytes') return new Response(new Uint8Array([0, 1, 2, 3]));
	if (path === '/file') return new Response(Bun.file(file));
	return new Response('Bad Request', { status: 400 });
} });

async function raw(method, path, port = server.port, extra = '') {
	return new Promise((resolve, reject) => {
		let data = Buffer.alloc(0);
		const socket = connect({ port, host: '127.0.0.1' }, () => {
			socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\n${extra}Connection: close\r\n\r\n`);
		});
		socket.setTimeout(5000, () => socket.destroy(new Error(`response timeout ${method} ${path}: ${data.toString('latin1')}`)));
		socket.on('error', reject);
		socket.on('data', chunk => {
			data = Buffer.concat([data, chunk]);
			const end = data.indexOf('\r\n\r\n');
			if (end < 0) return;
			const headers = data.subarray(0, end).toString('latin1');
			const length = /content-length: (\d+)/i.exec(headers);
			if (method === 'HEAD' || (length && data.length - end - 4 >= Number(length[1])) ||
				(/transfer-encoding: chunked/i.test(headers) && data.subarray(-5).toString() === '0\r\n\r\n')) {
				socket.destroy();
				resolve(data);
			}
		});
		socket.on('end', () => resolve(data));
	});
}

try {
	for (const [path, length] of [['/string', 5], ['/bytes', 4], ['/file', 9], ['/refusal', 11]]) {
		for (const method of ['GET', 'HEAD']) {
			const response = await raw(method, path);
			const split = response.indexOf('\r\n\r\n');
			const headers = response.subarray(0, split).toString('latin1');
			assert.match(headers, new RegExp(`content-length: ${length}(?:\\r\\n|$)`, 'i'), `${method} ${path}`);
			assert.doesNotMatch(headers, /transfer-encoding:/i);
			assert.equal(response.length - split - 4, method === 'HEAD' ? 0 : length);
		}
	}
	console.log('8 raw HTTP framing cases passed');
} finally {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
}


const port = 8838;
await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe'
});
function splitResponse(response) {
	const end = response.indexOf('\r\n\r\n');
	assert.ok(end > 0);
	return { headers: response.subarray(0, end).toString('latin1'), bytes: response.length - end - 4 };
}
try {
	await waitForServer(proc, port);
	for (const [path, status, extra] of [
		['/%ZZ', 400, ''], ['/__ws/auth', 405, ''], ['/test.txt', 200, ''],
		['/test.txt', 206, 'Range: bytes=0-3\r\n']
	]) {
		const get = splitResponse(await raw('GET', path, port, extra));
		const head = splitResponse(await raw('HEAD', path, port, extra));
		assert.match(get.headers, new RegExp(`^HTTP/1\\.1 ${status} `), path);
		assert.match(head.headers, new RegExp(`^HTTP/1\\.1 ${status} `), path);
		assert.match(get.headers, new RegExp(`content-length: ${get.bytes}(?:\\r\\n|$)`, 'i'), path);
		assert.match(head.headers, new RegExp(`content-length: ${get.bytes}(?:\\r\\n|$)`, 'i'), path);
		assert.doesNotMatch(get.headers, /transfer-encoding:/i, path);
		assert.doesNotMatch(head.headers, /transfer-encoding:/i, path);
		assert.equal(head.bytes, 0, path);
	}
	const get = splitResponse(await raw('GET', '/stream', port));
	const head = splitResponse(await raw('HEAD', '/stream', port));
	const bufferedHead = splitResponse(await raw('HEAD', '/target?value=framing', port));
	assert.doesNotMatch(bufferedHead.headers, /content-length:/i);
	assert.equal(bufferedHead.bytes, 0);
	assert.match(bufferedHead.headers, /transfer-encoding: chunked/i);
	assert.match(head.headers, /transfer-encoding: chunked/i);
	assert.doesNotMatch(get.headers, /content-length:/i);
	assert.ok(get.bytes > 0);
	assert.doesNotMatch(head.headers, /content-length:/i, 'streaming HEAD has no invented size');
	assert.equal(head.bytes, 0);
	for (const path of ['/healthz', '/readyz', '/test.txt', '/about/', '/target', '/stream', '/%ZZ', '/__ws/auth', '/definitely-not-here']) {
		const response = splitResponse(await raw('HEAD', path, port));
		const date = /^date: (.+)$/im.exec(response.headers)?.[1].trim();
		assert.ok(date && Math.abs(Date.parse(date) - Date.now()) < 5000, path + ': current Date');
		assert.equal(response.bytes, 0, path);
	}
	const dated = splitResponse(await raw('HEAD', '/head-contract?date&length', port));
	assert.doesNotMatch(dated.headers, /Sun, 06 Nov 1994 08:49:37 GMT/i);
	assert.equal(dated.headers.match(/^date:/gim)?.length, 1);
	const datedGet = splitResponse(await raw('GET', '/head-contract?date&length', port));
	assert.doesNotMatch(datedGet.headers, /Sun, 06 Nov 1994 08:49:37 GMT/i);
	assert.equal(datedGet.headers.match(/^date:/gim)?.length, 1);
	assert.match(dated.headers, /content-length: 4096/i);
	const declaredStream = splitResponse(await raw('HEAD', '/head-contract?stream&length', port));
	assert.match(declaredStream.headers, /content-length: 6/i);
	assert.doesNotMatch(declaredStream.headers, /transfer-encoding:/i);
	assert.match(declaredStream.headers, /date:/i);
	const full = splitResponse(await raw('GET', '/test.txt', port));
	const etag = /^etag: (.+)$/im.exec(full.headers)[1].trim();
	for (const method of ['GET', 'HEAD']) {
		const unchanged = splitResponse(await raw(method, '/test.txt', port, 'If-None-Match: ' + etag + '\r\n'));
		assert.match(unchanged.headers, /^HTTP\/1\.1 304 /);
		assert.doesNotMatch(unchanged.headers, /content-length:/i, '304 has no invented representation length');
		assert.equal(unchanged.bytes, 0);
		assert.match(unchanged.headers, /date:/i);
	}
	const range = splitResponse(await raw('HEAD', '/test.txt', port, 'Range: bytes=0-3\r\n'));
	assert.match(range.headers, /^HTTP\/1\.1 206 /);
	assert.match(range.headers, /date:/i);
	console.log('25 built-adapter raw HTTP framing and Date cases passed');
} finally {
	proc.kill();
	await proc.exited;
}
