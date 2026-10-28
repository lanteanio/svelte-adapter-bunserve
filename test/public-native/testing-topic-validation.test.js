import { expect, it } from 'bun:test';
import { createTestServer } from '../../src/testing.js';
import { connectRealClient } from './client-helper.js';

it('rejects unpaired surrogates in platform and wire subscriptions while accepting valid Unicode', async () => {
	let connection;
	const server = await createTestServer({ allowNonAsciiTopics: true, handler: { open(ws) { connection = ws; } } });
	const client = await connectRealClient(server.wsUrl);
	try {
		const topics = ['room-' + String.fromCharCode(0xd800), 'room-' + String.fromCharCode(0xdc00) + 'x'];
		for (const [index, topic] of topics.entries()) {
			expect(await server.platform.subscribe(connection, topic)).toBe('INVALID_TOPIC');
			client.send({ type: 'subscribe', topic, ref: index });
			const response = await client.waitFor(frame => frame?.ref === index);
			expect(response?.parsed).toMatchObject({ type: 'subscribe-denied', reason: 'INVALID_TOPIC' });
			expect(server.platform.subscribers(topic)).toBe(0);
		}
		const valid = 'room-' + String.fromCodePoint(0x1f680);
		expect(await server.platform.subscribe(connection, valid)).toBeNull();
		expect(server.platform.subscribers(valid)).toBe(1);
	} finally {
		client.close();
		await server.close();
	}
});
