import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { HANDSHAKE } from '../helpers/handshake.mjs';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const port = 8839;
await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe'
});
async function raw(target) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1');
		let received = '';
		socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timeout')));
		socket.on('error', reject);
		socket.on('data', chunk => {
			received += chunk.toString('latin1');
			const end = received.indexOf('\r\n\r\n');
			if (end >= 0) { socket.destroy(); resolve(received.slice(0, end)); }
		});
		socket.on('connect', () => socket.write(
			`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Probe-Url: 1\r\n` +
			Object.entries(HANDSHAKE).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n'
		));
	});
}
try {
	await waitForServer(proc, port);
	const headers = await raw('/ws?responseHeaders=1');
	assert.match(headers, /^HTTP\/1\.1 101 /);
	assert.deepEqual(headers.split('\r\n').filter(line => /^set-cookie:/i.test(line)).map(line => line.slice(line.indexOf(':') + 1).trim()), ['first=1', 'second=2']);
	assert.match(headers, /x-upgrade-value: tab\tvalue/i);
	assert.match(headers, /x-utf8: caf\xc3\xa9/i);
	assert.doesNotMatch(headers, /x-utf8: caf\xe9(?:\r\n|$)/i);
	assert.match(headers, /x-values: first, second/i);
	assert.match(headers, /x-duplicate: one, two/i);
	assert.match(headers, /x-spaces: trimmed(?:\r\n|$)/i);
	for (const [target, expected] of [['/ws', '/ws'], ['/ws?', '/ws'], ['/ws??', '/ws??'], ['/ws?x?', '/ws?x?']]) {
		const reply = await raw(target);
		assert.match(reply, /^HTTP\/1\.1 101 /);
		assert.equal(/^x-hook-url: (.+)$/im.exec(reply)?.[1].trim(), expected);
	}
	const responseObject = await raw('/ws?returnResponse=1');
	assert.match(responseObject, /^HTTP\/1\.1 101 /);
	assert.doesNotMatch(responseObject, /x-refusal:/i);
	await raw('/ws?responseHeaders=1');
	console.log('upgrade response preserves separate cookies, TAB and UTF-8 bytes; pins native comma joining and whitespace trimming');
} finally {
	proc.kill();
	await proc.exited;
	const stderr = await new Response(proc.stderr).text();
	assert.equal(stderr.split("Set-Cookie on the 101 upgrade response").length - 1, 1);
}
