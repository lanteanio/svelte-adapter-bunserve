import assert from 'node:assert/strict';
import { PLATFORM_MEMBERS } from 'svelte-adapter-bunserve/platform-contract';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const port = 8875;
await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe'
});
const clients = [];
async function connect() {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?user=platform-contract`);
	clients.push(ws);
	const frames = [];
	ws.onmessage = event => { if (typeof event.data === 'string') frames.push(JSON.parse(event.data)); };
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('platform contract connection timed out')), 5000);
		ws.onopen = () => { clearTimeout(timer); resolve(); };
		ws.onerror = error => { clearTimeout(timer); reject(error); };
	});
	return { ws, frames };
}
async function probe(client, ref) {
	client.ws.send(JSON.stringify({ type: 'fixture-platform-contract', ref }));
	for (let i = 0; i < 100; i++) {
		const frame = client.frames.find(value => value.event === 'platform-contract' && value.data.ref === ref);
		if (frame) return frame.data;
		await Bun.sleep(25);
	}
	throw new Error('platform contract response timed out');
}
try {
	await waitForServer(proc, port);
	const first = await connect();
	const before = await probe(first, 1);
	assert.deepEqual(before.members, PLATFORM_MEMBERS);
	assert.deepEqual(before.forwardedMembers, PLATFORM_MEMBERS);
	assert.equal(typeof before.requestId, 'string');
	assert.ok(before.requestId.length > 0);
	assert.equal(before.contextualRequestId, true);
	assert.equal(before.connections, 1);
	assert.equal(before.hasLiveConnectionGetter, true);
	const second = await connect();
	const other = await probe(second, 2);
	assert.notEqual(other.requestId, before.requestId);
	const after = await probe(first, 3);
	assert.equal(after.requestId, before.requestId);
	assert.equal(after.connections, 2, 'a retained forwarding wrapper reads the live production getter');
	assert.equal(after.hasLiveConnectionGetter, true);
	assert.equal(Object.isFrozen(PLATFORM_MEMBERS), true);
	console.log('Native production platform inventory, context and getter checks passed');
} finally {
	for (const ws of clients) ws.close();
	proc.kill();
	await proc.exited;
}
