import assert from 'node:assert/strict';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';
import { buildBinaryFrame } from '../../src/runtime/wire.js';

const port = 8872;
await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe'
});
let ws;
const texts = [];
let checks = 0;
async function until(predicate) {
	for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(25); }
	throw new Error('native control frame timed out: ' + JSON.stringify(texts));
}
const send = value => ws.send(JSON.stringify(value));
try {
	await waitForServer(proc, port);
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws?user=control-contract`);
	ws.onmessage = event => { if (typeof event.data === 'string') texts.push(JSON.parse(event.data)); };
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	await until(() => texts.some(value => value.type === 'welcome'));
	for (const [sessionId, seqs, epochs] of [
		['', ['raw', -1, null], ['epoch', 0]],
		['\u0000'.repeat(129), JSON.parse('{"__proto__":{"raw":true},"__presence:room":"raw","bad\\u0000topic":-4}'), { room: null }],
		['maps', Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['t' + i, i])), Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['e' + i, i]))],
		['fixture:throw', { room: 3 }, null]
	]) {
		texts.length = 0;
		send({ type: 'resume', sessionId, lastSeenSeqs: seqs, lastSeenEpochs: epochs });
		await until(() => texts.some(value => value.type === 'resumed'));
		const replay = texts.find(value => value.event === 'raw-resume');
		assert.equal(replay.data.sessionId, sessionId);
		assert.deepEqual(replay.data.lastSeenSeqs, seqs);
		assert.deepEqual(replay.data.lastSeenEpochs, epochs ?? undefined);
		assert.ok(texts.indexOf(replay) < texts.findIndex(value => value.type === 'resumed'));
		assert.ok(!texts.some(value => value.type === 'error')); checks++;
	}
	texts.length = 0;
	const topics = ['held:first', 'held:second', 'held:third'];
	send({ type: 'subscribe-batch', topics, ref: 44 });
	send({ type: 'fixture-release-subscribes' });
	await until(() => texts.some(value => value.event === 'subscribe-gates-released'));
	assert.equal(texts.find(value => value.event === 'subscribe-gates-released').data.count, 3);
	await until(() => texts.filter(value => value.type === 'subscribed' && value.ref === 44).length === 3);
	assert.deepEqual(texts.filter(value => value.type === 'subscribed' && value.ref === 44).map(value => value.topic), topics); checks++;
	texts.length = 0;
	send({ type: 'hello', caps: ['wire.ingress:1'] });
	send({ type: 'ingress-bind', id: 11, kind: 'fixture.input:1', target: { room: 'native' } });
	await until(() => texts.some(value => value.type === 'ingress-bound'));
	assert.ok(texts.some(value => value.type === 'ingress-ok'));
	ws.send(buildBinaryFrame(2, 11, 33, Uint8Array.of(4, 5)));
	await until(() => texts.some(value => value.event === 'ingress'));
	assert.deepEqual(texts.find(value => value.event === 'ingress').data, {
		target: { room: 'native' }, value: { bytes: [4, 5], schemaVersion: 2, seq: 33 }
	}); checks++;
	console.log(`${checks} native resume, concurrent batch and ingress checks passed`);
} finally { ws?.close(); proc.kill(); await proc.exited; }
