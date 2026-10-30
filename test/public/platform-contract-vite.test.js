import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import uws from '../../src/vite.js';
import { assertPlatformContract, PLATFORM_CONTRACT } from '../../src/platform-contract.js';

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

function withTimeout(promise, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(label + ' timed out')), 5000);
		})
	]).finally(() => clearTimeout(timer));
}

function check(platform, context) {
	try {
		assertPlatformContract(platform, PLATFORM_CONTRACT, { context });
		return 'ok';
	} catch (error) {
		return error.message;
	}
}

it('validates the Vite dev worker and connection platforms against the production contract', async () => {
	const httpServer = createServer((_req, res) => {
		res.statusCode = 404;
		res.end('Not Found');
	});
	servers.push(httpServer);
	const seen = {};
	let opened;
	const done = new Promise((resolve) => { opened = resolve; });
	const plugin = uws({ allowedOrigins: '*', handler: '/virtual-contract-handler' });
	await plugin.configureServer({
		httpServer,
		middlewares: { stack: [], use() {} },
		config: { root: process.cwd(), server: {}, logger: { warn() {}, info() {}, error() {} } },
		async ssrLoadModule() {
			const handler = {
				init({ platform }) { seen.init = check(platform, 'worker'); },
				open(_ws, { platform }) {
					seen.open = check(platform, 'connection');
					seen.requestId = typeof platform.requestId;
					opened();
				}
			};
			return { default: handler, ...handler };
		}
	});
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const ws = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/ws`);
	clients.push(ws);
	ws.on('error', () => {});
	await withTimeout(done, 'open');
	expect(check(globalThis.__uws_dev_platform, 'worker')).toBe('ok');
	expect(seen).toEqual({ init: 'ok', open: 'ok', requestId: 'string' });
});
