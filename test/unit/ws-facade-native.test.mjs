import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsFacade } from '../../src/runtime/handler/ws-facade.js';

test('native socket publish preserves peer delivery, exclusion and boolean results', {
	skip: !globalThis.Bun,
	timeout: 30000
}, async () => {
	const raw = [];
	const clients = [];
	const received = [[], []];
	const barriers = new Map();
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request, server) {
			if (server.upgrade(request, { data: {} })) return;
			return new Response('Upgrade required', { status: 426 });
		},
		websocket: {
			maxBackpressure: 1024,
			closeOnBackpressureLimit: false,
			open(ws) { raw.push(ws); },
			message() {}
		}
	});
	let serial = 0;
	async function flush() {
		await Promise.all(raw.map((ws, index) => new Promise(resolve => {
			const marker = `barrier:${serial++}:${index}`;
			barriers.set(marker, resolve);
			ws.send(marker);
		})));
	}
	try {
		for (let index = 0; index < 2; index++) {
			const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
			client.binaryType = 'arraybuffer';
			client.addEventListener('message', event => {
				if (typeof event.data === 'string' && barriers.has(event.data)) {
					barriers.get(event.data)();
					barriers.delete(event.data);
				} else {
					received[index].push(typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data)]);
				}
			});
			await new Promise((resolve, reject) => {
				client.addEventListener('open', resolve, { once: true });
				client.addEventListener('error', reject, { once: true });
			});
			clients.push(client);
		}
		const ws = wsFacade(raw[0], () => server);
		raw[1].subscribe('room');
		for (const payload of ['', new Uint8Array(0), 'never-member']) {
			assert.equal(ws.publish('room', payload), false);
			await flush();
			assert.deepEqual(received, [[], []]);
		}
		ws.subscribe('other');
		ws.unsubscribe('other');
		for (const memberships of ['none', 'self', 'peer', 'both', 'other-peer']) {
			for (const socket of raw) {
				socket.unsubscribe('room');
				socket.unsubscribe('other');
			}
			if (memberships === 'self' || memberships === 'both') ws.subscribe('room');
			const peer = memberships === 'peer' || memberships === 'both' || memberships === 'other-peer';
			if (peer) raw[1].subscribe('room');
			if (memberships === 'other-peer') ws.subscribe('other');
			const before = raw.map(socket => [...socket.subscriptions]);
			for (const payload of ['', new Uint8Array(0), 'hello']) {
				received[0].length = received[1].length = 0;
				assert.equal(ws.publish('room', payload), peer, memberships);
				await flush();
				assert.deepEqual(received[0], [], 'publisher never receives its own message');
				assert.deepEqual(received[1], peer ? [typeof payload === 'string' ? payload : []] : []);
				assert.deepEqual(raw.map(socket => [...socket.subscriptions]), before, 'membership is unchanged');
			}
		}
		ws.subscribe('room');
		raw[1].subscribe('room');
		const megabyte = 'x'.repeat(1024 * 1024);
		for (let i = 0; i < 32 && raw[1].getBufferedAmount() < 1024; i++) raw[1].send(megabyte);
		assert.ok(raw[1].getBufferedAmount() >= 1024, 'peer is beyond its backpressure limit');
		for (const payload of ['', new Uint8Array(0), 'hello', megabyte]) {
			assert.equal(ws.publish('room', payload), true, 'publication is not a delivery receipt');
		}
		ws.unsubscribe('room');
		ws.unsubscribe('other');
		assert.deepEqual(raw[0].subscriptions, []);
		assert.ok(raw[1].getBufferedAmount() >= 1024);
		for (const payload of ['', new Uint8Array(0), 'hello', megabyte]) {
			assert.equal(ws.publish('room', payload), true, 'unsubscribed publication keeps the same pressured-peer result');
		}
		assert.deepEqual(raw[0].subscriptions, [], 'pressure fallback does not add membership');
	} finally {
		for (const client of clients) client.close();
		await server.stop(true);
	}
});
