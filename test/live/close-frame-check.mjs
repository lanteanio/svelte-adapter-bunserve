// The close rule on the wire. The frames are read off a raw socket, because
// Bun's own WebSocket client reports close codes it invented (1002, 1000,
// "Connection ended") rather than the ones the server sent.
//
// Each case opens a connection, asks the fixture to call end() or close() with
// the given arguments, and records the first close frame - or the refusal the
// fixture sends back when the call throws.

import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8819;
const BUILD = buildPath();

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/** A masked client text frame (payloads here stay under 64 KiB). */
function textFrame(text) {
	const payload = Buffer.from(text, 'utf8');
	const mask = randomBytes(4);
	const masked = Buffer.alloc(payload.length);
	for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
	const head = payload.length < 126
		? Buffer.from([0x81, 0x80 | payload.length])
		: Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
	return Buffer.concat([head, mask, masked]);
}

/**
 * Open a connection, send one fixture command once the welcome arrives (or
 * run `command` when it is a function), and report what came back: the close
 * frame, a refusal, or a close with no frame.
 *
 * @param {object | (() => unknown)} command
 * @returns {Promise<{ close?: { code: number | null, reason: Buffer }, refused?: string, noFrame?: true, error?: string }>}
 */
function drive(command) {
	return new Promise((resolve) => {
		const socket = connect(PORT, '127.0.0.1');
		let buf = Buffer.alloc(0);
		let upgraded = false;
		let sent = false;
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => done({ error: 'nothing within 3000ms' }), 3000);
		socket.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			if (!upgraded) {
				const end = buf.indexOf('\r\n\r\n');
				if (end < 0) return;
				upgraded = true;
				buf = buf.subarray(end + 4);
			}
			while (buf.length >= 2) {
				const opcode = buf[0] & 0x0f;
				let len = buf[1] & 0x7f;
				let at = 2;
				if (len === 126) {
					if (buf.length < 4) return;
					len = buf.readUInt16BE(2);
					at = 4;
				}
				if (buf.length < at + len) return;
				const payload = buf.subarray(at, at + len);
				buf = buf.subarray(at + len);
				if (opcode === 0x8) {
					done({ close: { code: payload.length >= 2 ? payload.readUInt16BE(0) : null, reason: payload.subarray(2) } });
					return;
				}
				if (opcode === 0x1) {
					const msg = JSON.parse(payload.toString('utf8'));
					if (!sent && msg.type === 'welcome') {
						sent = true;
						if (typeof command === 'function') command();
						else socket.write(textFrame(JSON.stringify(command)));
					} else if (msg.topic === '__fixture' && msg.event === 'end-refused') {
						done({ refused: msg.data.name });
					}
				}
			}
		});
		socket.on('close', () => done({ noFrame: true }));
		socket.on('error', (err) => done({ error: err.code }));
		socket.on('connect', () => socket.write(
			`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
		));
	});
}

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);

	const short = await drive({ type: 'fixture-end', code: 4001, reason: 'short' });
	check('a short reason goes out with its code unchanged',
		short.close?.code === 4001 && short.close.reason.toString('utf8') === 'short', JSON.stringify(short));

	// 1 + 41 * 3 = 124 bytes; Bun alone would cut at byte 123, inside the last
	// character, and a conforming peer fails a close with invalid UTF-8.
	const long = await drive({ type: 'fixture-end', code: 4000, reason: 'x' + '€'.repeat(41) });
	const longReason = long.close?.reason ?? Buffer.alloc(0);
	check('a long reason is cut at a character boundary, so the client can read it',
		long.close?.code === 4000 && longReason.length === 121 && longReason.toString('utf8') === 'x' + '€'.repeat(40),
		JSON.stringify({ code: long.close?.code, bytes: longReason.length }));

	const bytes = await drive({ type: 'fixture-end', code: 4002, reasonBytes: 'räume' });
	check('UTF-8 bytes go out as the text they encode, not as digits',
		bytes.close?.code === 4002 && bytes.close.reason.toString('utf8') === 'räume', JSON.stringify(bytes));

	const bare = await drive({ type: 'fixture-end' });
	check('end() with no code sends a close frame with no status (the client reads 1005)',
		bare.close !== undefined && bare.close.code === null && bare.close.reason.length === 0, JSON.stringify(bare));

	const refused = await drive({ type: 'fixture-end', code: 999, reason: 'nope' });
	check('an unsendable code throws a TypeError and the connection stays open to say so',
		refused.refused === 'TypeError', JSON.stringify(refused));

	const hard = await drive({ type: 'fixture-end', hard: true });
	check('close() drops the connection with no close frame', hard.noFrame === true, JSON.stringify(hard));

	const hardWithArgs = await drive({ type: 'fixture-end', hard: true, code: 1000, reason: 'bye' });
	check('close(code, reason) still drops it with no frame: the arguments are ignored',
		hardWithArgs.noFrame === true, JSON.stringify(hardWithArgs));

	// An advisory's close, read raw: Bun's own client reports this 1001 as 1000.
	const drained = await drive(() => {
		fetch(`http://127.0.0.1:${PORT}/drain?windowMs=50`, { method: 'POST' }).catch(() => {});
	});
	check('adviseReconnect closes with the protocol\'s 1001 after the advisory',
		drained.close?.code === 1001 && drained.close.reason.toString('utf8') === 'Server draining',
		JSON.stringify({ code: drained.close?.code, reason: drained.close?.reason?.toString('utf8'), other: drained }));

	check('the server is still running', proc.exitCode === null);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	proc.kill();
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log('failures:\n  - ' + failures.join('\n  - '));
	process.exit(1);
}
