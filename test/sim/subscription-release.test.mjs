import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseSubscription, trackedSubscribe } from 'svelte-adapter-bunserve/subscriptions';
const { runSim } = await import('../../src/sim.js');
const { WS_SHARED_COHORTS } = await import('../../src/runtime/handler/ws-state.js');
const capability = 'release:1';
const topic = 'release-board';
const codec = { capability, schemaVersion: 1, shared: true, encode: () => new Uint8Array([7]) };

test('rollback releases only its connection cohort and leaves the other member publishing', async () => {
	let removed;
	let repeated;
	let cohorts;
	let counts;
	const result = await runSim({
		clients: 0,
		handler: {
			message(ws, { msg }) {
				if (msg?.type === 'join') trackedSubscribe(ws, topic);
				if (msg?.type === 'rollback') {
					removed = releaseSubscription(ws, topic);
					repeated = releaseSubscription(ws, topic);
					cohorts = ws.getUserData()[WS_SHARED_COHORTS]?.has(topic) ?? false;
				}
			}
		},
		async scenario(api) {
			const a = api.connect();
			const b = api.connect();
			await api.advance();
			for (const client of [a, b]) {
				client.send({ type: 'hello', caps: [capability] });
				client.send({ type: 'join' });
			}
			await api.advance();
			api.server.platform.publishWire(topic, 'state', { tick: 1 }, codec);
			await api.advance();
			a.send({ type: 'rollback' });
			await api.advance();
			api.server.platform.publishWire(topic, 'state', { tick: 2 }, codec);
			await api.advance();
			a.close();
			await api.advance();
			api.server.platform.publishWire(topic, 'state', { tick: 3 }, codec);
			await api.advance();
			counts = [a, b].map(client => client.frames().filter(frame => frame.isBinary).length);
		}
	});
	assert.deepEqual(result.schedulerUncaught, []);
	assert.deepEqual(result.invariantViolations, []);
	assert.equal(removed, true);
	assert.equal(repeated, false);
	assert.equal(cohorts, false);
	assert.deepEqual(counts, [1, 3]);
});
