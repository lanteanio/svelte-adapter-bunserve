import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	beginPending,
	createPending,
	pendingInflight,
	settlePending,
	tombstonePending
} from '../../src/runtime/utils/pending-subscribe.js';

test('an uncontested subscribe lands', () => {
	const state = createPending();
	const token = beginPending(state, 'room');
	assert.equal(settlePending(state, 'room', token), true);
});

test('an unsubscribe during the gate stops the subscribe from landing', () => {
	// The defect this module exists for: the client subscribes, then
	// unsubscribes before the app's authorization hook resolves. Without the
	// epoch the subscribe lands afterwards and the connection is left in a room
	// it explicitly left - while holding an `unsubscribed` ack, so it never
	// asks again.
	const state = createPending();
	const token = beginPending(state, 'room');
	assert.equal(tombstonePending(state, 'room'), true);
	assert.equal(settlePending(state, 'room', token), false);
});

test('a subs.has() re-check could not have caught it', () => {
	// Both the never-subscribed and the just-unsubscribed case present as
	// "topic absent from the set", and they demand opposite outcomes. Only the
	// generation distinguishes them, which is why the re-check in the caller is
	// not sufficient on its own.
	const state = createPending();
	const cancelled = beginPending(state, 'room');
	tombstonePending(state, 'room');
	const fresh = beginPending(state, 'room');
	assert.equal(settlePending(state, 'room', cancelled), false, 'the overtaken one declines');
	assert.equal(settlePending(state, 'room', fresh), true, 'the later one still lands');
});

test('tombstone only cancels what is actually in flight', () => {
	const state = createPending();
	assert.equal(tombstonePending(state, 'room'), false, 'nothing in flight');
	assert.equal(tombstonePending(undefined, 'room'), false, 'no state at all');
	const token = beginPending(state, 'room');
	settlePending(state, 'room', token);
	assert.equal(tombstonePending(state, 'room'), false, 'already settled');
});

test('concurrent subscribes for one topic are cancelled together', () => {
	// One unsubscribe means the client wants out, regardless of how many
	// subscribes happen to be in the gate for that topic.
	const state = createPending();
	const first = beginPending(state, 'room');
	const second = beginPending(state, 'room');
	tombstonePending(state, 'room');
	assert.equal(settlePending(state, 'room', first), false);
	assert.equal(settlePending(state, 'room', second), false);
});

test('topics are independent', () => {
	const state = createPending();
	const a = beginPending(state, 'a');
	const b = beginPending(state, 'b');
	tombstonePending(state, 'a');
	assert.equal(settlePending(state, 'a', a), false);
	assert.equal(settlePending(state, 'b', b), true);
});

test('entries are released once nothing is in flight', () => {
	// Otherwise a connection that subscribes and unsubscribes repeatedly
	// accumulates one entry per topic it ever touched.
	const state = createPending();
	const token = beginPending(state, 'room');
	assert.equal(state.topics.size, 1);
	settlePending(state, 'room', token);
	assert.equal(state.topics.size, 0);
});

test('the last settle of several releases the entry', () => {
	const state = createPending();
	const first = beginPending(state, 'room');
	const second = beginPending(state, 'room');
	settlePending(state, 'room', first);
	assert.equal(state.topics.size, 1, 'still one in flight');
	settlePending(state, 'room', second);
	assert.equal(state.topics.size, 0);
});

test('settling an unknown topic or a stale token is refused, not thrown', () => {
	const state = createPending();
	assert.equal(settlePending(state, 'never', 0), false);
	assert.equal(settlePending(undefined, 'room', 0), false);
});

test('the in-flight total counts gates that have been entered but have not landed', () => {
	// This is what makes the per-connection subscription cap a bound. Bun does
	// not await the message handler, so a client can pipeline subscribe frames
	// that all enter the gate before any of them installs; a cap reading only
	// the installed set sees zero every time.
	const state = createPending();
	assert.equal(pendingInflight(state), 0);
	assert.equal(pendingInflight(undefined), 0, 'no state at all');
	const a = beginPending(state, 'a');
	const b = beginPending(state, 'b');
	const c = beginPending(state, 'a');
	assert.equal(pendingInflight(state), 3, 'counts across topics, and repeats within one');
	settlePending(state, 'a', a);
	assert.equal(pendingInflight(state), 2);
	settlePending(state, 'a', c);
	settlePending(state, 'b', b);
	assert.equal(pendingInflight(state), 0, 'drains back to zero');
});

test('a cancelled gate keeps counting until it actually settles', () => {
	// The hook is still running and still holding whatever it talks to open, so
	// releasing its slot at tombstone time would hand the cap free headroom
	// exactly while the connection is at its most expensive.
	const state = createPending();
	const token = beginPending(state, 'room');
	tombstonePending(state, 'room');
	assert.equal(pendingInflight(state), 1, 'still in flight');
	assert.equal(settlePending(state, 'room', token), false, 'and still declines to land');
	assert.equal(pendingInflight(state), 0);
});

test('a stale settle cannot drive the total negative', () => {
	// A second settle for an entry that was already released must not mint
	// headroom the connection has not earned.
	const state = createPending();
	const token = beginPending(state, 'room');
	settlePending(state, 'room', token);
	settlePending(state, 'room', token);
	settlePending(state, 'room', token);
	assert.equal(pendingInflight(state), 0);
});
