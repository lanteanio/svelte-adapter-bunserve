import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import uws from '../../src/vite.js';

const servers = [];
const clients = [];

afterEach(async () => {
	for (const ws of clients.splice(0)) {
		try { ws.terminate(); } catch {}
	}
	for (const server of servers.splice(0).reverse()) {
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	}
});

async function bootDev(onMessage) {
	const httpServer = createServer((_req, res) => {
		res.statusCode = 404;
		res.end('Not Found');
	});
	servers.push(httpServer);
	const plugin = uws({ allowedOrigins: '*', handler: '/virtual-socket-arguments-handler' });
	await plugin.configureServer({
		httpServer,
		middlewares: { stack: [], use() {} },
		config: { root: process.cwd(), server: {}, logger: { warn() {}, info() {}, error() {} } },
		async ssrLoadModule() {
			const handler = { message: onMessage };
			return { default: handler, ...handler };
		}
	});
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	return httpServer.address().port;
}

async function connect(port, frames) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	clients.push(ws);
	ws.on('error', () => {});
	ws.on('message', (data, isBinary) => {
		if (isBinary) frames.push(['binary', [...data]]);
		else if (!data.toString().startsWith('{"type":"welcome"')) frames.push(['text', data.toString()]);
	});
	await new Promise((resolve) => ws.once('open', resolve));
	return ws;
}

async function until(frames, count) {
	for (let i = 0; i < 200 && frames.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(frames.length).toBeGreaterThanOrEqual(count);
}

describe('Vite dev hook socket arguments', () => {
	it('selects the opcode with isBinary and names byte and empty topics as production does', async () => {
		const results = [];
		const port = await bootDev((ws, { data, platform }) => {
			const command = Buffer.from(data).toString();
			if (command === 'sends') {
				ws.send(new Uint8Array([0x78]));
				ws.send('y', true);
				ws.send(new DataView(new Uint8Array([0, 0x7a]).buffer, 1, 1), false);
				try { ws.send(new Uint8Array([0xff]), false); } catch (error) { results.push(error.name); }
				try { ws.send(42); } catch (error) { results.push(error.message); }
				const scratch = new Uint8Array([0x71]);
				ws.send(scratch, true);
				scratch[0] = 0;
			}
			if (command === 'topics') {
				ws.subscribe(new TextEncoder().encode('bytes-topic'));
				ws.subscribe('');
				ws.subscribe('\x00ab');
				results.push(platform.subscribers('\x00ab'));
				results.push(ws.isSubscribed('bytes-topic'), ws.isSubscribed(new Uint8Array(0)));
				platform.publish('bytes-topic', 'probe', 1);
				platform.publish('', 'probe', 2);
			}
		});
		const frames = [];
		const ws = await connect(port, frames);
		ws.send('sends');
		await until(frames, 4);
		expect(frames.slice(0, 4)).toEqual([['text', 'x'], ['binary', [0x79]], ['text', 'z'], ['binary', [0x71]]]);
		expect(results).toEqual(['TypeError', 'Text and data can only be passed by String, ArrayBuffer or ArrayBufferView.']);
		ws.send('topics');
		await until(frames, 6);
		expect(results.slice(2)).toEqual([1, true, true]);
		expect(frames.slice(4).map(([, text]) => JSON.parse(text)).map(({ topic, data }) => [topic, data])).toEqual([['bytes-topic', 1], ['', 2]]);
	});
});
