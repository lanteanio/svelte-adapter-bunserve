import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	WS_PENDING_SUBSCRIBES,
	WS_PENDING_SUBSCRIBES_TOTAL,
	beginPendingSubscribe,
	isPendingSubscribeCancelled,
	pendingSubscribeTotal,
	settleDeniedSubscribe,
	settleHeldSubscribe,
	settlePendingSubscribe,
	tombstonePendingSubscribe
} from '../../src/runtime/utils/ws-symbols.js';

test('an uncontested subscribe lands', () => {
	const ud = {};
	const token = beginPendingSubscribe(ud, 'room');
	assert.equal(settlePendingSubscribe(ud, 'room', token), true);
});

test('an unsubscribe during the gate stops the subscribe from landing', () => {
	// The defect the record exists for: the client subscribes, then
	// unsubscribes before the app's authorization hook resolves. Without the
	// epoch the subscribe lands afterwards and the connection is left in a room
	// it explicitly left - after its unsubscribe completed, so it never
	// asks again.
	const ud = {};
	const token = beginPendingSubscribe(ud, 'room');
	assert.equal(tombstonePendingSubscribe(ud, 'room'), true);
	assert.equal(settlePendingSubscribe(ud, 'room', token), false);
});

test('a subs.has() re-check could not have caught it', () => {
	// Both the never-subscribed and the just-unsubscribed case present as
	// "topic absent from the set", and they demand opposite outcomes. Only the
	// generation distinguishes them, which is why the re-check in the caller is
	// not sufficient on its own.
	const ud = {};
	const cancelled = beginPendingSubscribe(ud, 'room');
	tombstonePendingSubscribe(ud, 'room');
	const fresh = beginPendingSubscribe(ud, 'room');
	assert.equal(settlePendingSubscribe(ud, 'room', cancelled), false, 'the overtaken one declines');
	assert.equal(settlePendingSubscribe(ud, 'room', fresh), true, 'the later one still lands');
});

test('tombstone only cancels what is actually in flight', () => {
	const ud = {};
	assert.equal(tombstonePendingSubscribe(ud, 'room'), false, 'no record at all');
	const token = beginPendingSubscribe(ud, 'room');
	settlePendingSubscribe(ud, 'room', token);
	assert.equal(tombstonePendingSubscribe(ud, 'room'), false, 'already settled');
	beginPendingSubscribe(ud, 'other');
	assert.equal(tombstonePendingSubscribe(ud, 'room'), false, 'another topic in flight');
});

test('concurrent subscribes for one topic are cancelled together', () => {
	// One unsubscribe means the client wants out, regardless of how many
	// subscribes happen to be in the gate for that topic.
	const ud = {};
	const first = beginPendingSubscribe(ud, 'room');
	const second = beginPendingSubscribe(ud, 'room');
	tombstonePendingSubscribe(ud, 'room');
	assert.equal(settlePendingSubscribe(ud, 'room', first), false);
	assert.equal(settlePendingSubscribe(ud, 'room', second), false);
});

test('topics are independent', () => {
	const ud = {};
	const a = beginPendingSubscribe(ud, 'a');
	const b = beginPendingSubscribe(ud, 'b');
	tombstonePendingSubscribe(ud, 'a');
	assert.equal(settlePendingSubscribe(ud, 'a', a), false);
	assert.equal(settlePendingSubscribe(ud, 'b', b), true);
});

test('entries are released once nothing is in flight', () => {
	// Otherwise a connection that subscribes and unsubscribes repeatedly
	// accumulates one entry per topic it ever touched.
	const ud = {};
	const token = beginPendingSubscribe(ud, 'room');
	assert.equal(ud[WS_PENDING_SUBSCRIBES].size, 1);
	settlePendingSubscribe(ud, 'room', token);
	assert.equal(ud[WS_PENDING_SUBSCRIBES].size, 0);
});

test('the last settle of several releases the entry', () => {
	const ud = {};
	const first = beginPendingSubscribe(ud, 'room');
	const second = beginPendingSubscribe(ud, 'room');
	settlePendingSubscribe(ud, 'room', first);
	assert.equal(ud[WS_PENDING_SUBSCRIBES].size, 1, 'still one in flight');
	settlePendingSubscribe(ud, 'room', second);
	assert.equal(ud[WS_PENDING_SUBSCRIBES].size, 0);
});

test('settling an unknown topic or with no record is refused, not thrown', () => {
	const ud = {};
	beginPendingSubscribe(ud, 'room');
	assert.equal(settlePendingSubscribe(ud, 'never', 0), false);
	assert.equal(settlePendingSubscribe({}, 'room', 0), false);
	assert.equal(pendingSubscribeTotal(ud), 1, 'neither refusal touched the total');
});

test('the in-flight total counts gates that have been entered but have not landed', () => {
	// The per-connection bounds read it. Bun does not await the message
	// handler, so a client can pipeline subscribe frames that all enter the
	// gate before any of them installs; a bound reading only the installed set
	// sees zero every time.
	const ud = {};
	assert.equal(pendingSubscribeTotal(ud), 0);
	const a = beginPendingSubscribe(ud, 'a');
	const b = beginPendingSubscribe(ud, 'b');
	const c = beginPendingSubscribe(ud, 'a');
	assert.equal(pendingSubscribeTotal(ud), 3, 'counts across topics, and repeats within one');
	settlePendingSubscribe(ud, 'a', a);
	assert.equal(pendingSubscribeTotal(ud), 2);
	settlePendingSubscribe(ud, 'a', c);
	settlePendingSubscribe(ud, 'b', b);
	assert.equal(pendingSubscribeTotal(ud), 0, 'drains back to zero');
});

test('a cancelled gate keeps counting until it actually settles', () => {
	// The hook is still running and still holding whatever it talks to open, so
	// releasing its slot at tombstone time would hand the bound free headroom
	// exactly while the connection is at its most expensive.
	const ud = {};
	const token = beginPendingSubscribe(ud, 'room');
	tombstonePendingSubscribe(ud, 'room');
	assert.equal(pendingSubscribeTotal(ud), 1, 'still in flight');
	assert.equal(settlePendingSubscribe(ud, 'room', token), false, 'and still declines to land');
	assert.equal(pendingSubscribeTotal(ud), 0);
});

test('a stale settle cannot drive the total negative', () => {
	// A second settle for an entry that was already released must not mint
	// headroom the connection has not earned.
	const ud = {};
	const token = beginPendingSubscribe(ud, 'room');
	settlePendingSubscribe(ud, 'room', token);
	settlePendingSubscribe(ud, 'room', token);
	settlePendingSubscribe(ud, 'room', token);
	assert.equal(pendingSubscribeTotal(ud), 0);
});

test('a peek reports cancellation without settling', () => {
	const ud = {};
	const token = beginPendingSubscribe(ud, 'room');
	assert.equal(isPendingSubscribeCancelled(ud, 'room', token), false);
	tombstonePendingSubscribe(ud, 'room');
	assert.equal(isPendingSubscribeCancelled(ud, 'room', token), true);
	assert.equal(pendingSubscribeTotal(ud), 1, 'the peek left the attempt in flight');
	assert.equal(isPendingSubscribeCancelled({}, 'room', 0), true, 'no record reads as cancelled');
});

test('the record is a plain Map of topic entries, with the total on its own slot', () => {
	// The layout svelte-adapter-uws keeps on the same connection. A copy of its
	// helpers reads `ud[WS_PENDING_SUBSCRIBES].get(topic)` and writes the total
	// slot directly, so any other shape breaks it - its tombstone would throw
	// on the record, and the throw is swallowed where it is called.
	const ud = {};
	beginPendingSubscribe(ud, 'room');
	beginPendingSubscribe(ud, 'room');
	const record = ud[WS_PENDING_SUBSCRIBES];
	assert.ok(record instanceof Map);
	assert.deepEqual([...record.keys()], ['room']);
	assert.deepEqual(record.get('room'), { epoch: 0, inflight: 2, granted: false });
	assert.equal(ud[WS_PENDING_SUBSCRIBES_TOTAL], 2);
});

// - provenance: who backs a membership found standing --------------------------

/** @param {any} ud */
const granted = (ud) => ud[WS_PENDING_SUBSCRIBES].get('room')?.granted;

test('only the first enrolment seeds authority from a held topic', () => {
	const ud = {};
	beginPendingSubscribe(ud, 'room', true);
	assert.equal(granted(ud), true, 'held before the attempt: authority');
	const other = {};
	beginPendingSubscribe(other, 'room', false);
	// Held by the time a second attempt enrols means installed inside the
	// window, which is not authority.
	beginPendingSubscribe(other, 'room', true);
	assert.equal(other[WS_PENDING_SUBSCRIBES].get('room').granted, false);
});

test('a granting settle marks authority on the current epoch only, and a revocation clears it', () => {
	const ud = {};
	const stale = beginPendingSubscribe(ud, 'room');
	beginPendingSubscribe(ud, 'room');
	tombstonePendingSubscribe(ud, 'room');
	const fresh = beginPendingSubscribe(ud, 'room');
	settlePendingSubscribe(ud, 'room', stale, true);
	assert.equal(granted(ud), false, 'a revoked attempt grants nothing');
	settlePendingSubscribe(ud, 'room', fresh, true);
	assert.equal(granted(ud), true);
	tombstonePendingSubscribe(ud, 'room');
	assert.equal(granted(ud), false, 'the next revocation clears it');
});

test('a held landing acks a surviving attempt and records its authority', () => {
	const ud = {};
	const a = beginPendingSubscribe(ud, 'room');
	const b = beginPendingSubscribe(ud, 'room');
	assert.equal(settleHeldSubscribe(ud, 'room', a), 'ack');
	assert.equal(granted(ud), true);
	tombstonePendingSubscribe(ud, 'room');
	assert.equal(settleHeldSubscribe(ud, 'room', b), 'deny-unwind', 'revoked, last, nothing backs it');
	assert.equal(pendingSubscribeTotal(ud), 0);
});

test('a revoked held landing defers while a sibling is in flight, and acks a fresh grant', () => {
	const ud = {};
	const revoked = beginPendingSubscribe(ud, 'room');
	tombstonePendingSubscribe(ud, 'room');
	const fresh = beginPendingSubscribe(ud, 'room');
	assert.equal(settleHeldSubscribe(ud, 'room', revoked), 'deny', 'the sibling still judges it');
	assert.equal(settleHeldSubscribe(ud, 'room', fresh), 'ack');

	const regranted = {};
	const parked = beginPendingSubscribe(regranted, 'room');
	tombstonePendingSubscribe(regranted, 'room');
	const regrant = beginPendingSubscribe(regranted, 'room');
	settlePendingSubscribe(regranted, 'room', regrant, true);
	assert.equal(settleHeldSubscribe(regranted, 'room', parked), 'ack', 'a re-grant is current authority');
});

test('a held landing with no record acks', () => {
	assert.equal(settleHeldSubscribe({}, 'room', 0), 'ack');
});

test('a denial unwinds only a held membership nothing backs, from its last attempt', () => {
	const notHeld = {};
	const t0 = beginPendingSubscribe(notHeld, 'room');
	assert.equal(settleDeniedSubscribe(notHeld, 'room', t0, false), 'deny', 'nothing to unwind');

	const seeded = {};
	const t1 = beginPendingSubscribe(seeded, 'room', true);
	assert.equal(settleDeniedSubscribe(seeded, 'room', t1, true), 'deny', 'authority predates the attempt');

	const shared = {};
	const t2 = beginPendingSubscribe(shared, 'room');
	const t3 = beginPendingSubscribe(shared, 'room');
	assert.equal(settleDeniedSubscribe(shared, 'room', t2, true), 'deny', 'another attempt still judges it');
	assert.equal(settleDeniedSubscribe(shared, 'room', t3, true), 'deny-unwind');
	assert.equal(pendingSubscribeTotal(shared), 0);

	assert.equal(settleDeniedSubscribe({}, 'room', 0, true), 'deny', 'no record');
});

test('a denial never records authority', () => {
	const ud = {};
	const t = beginPendingSubscribe(ud, 'room');
	beginPendingSubscribe(ud, 'room');
	settleDeniedSubscribe(ud, 'room', t, true);
	assert.equal(granted(ud), false);
});
