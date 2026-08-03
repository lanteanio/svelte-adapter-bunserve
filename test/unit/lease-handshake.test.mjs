import { test } from 'node:test';
import assert from 'node:assert/strict';

// The hello/lease handshake against the REAL dispatch, driven through the sim
// harness: the same ws.js demux a built server runs, over the in-memory
// double and the virtual clock. What the wire twin (live lane) proves against
// a real Bun process, this proves per-frame at unit cost.

const { runSim } = await import('../../src/sim.js');

/** Parsed frames of one sim client, minus nulls (binary frames). */
function framesOf(result, i) {
	return (result.clientFrames[i] || []).filter((f) => f !== null);
}

test('a hello advertising `lease` arms flow control: one lease-ok, a sized grant, re-grant on request-n', async () => {
	const result = await runSim({
		clients: 0,
		scenario: async (api) => {
			const c = api.connect();
			await api.advance();
			c.send({ type: 'hello', caps: ['lease'] });
			await api.advance();
			// A re-sent hello (a lazy plugin re-advertising caps) must not
			// reset the window or repeat the ack.
			c.send({ type: 'hello', caps: ['lease', 'batch'] });
			await api.advance();
			// The replenish. The client's n is advisory; the server sizes the
			// window from its own posture.
			c.send({ type: 'request-n', n: 7 });
			await api.advance();
		}
	});
	assert.equal(result.invariantViolations.length, 0);
	const frames = framesOf(result, 0);
	const leaseOks = frames.filter((f) => f.type === 'lease-ok');
	const grants = frames.filter((f) => f.type === 'lease');
	assert.equal(leaseOks.length, 1, 'first hello only - the re-sent hello repeated nothing');
	assert.equal(grants.length, 2, 'one grant on arm, one on replenish');
	for (const g of grants) {
		assert.ok(Number.isInteger(g.count) && g.count >= 8 && g.count <= 256,
			'window sized between the floor and the base: ' + g.count);
		assert.equal(g.ttlMs, 10000);
	}
});

test('a request-n from a connection that never opted in is a silent no-op', async () => {
	const result = await runSim({
		clients: 0,
		scenario: async (api) => {
			const c = api.connect();
			await api.advance();
			c.send({ type: 'request-n', n: 256 });
			await api.advance();
		}
	});
	assert.equal(result.invariantViolations.length, 0);
	const frames = framesOf(result, 0);
	assert.equal(frames.filter((f) => f.type === 'lease' || f.type === 'lease-ok').length, 0,
		'no window was armed, so nothing was granted');
});

test('a hello without the lease capability arms nothing', async () => {
	const result = await runSim({
		clients: 0,
		scenario: async (api) => {
			const c = api.connect();
			await api.advance();
			c.send({ type: 'hello', caps: ['batch'] });
			await api.advance();
		}
	});
	const frames = framesOf(result, 0);
	assert.equal(frames.filter((f) => f.type === 'lease' || f.type === 'lease-ok').length, 0);
});
