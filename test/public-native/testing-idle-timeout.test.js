// createTestServer must APPLY the caller's idleTimeout, not swallow it. The
// harness once passed a bare literal 120 to the socket while accepting the
// option without complaint, so idle behaviour was untestable: observing an
// idle close meant waiting out two minutes. The assertion here is bound to an
// independent source - the native idle timeout closing a real socket - never to a
// value the harness reports about itself, so a report-versus-enforce split
// cannot satisfy it.
import { describe, it, expect, afterEach } from 'bun:test';


let server;

describe('createTestServer honours idleTimeout', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('refuses a misshaped value instead of silently ignoring it', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		// `idleTimeout: process.env.X` is the natural mistake and is a string.
		await expect(createTestServer({ idleTimeout: '30' })).rejects.toThrow(/must be a number/);
	});

	it('reaps a silent client at the configured timeout, not at the 120s default', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		// The raw client never answers protocol pings. The native idle timeout
		// must close it within this short budget; the 120s default is far beyond
		// the deadline and cannot satisfy the check.
		server = await createTestServer({ idleTimeout: 8 });
		const { connectRawWebSocket } = await import('./raw-websocket.js');
		const ws = await connectRawWebSocket(server.wsUrl);
		const started = Date.now();
		let timer;
		const closed = await Promise.race([
			ws.closed.then(() => Date.now() - started),
			new Promise(resolve => { timer = setTimeout(() => resolve(null), 25_000); })
		]).finally(() => { clearTimeout(timer); ws.close(); });
		expect(closed, 'the socket was never reaped: idleTimeout was not applied').not.toBeNull();
		expect(closed).toBeGreaterThanOrEqual(4_000);
		expect(closed).toBeLessThan(25_000);
	}, 40_000);
});
