import assert from 'node:assert/strict';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8867;
const BASE = `http://127.0.0.1:${PORT}`;
const clients = [];
let nonce = 0;
async function client() {
	const ws = new WebSocket(BASE.replace('http:', 'ws:') + '/ws');
	ws.binaryType = 'arraybuffer';
	const frames = [];
	const binary = [];
	ws.onmessage = ({ data }) => {
		if (typeof data === 'string') frames.push(JSON.parse(data));
		else binary.push(new Uint8Array(data).at(-1));
	};
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(Error('WebSocket open timed out')), 5000);
		ws.onopen = () => { clearTimeout(timer); resolve(); };
		ws.onerror = () => { clearTimeout(timer); reject(Error('WebSocket failed')); };
	});
	const send = value => ws.send(JSON.stringify(value));
	const wait = async predicate => {
		for (let i = 0; i < 1000; i++) {
			const value = frames.find(predicate);
			if (value) return value.data;
			await Bun.sleep(5);
		}
		throw Error('No expected frame: ' + JSON.stringify(frames));
	};
	const command = async (action, event, topic, extra = {}) => {
		const id = ++nonce;
		send({ type: 'fixture-release', action, topic, nonce: id, ...extra });
		return wait(frame => frame.event === event && frame.data?.nonce === id);
	};
	const begin = async (topic, index) => {
		const id = ++nonce;
		send({ type: 'fixture-release', action: 'begin', topic, nonce: id });
		await wait(frame => frame.event === 'parked' && frame.data?.index === index);
		return id;
	};
	const finish = async (index, id, denial) => {
		send({ type: 'fixture-release', action: 'finish', index, denial });
		return (await wait(frame => frame.event === 'admitted' && frame.data?.nonce === id)).denial;
	};
	const delivered = id => frames.filter(frame => frame.data?.nonce === id && ['base', 'derived', 'shared'].includes(frame.event)).map(frame => frame.event);
	const close = () => new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.CLOSED) return resolve();
		const timer = setTimeout(() => reject(Error('WebSocket close timed out')), 5000);
		ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
		ws.close();
	});
	send({ type: 'hello', caps: ['fixture.release:1'] });
	const result = { ws, frames, binary, command, begin, finish, delivered, close };
	clients.push(result);
	return result;
}
async function total(expected) {
	const metrics = await (await fetch(BASE + '/metrics')).text();
	const value = /^ws_subscriptions (\d+)$/m.exec(metrics);
	assert.ok(value, 'subscription accounting is rendered');
	assert.equal(Number(value[1]), expected);
}
async function probe(c, topic, expected) {
	const value = await c.command('probe', 'state', topic);
	for (const [key, item] of Object.entries(expected)) assert.equal(value[key], item, key);
}

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, buildPath('build')], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), ORIGIN: BASE }),
	stdout: 'ignore', stderr: 'pipe'
});
const errors = new Response(proc.stderr).text();
try {
	await waitForServer(proc, PORT);
	for (const outcome of ['allow', 'deny', 'revoke']) {
		const c = await client();
		const topic = 'release:' + outcome;
		const a = await c.begin(topic, 0);
		const b = await c.begin(topic, 1);
		assert.equal(await c.finish(0, a), null);
		await c.command('decorate', 'decorated', topic);
		const warm = await c.command('publish', 'published', topic);
		assert.deepEqual(c.delivered(warm.nonce), ['base', 'derived']);
		assert.ok(c.binary.includes(warm.nonce));
		await total(2);
		await probe(c, topic, { logical: 1, native: 1, derived: 1, grant: topic, unsubscribes: 0 });
		assert.equal((await c.command('release', 'released', topic)).removed, true);
		assert.equal((await c.command('release', 'released', topic)).removed, false);
		await probe(c, topic, { logical: 0, native: 0, derived: 0, grant: null, unsubscribes: 0 });
		const absent = await c.command('publish', 'published', topic);
		assert.deepEqual(c.delivered(absent.nonce), []);
		assert.ok(!c.binary.includes(absent.nonce));
		await total(0);
		if (outcome === 'revoke') assert.equal((await c.command('revoke', 'revoked', topic)).removed, true);
		assert.equal(await c.finish(1, b, outcome === 'deny' ? 'FORBIDDEN' : undefined), outcome === 'allow' ? null : 'FORBIDDEN');
		const live = Number(outcome === 'allow');
		await probe(c, topic, { logical: live, native: live, derived: 0, grant: null });
		const after = await c.command('publish', 'published', topic);
		assert.deepEqual(c.delivered(after.nonce), live ? ['base'] : []);
		assert.equal(c.binary.includes(after.nonce), Boolean(live));
		await total(live);
		await c.close();
		await total(0);
		console.log('ok subscription release with sibling ' + outcome);
	}
	{
		const c = await client();
		const topic = 'release:derived';
		const a = await c.begin(topic, 0);
		const derived = await c.begin('__release:' + topic, 1);
		assert.equal(await c.finish(0, a), null);
		await c.command('decorate', 'decorated', topic);
		await c.command('release', 'released', topic);
		assert.equal(await c.finish(1, derived), null);
		const sent = await c.command('publish', 'published', topic);
		assert.deepEqual(c.delivered(sent.nonce), ['derived']);
		const pending = await c.begin(topic, 2);
		await c.command('revoke', 'revoked', topic);
		await c.command('release', 'released', topic);
		assert.equal(await c.finish(2, pending), 'FORBIDDEN');
		await c.close();
		await total(0);
		console.log('ok independent derived admission and preserved revocation');
	}
	{
		const c = await client();
		const topic = 'release:old-install';
		const older = await c.begin(topic, 0);
		await c.command('revoke', 'revoked', topic);
		const current = await c.begin(topic, 1);
		assert.equal(await c.finish(1, current), null);
		await c.command('release', 'released', topic);
		assert.equal((await c.command('install', 'installed', topic)).installed, true);
		assert.equal(await c.finish(0, older), 'FORBIDDEN');
		await probe(c, topic, { logical: 0, native: 0 });
		const sent = await c.command('publish', 'published', topic);
		assert.deepEqual(c.delivered(sent.nonce), []);
		assert.ok(!c.binary.includes(sent.nonce));
		await total(0);
		await c.close();
		const observer = await client();
		assert.equal((await observer.command('retired', 'retired', topic)).removed, false);
		assert.equal((await observer.command('release', 'released', topic)).removed, false);
		await observer.close();
		console.log('ok stale hook installation and closed membership release');
	}
} finally {
	for (const c of clients) c.ws.close();
	proc.kill();
	await proc.exited;
	const stderr = await errors;
	if (stderr) console.error(stderr);
}
