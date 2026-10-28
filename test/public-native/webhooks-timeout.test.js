import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { deliverWebhook } from '../../src/plugins/webhooks/server.js';

describe('webhook transport deadlines', () => {
	it('tries the next validated address after a refused connection without spending a retry', async () => {
		let authority;
		const server = createServer((request, response) => {
			authority = request.headers.host;
			request.resume(); response.end('accepted');
		});
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const result = await deliverWebhook({
				url: `http://receiver.test:${server.address().port}/hook`,
				urlMode: 'off', resolve: async () => ['127.0.0.2', '127.0.0.1'],
				timeoutMs: 5000, retry: { attempts: 1 }
			}, 'room', 'changed', { value: 1 });
			expect(result).toEqual({ ok: true });
			expect(authority).toBe(`receiver.test:${server.address().port}`);
		} finally { await new Promise(resolve => server.close(resolve)); }
	}, 8000);
	for (const host of ['127.0.0.1', 'receiver.test']) {
		it(`settles and retries a non-answering ${host} endpoint`, async () => {
			let requests = 0;
			const sockets = new Set();
			const server = createServer(request => { requests++; request.resume(); });
			server.on('connection', socket => {
				sockets.add(socket);
				socket.on('close', () => sockets.delete(socket));
			});
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			try {
				const result = await deliverWebhook({
					url: `http://${host}:${server.address().port}/hook`,
					urlMode: 'off', resolve: async () => ['127.0.0.1'],
					timeoutMs: 50,
					retry: { attempts: 2, initialDelayMs: 1, maxDelayMs: 1 }
				}, 'room', 'changed', { value: 1 });
				expect(result.ok).toBe(false);
				expect(result.err.message).toBe('outbound webhook: timeout');
				expect(result.attempts).toBe(2);
				expect(requests).toBe(2);
			} finally {
				for (const socket of sockets) socket.destroy();
				await new Promise(resolve => server.close(resolve));
			}
		}, 3000);
	}
});
