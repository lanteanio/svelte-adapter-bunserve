// Two requests in one TCP write, against the production HTTP dispatcher.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8831;

function pipeline(first) {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port: PORT });
		const chunks = [];
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; socket.destroy(); }, 2000);
		socket.on('connect', () => socket.write(
			`GET ${first} HTTP/1.1\r\nHost: localhost\r\n\r\n`
			+ 'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
		));
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('error', reject);
		socket.on('close', () => {
			clearTimeout(timer);
			resolve({ bytes: Buffer.concat(chunks), timedOut });
		});
	});
}

// These buffered responses carry a length, so consume complete bodies rather
// than searching arbitrary body text for something resembling a status line.
function responses(bytes) {
	const replies = [];
	while (bytes.length) {
		const split = bytes.indexOf('\r\n\r\n');
		assert.ok(split >= 0, 'complete response headers');
		const headers = bytes.subarray(0, split).toString();
		const length = /^content-length: (\d+)$/im.exec(headers);
		assert.ok(length, `buffered response carries Content-Length: ${headers}`);
		const end = split + 4 + Number(length[1]);
		assert.ok(bytes.length >= end, 'complete response body');
		replies.push({ headers, body: bytes.subarray(split + 4, end).toString() });
		bytes = bytes.subarray(end);
	}
	return replies;
}

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe', stderr: 'pipe'
});
try {
	await waitForServer(proc, PORT);
	const sync = await pipeline('/healthz');
	assert.equal(sync.timedOut, false, 'synchronous pipeline closes itself');
	const replies = responses(sync.bytes);
	assert.equal(replies.length, 2, 'both synchronous requests complete');
	for (const reply of replies) {
		assert.match(reply.headers, /^HTTP\/1\.1 200 /);
		assert.equal(reply.body, 'OK');
	}
	console.log('  ok  /healthz then /healthz responds twice');
	// Prove the delayed route itself works before attributing an empty stream
	// to pipelining. Its load awaits 150ms before returning the page.
	const standalone = await fetch(`http://127.0.0.1:${PORT}/slow`);
	assert.equal(standalone.status, 200);
	assert.match(await standalone.text(), /<!doctype html>/i);
	const asyncFirst = await pipeline('/slow');
	assert.equal(asyncFirst.timedOut, false, 'the transport closes the async pipeline');
	assert.equal(asyncFirst.bytes.length, 0, 'no partial or reordered async response');
	console.log('  ok  delayed /slow then /healthz closes without a response');
	console.log('http-pipelining-check: 2 passed');
} finally {
	proc.kill();
	await proc.exited;
}
