import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { connect as connectTcp } from 'node:net';
import { __setHooks } from '../helpers/ws-handler-stub.mjs';

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = { maxBackpressure: 64 * 1024, closeOnBackpressureLimit: false };
const { upgradeData } = await import('../helpers/upgrade-data.mjs');
const sockets = new Map();
const closedSockets = new Set();
const badDrains = [];
__setHooks({
	open(ws) { sockets.set(ws.getUserData().id, ws); },
	close(ws) { closedSockets.add(ws); },
	drain(ws) { if (closedSockets.has(ws)) badDrains.push(ws); }
});
const { platform } = await import('../../src/runtime/handler/platform.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { deliveryAuthorization } = await import('../../src/runtime/handler/delivery-authorization.js');
const { setServer, wsConnections, wsCounters, WS_CAPS, capCounts, pressureSnapshot } = await import('../../src/runtime/handler/ws-state.js');
const { sendControl } = await import('../../src/runtime/handler/control-egress.js');
const { drainWebSockets } = await import('../../src/runtime/handler/ws-drain.js');
const { startPressureSampling, stopPressureSampling } = await import('../../src/runtime/handler/pressure-metrics.js');
const { setOperationalEventSink } = await import('../../src/runtime/diagnostic.js');
const diagnostics = [];
setOperationalEventSink(event => diagnostics.push(event));

const server = Bun.serve({
	hostname: '127.0.0.1', port: 0,
	fetch(req, srv) {
		if (srv.upgrade(req, { data: upgradeData({ id: new URL(req.url).searchParams.get('id') }) })) return;
		return new Response('upgrade required', { status: 400 });
	},
	websocket: { ...websocketHandlers, backpressureLimit: 64 * 1024, closeOnBackpressureLimit: false }
});
setServer(server);
const pause = (ms = 1) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, detail) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) { if (check()) return; await pause(); }
	assert.fail('Timed out: ' + detail);
}
let id = 0;
let clients = [];
async function connect(caps = [], topic = 'room') {
	const name = String(++id);
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?id=${name}`);
	ws.binaryType = 'arraybuffer';
	const client = { ws, name, frames: [], code: null, socket: null };
	clients.push(client);
	ws.addEventListener('message', ({ data }) => {
		if (typeof data === 'string') {
			const parsed = JSON.parse(data);
			for (const value of parsed.type === 'batch' ? parsed.events : [parsed]) client.frames.push({ value, raw: JSON.stringify(value), binary: false });
		}
		else client.frames.push({ raw: Buffer.from(data).toString(), binary: true });
	});
	ws.addEventListener('close', event => { client.code = event.code; });
	await until(() => sockets.has(name) && ws.readyState === WebSocket.OPEN, 'native open');
	client.socket = sockets.get(name);
	if (caps.length) {
		ws.send(JSON.stringify({ type: 'hello', caps }));
		await until(() => client.socket.getUserData()[WS_CAPS]?.size === caps.length, 'hello capabilities');
	}
	assert.equal(await platform.subscribe(client.socket, topic), null);
	return client;
}
// Bun's WebSocket client normalizes 1001 to 1000. Read the actual close frame
// for shutdown, as the transport close-frame suite does.
async function connectRaw() {
	const name = String(++id);
	const socket = connectTcp(server.port, '127.0.0.1');
	const client = { ws: { close: () => socket.destroy() }, name, frames: [], code: null, socket: null };
	clients.push(client);
	let buffer = Buffer.alloc(0), upgraded = false;
	socket.on('connect', () => socket.write(
		`GET /ws?id=${name} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
		'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
	socket.on('data', chunk => {
		buffer = Buffer.concat([buffer, chunk]);
		if (!upgraded) {
			const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
			assert.match(buffer.subarray(0, end).toString(), /^HTTP\/1.1 101 /);
			buffer = buffer.subarray(end + 4); upgraded = true;
		}
		while (buffer.length >= 2) {
			const opcode = buffer[0] & 15;
			let length = buffer[1] & 127, offset = 2;
			if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
			assert.notEqual(length, 127, 'this fixture sends small frames');
			if (buffer.length < offset + length) return;
			const payload = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
			if (opcode === 8) { client.code = payload.readUInt16BE(0); socket.destroy(); return; }
			if (opcode === 1) client.frames.push({ value: JSON.parse(payload.toString()), raw: payload.toString(), binary: false });
		}
	});
	await until(() => sockets.has(name) && upgraded, 'raw handshake');
	client.socket = sockets.get(name);
	assert.equal(await platform.subscribe(client.socket, 'room'), null);
	return client;
}
const messages = client => client.frames.filter(frame => frame.binary || (frame.value?.topic && !frame.value.type));
const events = client => messages(client).map(frame => frame.binary ? frame.raw : frame.value.event);
const codec = (extra = {}) => ({ capability: 'delivery.bin:1', schemaVersion: 1,
	encode: (event, data) => new TextEncoder().encode(event + ':' + JSON.stringify(data)), ...extra });
const stateless = codec();
const shared = codec({ capability: 'delivery.shared:1', shared: true });
const stateful = codec({ capability: 'delivery.state:1', state: { onAttach: () => ({}) } });
for (const wire of [stateless, shared, stateful]) platform.registerWireCodec(wire);
const caps = ['batch', stateless.capability, shared.capability, stateful.capability, 'game.fanout:1'];
function issue(mode, event = 'value') {
	const value = { token: event };
	if (mode === 'publish') return platform.publish('room', event, value, { seq: true });
	if (mode === 'batch') return platform.publishBatched([{ topic: 'room', event, data: value }, { topic: 'room', event: event + '-2', data: value }]);
	if (mode === 'game') return platform.publishGame(null, 'room', event, value);
	if (mode === 'sendTo') return platform.sendTo(() => true, 'room', event, value);
	if (mode === 'wire') return platform.publishWire('room', event, value, stateless);
	if (mode === 'shared') return platform.publishWire('room', event, value, shared);
	if (mode === 'state') return platform.publishWire('room', event, value, stateful);
	if (mode === 'wireBatch') return platform.publishWireBatch('room', event, [{ data: value }, { data: { token: event + '-2' } }], stateful);
	for (const client of clients) {
		if (mode === 'coalesced') platform.sendCoalesced(client.socket, { key: 'latest', topic: 'room', event, data: value });
		else if (mode === 'replay') platform.send(client.socket, '__replay:room', 'msg', { event, data: value });
		else if (mode === 'sendWire') platform.sendWire(client.socket, 'room', event, value, stateless);
		else if (mode === 'sendWireBatch') platform.sendWireBatch(client.socket, 'room', event, [{ data: value }], stateful);
		else platform.send(client.socket, 'room', event, value);
	}
}
let passed = 0;
async function check(name, action) {
	try { await action(); passed++; console.log('PASS ' + name); }
	finally {
		for (const client of clients) client.ws.close();
		await until(() => wsConnections.size === 0, 'native close cleanup');
		clients = [];
		deliveryAuthorization.reset();
	}
}
try {
	for (const mode of ['publish', 'batch', 'send', 'coalesced', 'replay', 'game', 'sendTo', 'wire', 'shared', 'state', 'wireBatch', 'sendWire', 'sendWireBatch']) {
		await check('revocation ' + mode, async () => {
			let victim;
			platform.authorizeDelivery((ws, context) => {
				if (context.binary) assert.equal(context.topic, 'room');
				if (context.kind === 'replay') assert.equal(context.topic, 'room');
				return ws !== victim;
			});
			const a = await connect(caps); const b = await connect(caps);
			issue(mode, 'before');
			await until(() => messages(a).length && messages(b).length, 'allowed frames');
			victim = a.socket;
			issue(mode, 'after');
			await until(() => a.code !== null, 'refused close');
			await until(() => messages(b).some(frame => frame.raw.includes('after')), 'unaffected recipient');
			assert.equal(a.code, 1013);
			assert.equal(messages(a).some(frame => frame.raw.includes('after')), false);
		});
	}
	for (const mode of ['publish', 'batch', 'sendTo', 'game', 'wire', 'shared', 'state', 'wireBatch']) {
		await check('shared text descriptor ' + mode, async () => {
			const seen = new Map();
			platform.authorizeDelivery((_ws, context) => {
				assert.equal(Object.isFrozen(context), true);
				const key = context.event + ':' + JSON.stringify(context.data);
				if (seen.has(key)) assert.equal(context, seen.get(key)); else seen.set(key, context);
				return true;
			});
			const a = await connect(['batch']); const b = await connect(['batch']);
			issue(mode);
			await until(() => messages(a).length && messages(b).length, 'shared parse deliveries');
		});
	}
	for (const mode of ['publish', 'wire', 'shared', 'state', 'wireBatch']) {
		await check('armed publication reports subscribers even when refused: ' + mode, async () => {
			platform.authorizeDelivery(() => false);
			const client = await connect(caps);
			assert.equal(issue(mode), true);
			await until(() => client.code !== null, 'refusal close');
			assert.equal(client.code, 1013); assert.equal(messages(client).length, 0);
		});
	}
	await check('held application, controls and latest coalesced value preserve order', async () => {
		let release;
		const held = new Promise(resolve => { release = resolve; });
		platform.authorizeDelivery((_ws, context) => context.event === 'held' ? held : true);
		const client = await connect();
		assert.equal(platform.send(client.socket, 'room', 'held', 1), 0);
		assert.ok(platform.bufferedAmount(client.socket) > 0);
		sendControl(client.socket, '{"type":"ordered-control"}');
		for (let i = 0; i < 5; i++) platform.sendCoalesced(client.socket, { key: 'k', topic: 'room', event: 'latest', data: i });
		await pause(15); assert.equal(messages(client).length, 0);
		release(true);
		await until(() => events(client).includes('latest'), 'latest flush after authorization');
		assert.deepEqual(client.frames.filter(frame => frame.value?.type !== 'welcome').map(frame => frame.value.event ?? frame.value.type), ['held', 'ordered-control', 'latest']);
		assert.equal(messages(client).at(-1).value.data, 4);
		assert.equal(platform.bufferedAmount(client.socket), 0);
	});
	for (const mode of ['publish', 'batch', 'sendTo', 'game', 'wire', 'shared', 'state', 'wireBatch']) {
		await check('policy reentry completes outer ' + mode, async () => {
			let nested = false;
			platform.authorizeDelivery((_ws, context) => {
				if (!nested && (context.event === 'outer' || context.binary)) {
					nested = true;
					platform.publish('room', 'after', { nested: true }, { seq: true });
				}
				return true;
			});
			const a = await connect(caps); const b = await connect(caps);
			issue(mode, 'outer');
			await until(() => events(a).includes('after') && events(b).includes('after'), 'nested publication');
			for (const client of [a, b]) {
				const relevant = messages(client);
				assert.equal(relevant.at(-1).value?.event, 'after');
				assert.ok(relevant.slice(0, -1).some(frame => frame.raw.includes('outer')));
			}
		});
	}
	for (const [name, decide, code] of [['throw', () => { throw Error('policy failed'); }, 1011], ['nonboolean', () => null, 1011], ['timeout', () => new Promise(() => {}), 1011]]) {
		await check('failure ' + name, async () => {
			platform.authorizeDelivery(decide, { timeoutMs: 20 });
			const client = await connect();
			platform.send(client.socket, 'room', 'refused', 'secret');
			await until(() => client.code !== null, name + ' close');
			assert.equal(client.code, code); assert.equal(messages(client).length, 0);
		});
	}
	for (const method of ['publish', 'publishWire', 'publishWireBatch', 'sendWire', 'sendWireBatch', 'publishBatched', 'publishGame']) {
		await check('nested ' + method + ' defers serialization and codec state', async () => {
			let issued = false, inside = false, serializations = 0, encodes = 0, target;
			const data = { toJSON() { assert.equal(inside, false); serializations++; return { token: 'nested' }; } };
			const wire = { ...stateful, encode(event, value, state) { assert.equal(inside, false); encodes++; return stateful.encode(event, value, state); } };
			platform.authorizeDelivery((_ws, context) => {
				if (!issued && context.event === 'outer') {
					issued = true; inside = true;
					const options = { seq: true, compress: false };
					if (method === 'publish') platform.publish('room', 'nested', data, options);
					else if (method === 'publishWire') platform.publishWire('room', 'nested', data, wire, options);
					else if (method === 'publishWireBatch') platform.publishWireBatch('room', 'nested', [{ data }], wire, options);
					else if (method === 'sendWire') assert.equal(platform.sendWire(target, 'room', 'nested', data, wire, { seq: 5 }), 0);
					else if (method === 'sendWireBatch') assert.equal(platform.sendWireBatch(target, 'room', 'nested', [{ data }], wire), 0);
					else if (method === 'publishBatched') platform.publishBatched([{ topic: 'room', event: 'nested', data, options }]);
					else assert.deepEqual(platform.publishGame(null, 'room', 'nested', data), { seq: null, delivered: 0 });
					options.seq = 'must not be reread';
					assert.equal(serializations, 0); assert.equal(encodes, 0); inside = false;
				}
				return true;
			});
			const client = await connect(caps); target = client.socket;
			platform.publish('room', 'outer', null);
			await until(() => messages(client).some(frame => frame.raw.includes('nested')), 'deferred nested frame');
			assert.equal(client.code, null); assert.ok(serializations > 0);
			assert.equal(messages(client)[0].value.event, 'outer');
		});
	}
	await check('native backpressure delays the policy until drain and catches revocation', async () => {
		let revoked = false, decisions = 0;
		platform.authorizeDelivery(() => { decisions++; return !revoked; }, { maxPendingBytes: 64 * 1024 * 1024 });
		const client = await connect();
		const payload = new Uint8Array(1 << 20);
		for (let i = 0; i < 20; i++) client.socket.send(payload, true, false);
		assert.ok(client.socket.getBufferedAmount() > 0);
		assert.equal(platform.send(client.socket, 'room', 'after-drain', null), 0);
		assert.equal(decisions, 0);
		revoked = true;
		await until(() => client.code !== null, 'revoked at native drain');
		assert.equal(client.code, 1013); assert.equal(decisions, 1);
		assert.equal(events(client).includes('after-drain'), false);
	});
	await check('late refusal after peer close reports no second close', async () => {
		let release;
		platform.authorizeDelivery(() => new Promise(resolve => { release = resolve; }));
		const client = await connect();
		platform.send(client.socket, 'room', 'held', null);
		client.ws.close(); await until(() => wsConnections.size === 0, 'peer close');
		const start = diagnostics.length; release(false);
		await until(() => diagnostics.length > start, 'late refusal diagnostic');
		assert.equal(diagnostics.at(-1).attributes.closeCode, null);
		assert.equal(platform.send(client.socket, 'room', 'too-late', null), 2);
	});
	await check('pending-byte overflow contributes to pressure without a metrics registry', async () => {
		let release;
		platform.authorizeDelivery(() => new Promise(resolve => { release = resolve; }), { maxPendingBytes: 1 });
		const client = await connect(); const before = wsCounters.droppedFramesWindow;
		assert.equal(platform.send(client.socket, 'room', 'held', 'payload'), 0);
		assert.equal(platform.send(client.socket, 'room', 'drop', 'payload'), 2);
		assert.equal(wsCounters.droppedFramesWindow, before + 1);
		assert.equal(wsCounters.transportMetricHooks, null);
		startPressureSampling({ sampleIntervalMs: 100 });
		await until(() => pressureSnapshot.droppedFrames >= 1 && pressureSnapshot.maxBufferedBytes > 0, 'pressure sample');
		stopPressureSampling(); release(true);
	});
	await check('direct native drop contributes to pressure without optional metrics', async () => {
		const client = await connect(); const before = wsCounters.droppedFramesWindow;
		const payload = new Uint8Array(1 << 20);
		for (let i = 0; i < 20; i++) client.socket.send(payload, true, false);
		assert.ok(wsCounters.droppedFramesWindow > before);
	});
	await check('shutdown waits for held authorization before close', async () => {
		let release;
		platform.authorizeDelivery(() => new Promise(resolve => { release = resolve; }), { timeoutMs: 1000 });
		const client = await connectRaw();
		platform.send(client.socket, 'room', 'last', 'payload');
		let done = false;
		const draining = drainWebSockets(0).then(() => { done = true; });
		await pause(15); assert.equal(done, false); assert.equal(client.code, null);
		release(true); await draining;
		await until(() => client.code !== null, 'shutdown close');
		assert.equal(client.code, 1001); assert.equal(events(client)[0], 'last');
	});
	assert.equal(badDrains.length, 0);
	assert.ok(diagnostics.some(event => event.event === 'delivery-authorization.denied' && event.attributes?.reason === 'denied'));
	assert.ok(diagnostics.some(event => event.event === 'delivery-authorization.failed' && event.attributes?.reason === 'timeout'));
	console.log(`${passed} native delivery authorization cases passed`);
} finally {
	stopPressureSampling();
	for (const client of clients) client.ws.close();
	deliveryAuthorization.reset(); setOperationalEventSink(null);
	server.stop(true);
}
