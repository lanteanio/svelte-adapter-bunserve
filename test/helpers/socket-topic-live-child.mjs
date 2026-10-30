import assert from 'node:assert/strict';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { platform } = await import('../../src/runtime/handler/platform.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { setServer } = await import('../../src/runtime/handler/ws-state.js');
const { __setHooks } = await import('./ws-handler-stub.mjs');
const { upgradeData } = await import('./upgrade-data.mjs');

const opened = Promise.withResolvers();
__setHooks({ open(ws) { opened.resolve(ws); } });
const server = Bun.serve({
	hostname: '127.0.0.1', port: 0,
	fetch(request, srv) {
		if (srv.upgrade(request, { data: upgradeData() })) return;
		return new Response('upgrade required', { status: 400 });
	},
	websocket: websocketHandlers
});
setServer(server);
const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
const waiting = new Map();
client.addEventListener('message', ({ data }) => {
	const frame = JSON.parse(data);
	if (frame.event === 'probe') waiting.get(frame.data.n)?.(frame);
});
try {
	await new Promise((resolve, reject) => {
		client.addEventListener('open', resolve, { once: true });
		client.addEventListener('error', reject, { once: true });
	});
	const ws = await opened.promise;
	// Topics the socket names one way and the platform another: the empty
	// topic, which Bun refuses as a native name, and a topic given as bytes.
	const cases = [
		['', ''],
		[new Uint8Array(0), ''],
		[new TextEncoder().encode('bytes-topic'), 'bytes-topic'],
		[new TextEncoder().encode('room:M' + String.fromCharCode(0xfc) + 'ller'), 'room:M' + String.fromCharCode(0xfc) + 'ller']
	];
	let n = 0;
	for (const [socketName, platformName] of cases) {
		assert.equal(ws.subscribe(socketName), true);
		assert.equal(platform.subscribers(platformName), 1, JSON.stringify(platformName));
		const delivered = new Promise(resolve => waiting.set(n, resolve));
		assert.equal(platform.publish(platformName, 'probe', { n }), true, JSON.stringify(platformName));
		const frame = await delivered;
		assert.equal(frame.topic, platformName);
		assert.equal(ws.unsubscribe(socketName), true);
		assert.equal(platform.subscribers(platformName), 0);
		n++;
	}
	console.log(`socket topics: ${cases.length} spellings reach the platform`);
} finally {
	client.close();
	server.stop(true);
}
