import { expect, it } from 'bun:test';
import * as Y from 'yjs';
import { createTestServer } from '../../src/testing.js';
import { createCrdtAuthority } from '../../src/plugins/crdt/replica.js';
import { connectRealClient } from './client-helper.js';

for (const kind of ['insert', 'delete', 'formatted text']) {
	it('relays and persists ' + kind + ' changes once over actual sockets', async () => {
		const stores = [];
		const authority = createCrdtAuthority({ persist: { store(topic, bytes) { stores.push(bytes); } } });
		await authority.acquire('document');
		const server = await createTestServer({ handler: {
			async message(ws, { data, platform }) {
				const request = JSON.parse(Buffer.from(data).toString());
				let accepted = false;
				if (request.type === 'merge') {
					const bytes = authority.applyUpdate('document', request.bytes);
					accepted = bytes !== null;
					if (accepted) platform.publish('document', 'update', Array.from(bytes));
					await authority.persistNow('document');
				}
				platform.send(ws, 'receipt', 'merged', { nonce: request.nonce, accepted, stores: stores.length });
			}
		} });
		const sender = await connectRealClient(server.wsUrl);
		const receiver = await connectRealClient(server.wsUrl);
		const source = new Y.Doc();
		const restored = new Y.Doc();
		const received = new Y.Doc();
		let nonce = 0;
		async function request(client, bytes) {
			const id = ++nonce;
			client.send({ type: bytes ? 'merge' : 'barrier', bytes: bytes ? Array.from(bytes) : undefined, nonce: id });
			const answer = await client.waitFor(frame => frame?.topic === 'receipt' && frame.data?.nonce === id);
			expect(answer).not.toBeNull();
			return answer.parsed.data;
		}
		try {
			receiver.send({ type: 'subscribe', topic: 'document', ref: 1 });
			expect(await receiver.waitFor(frame => frame?.type === 'subscribed' && frame.ref === 1)).not.toBeNull();
			const updates = [];
			if (kind === 'formatted text') {
				const text = new Y.Text();
				source.getMap('root').set('text', text);
				text.insert(0, 'hello', { bold: true });
				updates.push(Y.encodeStateAsUpdate(source));
				source.on('update', bytes => updates.push(bytes));
				text.insert(5, ' world', { bold: true });
			} else {
				source.on('update', bytes => updates.push(bytes));
				source.getArray('items').push(['first']);
				if (kind === 'insert') source.getArray('items').push(['second']);
				else source.getArray('items').delete(0);
				updates.reverse(); // Exercise pending state before its predecessor.
			}
			expect(await request(sender, updates[0])).toMatchObject({ accepted: true, stores: 1 });
			expect(await request(sender, updates[0])).toMatchObject({ accepted: false, stores: 1 });
			Y.applyUpdate(restored, stores[0]);
			Y.applyUpdate(restored, updates[1]);
			const value = doc => kind === 'formatted text' ? doc.getMap('root').toJSON() : doc.getArray('items').toArray();
			const expected = kind === 'formatted text' ? { text: 'hello world' } : kind === 'insert' ? ['first', 'second'] : [];
			expect(value(restored)).toEqual(expected);
			expect(await request(sender, updates[1])).toMatchObject({ accepted: true, stores: 2 });
			expect(await request(sender, Y.encodeStateAsUpdate(source))).toMatchObject({ accepted: false, stores: 2 });
			await request(receiver);
			const relayed = receiver.frames.map(frame => JSON.parse(frame)).filter(frame => frame.event === 'update');
			expect(relayed).toHaveLength(2);
			for (const frame of relayed) Y.applyUpdate(received, new Uint8Array(frame.data));
			expect(value(received)).toEqual(expected);
		} finally {
			sender.close(); receiver.close();
			await server.close();
			authority.destroy(); source.destroy(); restored.destroy(); received.destroy();
		}
	});
}
