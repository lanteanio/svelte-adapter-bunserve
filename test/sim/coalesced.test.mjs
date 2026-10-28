import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSim } from '../../src/sim.js';

for (const sameKey of [true, false]) {
	test(`coalesced ${sameKey ? 'same' : 'new'}-key continuations use the simulation clock`, async () => {
		let socket, calls = 0;
		const result = await runSim({
			seed: 4815,
			handler: { open(ws) { socket = ws; } },
			async scenario(api) {
				const client = api.connect();
				await api.advance(20);
				assert.ok(socket);
				const value = { toJSON() {
					calls++;
					if (calls < 6) api.server.platform.sendCoalesced(socket, {
						key: sameKey ? 'key' : calls, topic: 'room', event: 'value', data: value
					});
					return calls;
				} };
				api.server.platform.sendCoalesced(socket, { key: 'key', topic: 'room', event: 'value', data: value });
				assert.equal(calls, 2);
				await api.advance(40);
				assert.equal(calls, 6);
				assert.deepEqual(client.json().filter((frame) => frame.topic === 'room').map((frame) => frame.data),
					sameKey ? [6] : [1, 2, 3, 4, 5, 6]);
				client.close();
			}
		});
		assert.deepEqual(result.invariantViolations, []);
		assert.deepEqual(result.fatals, []);
	});
}
