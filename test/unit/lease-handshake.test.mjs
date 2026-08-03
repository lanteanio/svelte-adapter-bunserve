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

/**
 * Every assertion about frames that did NOT arrive needs this first: a throw
 * inside the demux is collected into `schedulerUncaught` and the run returns
 * normally, so "no lease frames" would otherwise pass for a lane that
 * exploded on its first statement.
 */
function assertRanClean(result) {
	assert.deepEqual(result.schedulerUncaught, [], 'the dispatch threw nothing');
	assert.equal(result.invariantViolations.length, 0);
}

/**
 * The positive control for the absence tests: prove this connection's frames
 * reach the real demux at all, by subscribing and seeing the ack come back.
 */
function assertDemuxAlive(frames) {
	assert.equal(frames.some((f) => f.type === 'subscribed' && f.topic === 'probe'), true,
		'the connection reached the demux and was answered');
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
	assertRanClean(result);
	const frames = framesOf(result, 0);
	const leaseOks = frames.filter((f) => f.type === 'lease-ok');
	const grants = frames.filter((f) => f.type === 'lease');
	assert.equal(leaseOks.length, 1, 'first hello only - the re-sent hello repeated nothing');
	assert.equal(grants.length, 2, 'one grant on arm, one on replenish');

	// ORDER is contract, not incidental: a client keys on lease-ok before it
	// trusts its first window, so the ack must precede the grant. Comparing
	// positions in the delivered sequence is what a set-of-types check misses.
	const types = frames.map((f) => f.type).filter((t) => t === 'lease-ok' || t === 'lease');
	assert.deepEqual(types, ['lease-ok', 'lease', 'lease'],
		'the ack arrives first, then each window in the order it was granted');

	for (const g of grants) {
		// EXACT, and deterministically so: one connection with no
		// subscriptions is nowhere near the fan-out knee, and the sizing takes
		// no heap term on this engine, so a healthy server owes the full base
		// window. A range check here would pass for a constant return, a
		// swapped argument, or a forgotten division - and would have passed
		// while an idle server was really granting 27.
		assert.equal(g.count, 256, 'an unloaded server grants the full base window');
		assert.equal(g.ttlMs, 10000, 'the ttl is fixed and exact');
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
			c.subscribe('probe');
			await api.advance();
		}
	});
	assertRanClean(result);
	const frames = framesOf(result, 0);
	assertDemuxAlive(frames);
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
			c.subscribe('probe');
			await api.advance();
		}
	});
	assertRanClean(result);
	const frames = framesOf(result, 0);
	assertDemuxAlive(frames);
	assert.equal(frames.filter((f) => f.type === 'lease' || f.type === 'lease-ok').length, 0,
		'the hello was understood, but no lease capability means no window');
});
