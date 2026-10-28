import assert from 'node:assert/strict';
import { connect } from 'svelte-adapter-bunserve/client';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8846;
const url = `ws://127.0.0.1:${PORT}/ws`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('client integration deadline');
		await pause(5);
	}
}
await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }), stdout: 'pipe', stderr: 'pipe'
});
const stdout = new Response(proc.stdout).text();
const stderr = new Response(proc.stderr).text();
let connection, states, events, passed = 0;
function start(options = {}) {
	connection = connect({ url, maxReconnectAttempts: 0, ...options });
	states = []; events = [];
	connection.status.subscribe(value => states.push(value));
	connection.events.subscribe(value => { if (value) events.push(value); });
	return connection;
}
const echo = value => ({ type: 'fixture-client-echo', payload: value });
const echoed = value => events.some(event => event.event === 'echo' && event.data === value);
async function check(name, fn) {
	try { await fn(); console.log(`  ok  ${name}`); passed++; }
	finally { connection?.close(); connection = undefined; }
}
try {
	await waitForServer(proc, PORT);
	await check('send reports local socket admission and preserves serialization errors', async () => {
		start();
		assert.equal(connection.send(echo('connecting')), false);
		await waitFor(() => states.at(-1) === 'open');
		assert.equal(connection.send(echo('text')), true);
		assert.equal(connection.sendSerialized(JSON.stringify(echo('serialized'))), true);
		assert.equal(connection.send(new TextEncoder().encode(JSON.stringify(echo('binary')))), true);
		await waitFor(() => echoed('binary'));
		assert.deepEqual(events.filter(event => event.event === 'echo').map(event => event.data), ['text', 'serialized', 'binary']);
		const cyclic = {}; cyclic.self = cyclic;
		assert.throws(() => connection.send(cyclic), TypeError);
		connection.close();
		assert.equal(connection.send(echo('closed')), false);
	});
	await check('serialization that closes the connection is not admitted', async () => {
		start(); await waitFor(() => states.at(-1) === 'open');
		assert.equal(connection.send({ toJSON() { connection.close(); return echo('never'); } }), false);
		assert.equal(states.at(-1), 'failed');
	});
	await check('pause and resume preserve subscriptions, listeners and queued FIFO sends', async () => {
		const observer = new WebSocket(url);
		const snapshots = [];
		observer.addEventListener('message', message => {
			const frame = JSON.parse(message.data);
			if (frame.event === 'stats') snapshots.push(frame.data);
		});
		await new Promise((resolve, reject) => {
			observer.addEventListener('open', resolve, { once: true });
			observer.addEventListener('error', reject, { once: true });
		});
		async function serverCount(expected) {
			const deadline = Date.now() + 5000;
			for (;;) {
				const next = snapshots.length + 1;
				observer.send(JSON.stringify({ type: 'fixture-stats', topic: 'client-room' }));
				await waitFor(() => snapshots.length >= next);
				if (snapshots.at(-1).connections === expected) return snapshots.at(-1);
				assert.ok(Date.now() < deadline, 'server connection count settles');
			}
		}
		try {
			start({ auth: true });
			const received = [];
			const unsubscribe = connection.on('client-room').subscribe(event => { if (event) received.push(event.data); });
			await waitFor(() => states.at(-1) === 'open');
			connection.send({ type: 'fixture-stats', topic: 'client-room' });
			await waitFor(() => events.some(event => event.event === 'stats' && event.data.subscribers === 1));
			assert.equal((await serverCount(2)).subscribers, 1);
			connection.send({ type: 'fixture-publish', topic: 'client-room', data: 'before' });
			await waitFor(() => received.includes('before'));
			const offset = events.find(event => event.topic === 'client-room' && event.data === 'before').seq;
			assert.equal(typeof offset, 'number');
			connection.simulateOffline(); connection.simulateOffline();
			assert.equal(states.at(-1), 'disconnected');
			assert.equal((await serverCount(1)).subscribers, 0);
			assert.equal(connection.send(echo('dropped')), false);
			connection.sendQueued(echo('queued-text'));
			connection.sendQueued(new TextEncoder().encode(JSON.stringify(echo('queued-bytes'))));
			connection.resumeOnline(); connection.resumeOnline();
			await waitFor(() => states.at(-1) === 'open' && echoed('queued-bytes'));
			await serverCount(2);
			await waitFor(() => events.some(event => event.topic === 'client-room' && event.event === 'replayed'));
			assert.equal(events.find(event => event.topic === 'client-room' && event.event === 'replayed').data.since, offset);
			assert.deepEqual(events.filter(event => event.event === 'echo').map(event => event.data), ['queued-text', 'queued-bytes']);
			connection.send({ type: 'fixture-publish-noseq', topic: 'client-room', data: 'after' });
			await waitFor(() => received.includes('after'));
			assert.deepEqual(received.filter(value => typeof value === 'string'), ['before', 'after']);
			assert.equal(states.includes('failed'), false);
			unsubscribe();
		} finally {
			const closed = new Promise(resolve => observer.addEventListener('close', resolve, { once: true }));
			observer.close();
			await closed;
		}
	});
	await check('a remote drop can be paused before retry exhaustion and resumed', async () => {
		start({ maxReconnectAttempts: 1, reconnectInterval: 1000 });
		await waitFor(() => states.at(-1) === 'open');
		let paused = false;
		const stop = connection.status.subscribe(state => {
			if (state === 'disconnected' && !paused) {
				paused = true;
				connection.simulateOffline();
			}
		});
		connection.send({ type: 'fixture-end', code: 1011, reason: 'retry' });
		await waitFor(() => paused);
		stop();
		connection.resumeOnline();
		await waitFor(() => states.at(-1) === 'open');
		assert.equal(connection.send(echo('after-drop')), true);
		await waitFor(() => echoed('after-drop'));
		assert.equal(states.includes('failed'), false);
	});
	await check('a server refusal cannot be revived by offline controls', async () => {
		start({ maxReconnectAttempts: 5 });
		await waitFor(() => states.at(-1) === 'open');
		connection.send({ type: 'fixture-end', code: 4401, reason: 'refused' });
		await waitFor(() => states.at(-1) === 'failed');
		connection.simulateOffline(); connection.resumeOnline();
		assert.equal(states.at(-1), 'failed');
		assert.equal(connection.send(echo('never')), false);
	});
	await check('a cancelled initial socket cannot mute its live replacement', async () => {
		start(); connection.simulateOffline();
		assert.equal(states.at(-1), 'disconnected');
		connection.resumeOnline();
		await waitFor(() => states.at(-1) === 'open');
		assert.equal(connection.send(echo('replacement')), true);
		await waitFor(() => echoed('replacement'));
		assert.equal(states.at(-1), 'open');
	});
	await check('an open listener can pause without losing queued bytes', async () => {
		start(); connection.sendQueued(echo('survives'));
		let once = true;
		connection.status.subscribe(state => {
			if (state === 'open' && once) { once = false; connection.simulateOffline(); }
		});
		await waitFor(() => !once && states.at(-1) === 'disconnected');
		assert.equal(echoed('survives'), false);
		connection.resumeOnline(); await waitFor(() => echoed('survives'));
		assert.equal(events.filter(event => event.event === 'echo').length, 1);
	});
	await check('permanent close cannot be resumed', async () => {
		start(); await waitFor(() => states.at(-1) === 'open');
		connection.simulateOffline(); connection.close();
		connection.resumeOnline(); connection.simulateOffline();
		assert.equal(states.at(-1), 'failed');
		assert.equal(connection.send(echo('never')), false);
	});
	await check('a refused auth preflight remains terminal after resume', async () => {
		start({ auth: '/__ws/auth?mode=deny' });
		await waitFor(() => states.at(-1) === 'failed');
		connection.simulateOffline(); connection.resumeOnline();
		assert.equal(states.at(-1), 'failed');
		assert.equal(connection.send(echo('never')), false);
	});
	console.log(`Client integration: ${passed} passed`);
} catch (error) {
	console.error(error); process.exitCode = 1;
} finally {
	connection?.close();
	proc.kill(); await proc.exited;
	const logs = (await stdout) + (await stderr);
	if (process.exitCode) console.error(logs);
}
