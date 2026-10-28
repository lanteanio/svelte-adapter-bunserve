import assert from 'node:assert/strict';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { platform } = await import('../../src/runtime/handler/platform.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { wsConnections, wsCounters, WS_SUBSCRIPTIONS } = await import('../../src/runtime/handler/ws-state.js');
const { WS_PUBLISH_GRANT } = await import('../../src/runtime/utils/ws-symbols.js');
const { __setHooks } = await import('./ws-handler-stub.mjs');
const { upgradeData } = await import('./upgrade-data.mjs');

const opened = Promise.withResolvers();
const serverClosed = Promise.withResolvers();
__setHooks({
	open(ws) { opened.resolve(ws); },
	close() { serverClosed.resolve(); },
	subscribe: () => null,
	unsubscribe(ws, topic) {
		ws.send(JSON.stringify({ type: 'teardown', topic, stillSubscribed: topic === '' ? false : ws.isSubscribed(topic) }));
	}
});
const server = Bun.serve({
	hostname: '127.0.0.1', port: 0,
	fetch(request, srv) {
		if (srv.upgrade(request, { data: upgradeData() })) return;
		return new Response('upgrade required', { status: 400 });
	},
	websocket: websocketHandlers
});
const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
const frames = [];
const pending = new Map();
client.addEventListener('message', ({ data }) => {
	const frame = JSON.parse(data);
	frames.push(frame);
	if (frame.type === 'teardown') pending.get(frame.topic)?.resolve(frame);
});
const clientClosed = new Promise(resolve => client.addEventListener('close', resolve, { once: true }));
try {
	await new Promise((resolve, reject) => {
		client.addEventListener('open', resolve, { once: true });
		client.addEventListener('error', reject, { once: true });
	});
	const ws = await opened.promise;
	const data = ws.getUserData();
	const baseline = wsCounters.totalSubscriptions;
	const aborted = wsCounters.closedWsAborts;
	const topics = ['', 'a\u0000b', '__realtime', '__presence:room', 'x'.repeat(4000), 'room:M\u00fcller', 'absent'];
	for (const topic of topics) {
		if (topic === '__realtime') assert.equal(await platform.subscribe(ws, topic), null);
		else if (topic !== '' && topic !== 'absent') ws.subscribe(topic);
		if (topic !== '' && topic !== 'absent') assert.ok(ws.isSubscribed(topic), JSON.stringify(topic));
		data[WS_PUBLISH_GRANT] = topic;
		const teardown = Promise.withResolvers();
		pending.set(topic, teardown);
		client.send(JSON.stringify({ type: 'unsubscribe', topic, ref: 'ignored' }));
		const frame = await teardown.promise;
		pending.delete(topic);
		if (topic !== '') assert.equal(ws.isSubscribed(topic), false, JSON.stringify(topic));
		assert.equal(frame.stillSubscribed, false);
		assert.equal(data[WS_SUBSCRIPTIONS].has(topic), false);
		assert.equal(data[WS_PUBLISH_GRANT], undefined);
	}
	assert.equal(wsCounters.totalSubscriptions, baseline);
	assert.equal(wsCounters.closedWsAborts, aborted);
	client.close(1000);
	await Promise.all([clientClosed, serverClosed.promise]);
	assert.equal(wsConnections.size, 0);
	assert.equal(frames.filter(frame => frame.type === 'teardown').length, topics.length);
	assert.equal(frames.some(frame => ['unsubscribed', 'unsubscribe-denied', 'error'].includes(frame.type)), false);
	console.log('native unsubscribe: 7 topic shapes passed');
} finally {
	client.close();
	server.stop(true);
}
