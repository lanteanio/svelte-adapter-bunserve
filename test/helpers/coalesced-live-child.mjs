// Exercise both server surfaces with native Bun send results and client frames.
import assert from 'node:assert/strict';
import { isNativeError } from 'node:util/types';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { platform: productionPlatform } = await import('../../src/runtime/handler/platform.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { WS_COALESCED, wsConnections: productionConnections } = await import('../../src/runtime/handler/ws-state.js');
const { setOperationalEventSink } = await import('../../src/runtime/diagnostic.js');
const { __setHooks } = await import('./ws-handler-stub.mjs');
const { upgradeData } = await import('./upgrade-data.mjs');

let opened;
const serverSocket = new Promise((resolve) => { opened = resolve; });
const surface = process.argv[3] ?? 'production';
let platform = productionPlatform;
let wsConnections = productionConnections;
const hooks = {
	open(ws) { opened(ws); },
	message(ws, { msg }) {
		if (msg?.type === 'echo') platform.send(ws, 'probe', 'echo', msg.token);
	}
};
__setHooks(hooks);
let server;
if (surface === 'testing') {
	const { createTestServer } = await import('../../src/testing.js');
	server = await createTestServer({ handler: hooks });
	platform = server.platform;
	wsConnections = server.wsConnections;
} else server = Bun.serve({
	hostname: '127.0.0.1', port: 0,
	fetch(req, srv) {
		if (srv.upgrade(req, { data: upgradeData() })) return;
		return new Response('upgrade required', { status: 400 });
	},
	websocket: { ...websocketHandlers, backpressureLimit: 64 * 1024, closeOnBackpressureLimit: false }
});
const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
client.binaryType = 'arraybuffer';
const frames = [];
let binaryBytes = 0;
client.addEventListener('message', ({ data }) => {
	if (typeof data === 'string') frames.push(JSON.parse(data));
	else binaryBytes += data.byteLength;
});
const closed = new Promise((resolve) => client.addEventListener('close', resolve, { once: true }));
await new Promise((resolve, reject) => {
	client.addEventListener('open', resolve, { once: true });
	client.addEventListener('error', reject, { once: true });
});
const ws = await serverSocket;
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, label) {
	for (let i = 0; i < 2000; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.fail(`timed out waiting for ${label}`);
}
function send(key, data, event = 'value', topic = 'probe') {
	platform.sendCoalesced(ws, { key, topic, event, data });
}
const pad = new Uint8Array(1 << 20);
function stall() {
	// The client shares this event loop and cannot consume during this burst.
	const limit = surface === 'testing' ? 16 * 1024 * 1024 : 64 * 1024;
	for (let i = 0; i < (surface === 'testing' ? 40 : 16); i++) ws.send(pad, true, false);
	assert.ok(ws.getBufferedAmount() > limit, 'a real socket backlog was created');
	send('barrier', 'barrier');
	assert.ok(ws.getUserData()[WS_COALESCED].has('barrier'), 'the barrier was genuinely dropped and queued');
}
let token = 0;
async function echo() {
	const value = ++token;
	client.send(JSON.stringify({ type: 'echo', token: value }));
	await until(() => frames.some((frame) => frame.event === 'echo' && frame.data === value), 'echo');
}
async function delivered(start, event = 'done') {
	await until(() => frames.slice(start).some((frame) => frame.event === event), event);
	assert.equal(ws.getUserData()[WS_COALESCED].size, 0);
	return frames.slice(start).filter((frame) => frame.event !== 'echo' && frame.data !== 'barrier');
}

try {
	// Wait for an application reply so startup frames have arrived before sampling.
	await echo();
	const mode = process.argv[2];
	if (mode === 'repeat-same' || mode === 'repeat-new') {
		let calls = 0;
		const value = { toJSON() {
			calls++;
			send(mode === 'repeat-same' ? 'key' : calls, value);
			return calls;
		} };
		send('key', value);
		assert.equal(calls, 2, 'the first pass must yield');
		await echo();
		await until(() => calls > 2, 'the continuation');
		client.close();
		await closed;
		await until(() => wsConnections.size === 0, 'server close cleanup');
		const stopped = calls;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await turn();
		assert.equal(calls, stopped, 'serialization stopped after close');
	} else {
		let traps = 0;
		const hostile = new Proxy({}, {
			get() { traps++; throw new Error('get trap'); },
			getPrototypeOf() { traps++; throw new Error('prototype trap'); }
		});
		const failures = ['text', undefined, null, false, 42, Symbol('failure'), hostile, new Error('native')];
		for (const queued of [false, true]) {
			for (const failure of failures) {
				const start = frames.length;
				if (queued) stall();
				const reports = [];
				const original = console.error;
				setOperationalEventSink(event => {
					reports.push(event);
					throw new Error('reporter failed');
				});
				console.error = () => { throw new Error('console failed'); };
				try {
					const call = () => send('bad', { toJSON() { throw failure; } });
					if (queued) assert.doesNotThrow(call);
					else assert.throws(call, (err) => isNativeError(failure) ? err === failure : err instanceof TypeError);
					send('done', 'safe', 'done');
					const received = await delivered(start);
					assert.deepEqual(received, [{ topic: 'probe', event: 'done', data: 'safe' }]);
					assert.equal(reports.length, queued ? 1 : 0);
					for (const report of reports) {
						assert.equal(report.event, 'ws.send-coalesced.unserializable');
						assert.equal(report.source, 'svelte-adapter-bunserve');
						assert.equal(report.attributes.errorId, 'ADAPTER-ERR-COALESCED-UNSERIALIZABLE');
						assert.equal(report.attributes.error.name, isNativeError(failure) ? failure.name : 'TypeError');
					}
				} finally { setOperationalEventSink(null); console.error = original; }
				await echo();
			}
		}
		assert.equal(traps, 0);
		for (const queued of [false, true]) {
			for (const sameKey of [false, true]) {
				for (const fail of sameKey ? [false, true] : [false]) {
					const start = frames.length;
					if (queued) stall();
					let calls = 0;
					send('value', { toJSON() {
						calls++;
						send(sameKey ? 'value' : 'other', 2, 'latest');
						if (fail) throw new Error('superseded');
						return 1;
					} }, 'older');
					if (queued) await until(() => ws.getUserData()[WS_COALESCED].size === 0, 'reentrant drain');
					send('done', 'safe', 'done');
					const received = await delivered(start);
					assert.deepEqual(received.map((frame) => [frame.event, frame.data]), sameKey
						? [['latest', 2], ['done', 'safe']]
						: [['older', 1], ['latest', 2], ['done', 'safe']]);
					assert.equal(calls, 1);
					await echo();
				}
			}
		}
		for (const field of ['topic', 'event']) {
			for (const invalid of ['quote"', 'slash\\', 'line\n']) {
				const start = frames.length;
				stall();
				send('keep', 'original');
				assert.throws(() => platform.sendCoalesced(ws, {
					key: 'keep', topic: 'probe', event: 'value', data: 'bad', [field]: invalid
				}), /contains invalid character/);
				send('done', 'safe', 'done');
				assert.deepEqual((await delivered(start)).map((frame) => frame.data), ['original', 'safe']);
				await echo();
			}
		}
		// A fixed refused-send result keeps the capacity boundary deterministic.
		// Native delivery and backpressure are exercised above.
		const capData = {};
		const cappedWs = { getUserData: () => capData, send: () => 2 };
		const capSend = (key, data) => platform.sendCoalesced(cappedWs, { key, data, topic: 'probe', event: 'value' });
		capSend(undefined, 0);
		const pending = capData[WS_COALESCED];
		const entry = pending.get(undefined);
		for (let i = 0; i < 999_999; i++) pending.set(i, entry);
		capSend('newest', 1);
		assert.equal(pending.size, 1_000_000);
		assert.equal(pending.has(undefined), false);
		assert.equal(pending.has(0), true);
		pending.clear();
		await echo();
		assert.ok(binaryBytes > 0, 'the slow-consumer fill also reached the client');
		client.close();
		await closed;
		await until(() => wsConnections.size === 0, 'server close cleanup');
	}
	console.log(`coalesced ${surface} ${mode}: passed; echo and close cleanup verified`);
} finally {
	client.close();
	__setHooks({});
	if (surface === 'testing') await server.close();
	else await server.stop(true);
}
