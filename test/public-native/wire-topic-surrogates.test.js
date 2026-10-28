import { expect, it } from 'bun:test';
import { WebSocket } from 'ws';
import { createTestServer } from '../../src/testing.js';

const escape = String.fromCharCode(92) + 'u';
const high = escape + 'd83d';
const low = escape + 'de00';

async function exchange(topic, ref) {
	const server = await createTestServer({ allowNonAsciiTopics: true, handler: {} });
	const client = new WebSocket(server.wsUrl);
	try {
		await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { client.off('message', receive); reject(new Error('subscribe response timed out')); }, 2000);
			function receive(data) {
				const frame = JSON.parse(data.toString());
				if (frame.ref !== ref) return;
				clearTimeout(timer);
				client.off('message', receive);
				resolve(frame);
			}
			client.on('message', receive);
			client.send('{"type":"subscribe","topic":"' + topic + '","ref":"' + ref + '"}');
		});
	} finally {
		client.terminate();
		await server.close();
	}
}

it('denies lone and reversed surrogate escapes received over a native socket', async () => {
	for (const [index, topic] of ['chat:' + high, low + 'chat', 'chat:' + low + high].entries()) {
		expect(await exchange(topic, 'invalid-' + index)).toMatchObject({ type: 'subscribe-denied', reason: 'INVALID_TOPIC' });
	}
});

it('accepts a complete surrogate pair received as JSON escapes', async () => {
	expect(await exchange('chat:' + high + low, 'paired')).toMatchObject({ type: 'subscribed', topic: 'chat:' + String.fromCodePoint(0x1f600) });
});

it('denies an escaped astral topic beyond the UTF-16 unit limit', async () => {
	expect(await exchange((high + low).repeat(129), 'over-limit')).toMatchObject({ type: 'subscribe-denied', reason: 'INVALID_TOPIC' });
});
