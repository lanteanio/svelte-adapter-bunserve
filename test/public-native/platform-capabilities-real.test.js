import { afterEach, expect, it } from 'bun:test';
import { assertPlatformContract, PLATFORM_CONTRACT, TEST_PLATFORM_CONTRACT } from '../../src/platform-contract.js';
import { createTestServer } from '../../src/testing.js';
import { connectRealClient } from './client-helper.js';

let server;
let client;
afterEach(async () => { client?.close(); await server?.close(); client = null; server = null; });

it('validates every advertised test-server member on worker and real connection platforms', async () => {
	const checked = [];
	server = await createTestServer({ handler: {
		init({ platform }) {
			assertPlatformContract(platform, TEST_PLATFORM_CONTRACT, { context: 'worker' });
			checked.push('init');
		},
		open(ws, { platform }) {
			assertPlatformContract(platform, TEST_PLATFORM_CONTRACT, { context: 'connection' });
			platform.send(ws, 'contract', 'ready', { requestId: platform.requestId });
		}
	} });
	expect(checked).toEqual(['init']);
	expect(() => assertPlatformContract(server.platform, PLATFORM_CONTRACT, { context: 'worker' })).toThrow(
		'Platform activation failed for svelte-adapter-bunserve (worker): onPressure: missing function; onPublishRate: missing function. Supply the complete platform or the explicit contract declared by its adapter.'
	);
	client = await connectRealClient(server.wsUrl);
	const answer = await client.waitFor(frame => frame?.event === 'ready', 2000);
	expect(answer?.parsed.data.requestId).toEqual(expect.any(String));
});

it('accepts a callable metrics registry where the contract declares an object', async () => {
	const instrument = () => ({ inc() {}, set() {}, observe() {} });
	const registry = Object.assign(function metricsRegistry() {}, {
		counter: instrument, gauge: instrument, histogram: instrument, serialize: () => ''
	});
	const seen = [];
	server = await createTestServer({ metrics: registry, handler: {
		init({ platform }) {
			assertPlatformContract(platform, TEST_PLATFORM_CONTRACT, { context: 'worker' });
			seen.push(typeof platform.metrics);
		},
		open(ws, { platform }) {
			assertPlatformContract(platform, TEST_PLATFORM_CONTRACT, { context: 'connection' });
			platform.send(ws, 'contract', 'ready', { metrics: typeof platform.metrics });
		}
	} });
	client = await connectRealClient(server.wsUrl);
	const answer = await client.waitFor(frame => frame?.event === 'ready', 2000);
	expect(answer?.parsed.data.metrics).toBe('function');
	expect(seen).toEqual(['function']);
});
