import { afterEach, expect, it } from 'bun:test';
import { createTestServer } from '../../src/testing.js';
import { setRuntimeEnv, resetRuntimeEnv, now as runtimeNow, monotonicNow } from '../../src/runtime/runtime.js';
import { connectRealClient } from './client-helper.js';

let server;
let client;
afterEach(async () => {
	resetRuntimeEnv();
	client?.close();
	await server?.close();
	server = null;
	client = null;
});

it('delivers the active clock, RNG and causal stamps through a real handler', async () => {
	let initialized;
	server = await createTestServer({ handler: {
		init({ platform }) { initialized = platform; },
		message(ws, { data, platform }) {
			platform.send(ws, 'runtime', 'reading', {
				nonce: JSON.parse(Buffer.from(data).toString()).nonce,
				now: platform.now(), monotonic: platform.monotonic(),
				float: platform.random.float(), u32: platform.random.u32(),
				uuid: platform.random.uuid(), bytes: Array.from(platform.random.bytes(3)),
				hlc: platform.hlc(), requestId: platform.requestId,
				warmup: platform.isWarmupRequest(new Request('http://localhost/')),
				pressureListener: 'onPressure' in platform, publishListener: 'onPublishRate' in platform
			});
		}
	} });
	expect(initialized).toBe(server.platform);
	expect('requestId' in initialized).toBe(false);
	expect('onPressure' in initialized).toBe(false);
	expect('onPublishRate' in initialized).toBe(false);
	client = await connectRealClient(server.wsUrl, { headers: { 'x-request-id': 'runtime-request' } });
	let wall = 700;
	setRuntimeEnv({
		// Every clock seam reads differently, so the frame proves which one each member reads.
		clock: { now: () => wall, wallEpoch: () => wall + 100, monotonic: () => wall + 0.5, processMonotonic: () => wall + 0.25 },
		rng: { float: () => 0.25, u32: () => 1234, uuid: () => '12345678-1234-1234-1234-123456789abc', bytes: n => new Uint8Array(n).fill(9) }
	});
	for (const [nonce, nextWall, logical] of [[1, 700, 0], [2, 650, 1], [3, 800, 0]]) {
		wall = nextWall;
		client.send({ nonce });
		const answer = await client.waitFor(frame => frame?.event === 'reading' && frame.data.nonce === nonce, 2000);
		expect(answer?.parsed.data).toEqual({
			nonce, now: nextWall, monotonic: nextWall + 0.5, float: 0.25, u32: 1234,
			uuid: '12345678-1234-1234-1234-123456789abc', bytes: [9, 9, 9],
			hlc: { wall: Math.max(700, nextWall), logical, nodeId: '12345678' },
			requestId: 'runtime-request', warmup: false, pressureListener: false, publishListener: false
		});
	}
});

it('reads the cached runtime wall clock and the epoch-anchored monotonic clock by default', async () => {
	server = await createTestServer();
	const { platform } = server;
	const first = platform.now();
	expect(first).toBe(runtimeNow());
	// A synchronous span cannot see the cache refresh, so an exact clock would differ here.
	const spinUntil = Date.now() + 5;
	while (Date.now() < spinUntil) { /* spin */ }
	expect(platform.now()).toBe(first);
	const deadline = performance.now() + 5000;
	while (platform.now() === first && performance.now() < deadline) await Bun.sleep(50);
	expect(platform.now()).toBeGreaterThan(first);
	expect(platform.hlc().wall).toBe(platform.now());

	const mono = platform.monotonic();
	expect(Math.abs(mono - monotonicNow())).toBeLessThan(50);
	expect(Math.abs(mono - Date.now())).toBeLessThan(5000);
	let prev = mono;
	for (let i = 0; i < 100000; i++) {
		const v = platform.monotonic();
		if (v < prev) throw new Error(`monotonic went backward: ${v} < ${prev}`);
		prev = v;
	}
}, 10000);

it('keeps HLC state per server without consuming RNG until the clock is read', async () => {
	let draws = 0;
	setRuntimeEnv({ clock: { now: () => 42 }, rng: { uuid: () => `${++draws}`.padStart(8, '0') + '-1234-1234-1234-123456789abc' } });
	server = await createTestServer();
	const before = draws;
	const second = await createTestServer();
	try {
		expect(draws).toBe(before);
		const a = server.platform.hlc();
		const b = second.platform.hlc();
		expect([a.wall, a.logical, b.wall, b.logical]).toEqual([42, 0, 42, 0]);
		expect(a.nodeId).not.toBe(b.nodeId);
		expect(server.platform.hlc()).toEqual({ ...a, logical: 1 });
	} finally { await second.close(); }
});
