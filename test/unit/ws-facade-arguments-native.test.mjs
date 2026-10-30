import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { wsFacade } from '../../src/runtime/handler/ws-facade.js';

/**
 * A client that reads frames off the TCP stream itself, so the opcode and the
 * exact payload bytes are what is compared, not what a WebSocket client chose
 * to decode them into.
 */
async function rawClient(port) {
	const socket = connect(port, '127.0.0.1');
	const frames = [];
	const waiters = [];
	let buffered = Buffer.alloc(0);
	let upgraded = false;
	let resolveUpgrade;
	const ready = new Promise(resolve => { resolveUpgrade = resolve; });
	socket.on('connect', () => socket.write([
		'GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
		'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', ''
	].join('\r\n')));
	socket.on('data', chunk => {
		buffered = Buffer.concat([buffered, chunk]);
		if (!upgraded) {
			const split = buffered.indexOf('\r\n\r\n');
			if (split < 0) return;
			buffered = buffered.subarray(split + 4);
			upgraded = true;
			resolveUpgrade();
		}
		while (buffered.length >= 2) {
			const opcode = buffered[0] & 15;
			let length = buffered[1] & 127;
			let offset = 2;
			if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
			if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
			if (buffered.length < offset + length) return;
			frames.push({ opcode, bytes: [...buffered.subarray(offset, offset + length)] });
			buffered = buffered.subarray(offset + length);
			while (waiters.length > 0 && waiters[0].count <= frames.length) waiters.shift().resolve();
		}
	});
	await ready;
	return {
		frames,
		/** @param {number} count */
		until(count) {
			if (frames.length >= count) return Promise.resolve();
			return new Promise(resolve => waiters.push({ count, resolve }));
		},
		close() { socket.destroy(); }
	};
}

const TEXT = 1;
const BINARY = 2;

test('isBinary picks the opcode and every recognized string keeps its bytes on the wire', {
	skip: !globalThis.Bun,
	timeout: 30000
}, async () => {
	const raw = [];
	let opened;
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request, server) {
			if (server.upgrade(request, { data: {} })) return;
			return new Response('Upgrade required', { status: 426 });
		},
		websocket: { open(ws) { raw.push(ws); opened?.(); }, message() {} }
	});
	const clients = [];
	try {
		for (let index = 0; index < 2; index++) {
			const arrived = new Promise(resolve => { opened = resolve; });
			clients.push(await rawClient(server.port));
			await arrived;
		}
		const [ws, peer] = raw.map(socket => wsFacade(socket, () => server));
		const [own, other] = clients;

		const shared = new SharedArrayBuffer(3);
		new Uint8Array(shared).set([0x61, 0x62, 0x63]);
		const window = new Uint8Array([0x7a, 0x78, 0x79, 0x7a]).subarray(1, 3);
		const sends = [
			[['x', true], { opcode: BINARY, bytes: [0x78] }],
			[[new Uint8Array([0x78]), false], { opcode: TEXT, bytes: [0x78] }],
			[[new Uint8Array([0x78])], { opcode: TEXT, bytes: [0x78] }],
			[[shared, true], { opcode: BINARY, bytes: [0x61, 0x62, 0x63] }],
			[[new Uint8Array(shared, 1, 2), false], { opcode: TEXT, bytes: [0x62, 0x63] }],
			[[window, false], { opcode: TEXT, bytes: [0x78, 0x79] }],
			[[new DataView(window.buffer, 1, 2), true], { opcode: BINARY, bytes: [0x78, 0x79] }],
			[[String.fromCharCode(0xd800), true], { opcode: BINARY, bytes: [0xed, 0xa0, 0x80] }],
			[['', true], { opcode: BINARY, bytes: [] }]
		];
		for (const [args, frame] of sends) {
			assert.equal(ws.send(...args), 1);
			await own.until(own.frames.length + 1);
			assert.deepEqual(own.frames.at(-1), frame, JSON.stringify(args.map(String)));
		}
		assert.throws(() => ws.send(new Uint8Array([0xff]), false), TypeError);
		assert.throws(() => ws.send(42), /Text and data can only be passed by/);

		const topic = new TextEncoder().encode('bytes-topic');
		assert.equal(peer.subscribe(topic), true);
		assert.equal(peer.isSubscribed('bytes-topic'), true);
		assert.equal(peer.isSubscribed(topic.buffer), true);
		assert.equal(peer.subscribe(''), true);
		assert.equal(peer.isSubscribed(new Uint8Array(0)), true);
		assert.equal(peer.subscribe(new Uint8Array([0xff])), true);
		assert.equal(peer.isSubscribed(new Uint8Array([0xff])), true);
		assert.equal(peer.isSubscribed('\x00ff'), false);

		// Socket publication, then the server fallback once the publisher holds
		// no membership of its own.
		ws.subscribe('own');
		const publications = [
			[['bytes-topic', 'x', true], { opcode: BINARY, bytes: [0x78] }],
			[[topic, new Uint8Array([0x79]), false], { opcode: TEXT, bytes: [0x79] }],
			[['', 'e', false], { opcode: TEXT, bytes: [0x65] }],
			[[new Uint8Array([0xff]), shared, true], { opcode: BINARY, bytes: [0x61, 0x62, 0x63] }]
		];
		for (const holding of [true, false]) {
			if (!holding) ws.unsubscribe('own');
			for (const [args, frame] of publications) {
				assert.equal(ws.publish(...args), true);
				await other.until(other.frames.length + 1);
				assert.deepEqual(other.frames.at(-1), frame, JSON.stringify(args.map(String)));
			}
		}
		assert.equal(own.frames.length, sends.length);

		assert.equal(peer.unsubscribe(topic), true);
		assert.equal(peer.isSubscribed('bytes-topic'), false);
		assert.equal(peer.unsubscribe(''), true);
		assert.equal(peer.isSubscribed(''), false);
	} finally {
		for (const client of clients) client.close();
		server.stop(true);
	}
});
