import { test, expect } from 'bun:test';
import { createTestServer } from '../../src/testing.js';

test('an invalid admin Response status returns 500 without leaving the request pending', async () => {
	const server = await createTestServer({ handler: { admin: () => Response.error() } });
	try {
		for (const method of ['GET', 'HEAD', 'POST']) {
			const response = await fetch(server.url + '/__realtime', { method, signal: AbortSignal.timeout(2000) });
			expect(response.status).toBe(500);
			expect(response.headers.get('content-type')).toBe('application/json');
			expect(await response.text()).toBe(method === 'HEAD' ? '' : '{"error":"internal error"}');
		}
	} finally { await server.close(); }
});
