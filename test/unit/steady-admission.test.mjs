import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAdmissionSettled, runSteadyState } from '../../src/runtime/steadystate.js';

// THE UPGRADE CEILING, READ AT REST.
//
// A permit is taken before the upgrade and given back by the socket's close
// callback, so once a run has settled the permits and the live sockets are the
// same number by definition. They come apart exactly where the accounting is
// hard: a handshake whose client left inside the app's hook, and a socket the
// app closed from inside `open` - the second of which runs its close callback
// before `srv.upgrade` has even returned.
//
// The predicate is pure, so it is pinned here rather than only through the
// corpus that drives it. Every case below is a reading the simulator can
// actually produce.

test('an ungated server has no ceiling to settle, and is not a violation', () => {
	// The default server builds no controller at all, so every permit call is a
	// no-op. Firing here would make the hypothesis fail on every run of the
	// cross-adapter corpus, which gates nothing of the sort.
	assert.equal(checkAdmissionSettled(null), null);
	assert.equal(checkAdmissionSettled(undefined), null);
});

test('permits matching the live sockets is what settled means', () => {
	assert.equal(
		checkAdmissionSettled({ maxConnections: 5, inFlight: 0, connectionPermits: 2, deferredDepth: 0, openConnections: 2 }),
		null
	);
});

test('a handshake still in flight at quiescence is a violation', () => {
	// Its slot is the thing a later client is refused for, so a slot that is
	// still held when nothing is happening is a slot that is never coming back.
	const v = checkAdmissionSettled({ maxConnections: 5, inFlight: 1, connectionPermits: 1, deferredDepth: 0, openConnections: 1 });
	assert.equal(v.category, 'steady.admission-unsettled');
	assert.equal(v.context.reading, 'inFlight');
	assert.equal(v.context.value, 1);
});

test('a permit held by no socket is a violation', () => {
	// The leak: a refused or abandoned handshake that kept its permit. The
	// ceiling narrows by one for the rest of the process, and nothing says so.
	const v = checkAdmissionSettled({ maxConnections: 5, inFlight: 0, connectionPermits: 3, deferredDepth: 0, openConnections: 2 });
	assert.equal(v.category, 'steady.admission-unsettled');
	assert.equal(v.context.reading, 'connectionPermits');
	assert.equal(v.context.value, 3);
	assert.equal(v.context.openConnections, 2);
});

test('a socket holding no permit is a violation too, not just the leak direction', () => {
	// Fewer permits than sockets means one was released while its socket lived,
	// so the ceiling now admits a connection it has no room for. The opposite
	// error to a leak, and silent in the other direction.
	const v = checkAdmissionSettled({ maxConnections: 5, inFlight: 0, connectionPermits: 1, deferredDepth: 0, openConnections: 2 });
	assert.equal(v.context.reading, 'connectionPermits');
	assert.equal(v.context.value, 1);
});

test('the permit comparison is skipped when the live-connection ceiling is off', () => {
	// `maxConnections: 0` is the documented spelling for "disabled", and the
	// permit calls are then no-ops that leave the counter flat at zero. Comparing
	// it against the open sockets would fire on every healthy run of a server
	// gated only by `maxConcurrent`.
	assert.equal(
		checkAdmissionSettled({ maxConnections: 0, inFlight: 0, connectionPermits: 0, deferredDepth: 0, openConnections: 4 }),
		null
	);
});

test('a callback still retained by the pacing queue is a violation', () => {
	// An upgrade that was neither run nor refused: the client is still waiting on
	// a handshake that nothing will now complete.
	const v = checkAdmissionSettled({ maxConnections: 5, inFlight: 0, connectionPermits: 1, deferredDepth: 2, openConnections: 1 });
	assert.equal(v.context.reading, 'deferredDepth');
	assert.equal(v.context.value, 2);
});

test('the in-flight reading is reported first when several are wrong', () => {
	// One violation per hypothesis, so which one it names decides what a reader
	// investigates. In-flight is the earliest link in the chain: a handshake that
	// never finished is the likeliest reason the permits are wrong too.
	const v = checkAdmissionSettled({ maxConnections: 5, inFlight: 2, connectionPermits: 9, deferredDepth: 4, openConnections: 0 });
	assert.equal(v.context.reading, 'inFlight');
});

test('a missing reading is absence, not zero', () => {
	// The trajectory is assembled by the runner, and a field it stopped
	// recording would otherwise read as a clean zero forever. An object with
	// nothing in it describes a ceiling of zero holding nothing, which settles.
	assert.equal(checkAdmissionSettled({}), null);
	// But the permit comparison must not be reachable through the same gap: with
	// no ceiling recorded there is nothing to compare against.
	assert.equal(checkAdmissionSettled({ connectionPermits: 3, openConnections: 0 }), null);
});

test('the hypothesis is one of the run\'s steady-state checks, not a separate lane', () => {
	// Wired into runSteadyState, or the corpus never reads it. The trajectory is
	// otherwise clean, so anything returned here came from this predicate.
	const out = runSteadyState({
		clockSamples: [1, 2],
		drained: true,
		pending: 0,
		terminal: {},
		publishLog: [],
		clients: [],
		faults: {},
		admission: { maxConnections: 2, inFlight: 0, connectionPermits: 2, deferredDepth: 0, openConnections: 0 }
	});
	assert.equal(out.length, 1);
	assert.equal(out[0].category, 'steady.admission-unsettled');
});

test('a run on an ungated server carries no admission reading and stays clean', () => {
	const out = runSteadyState({
		clockSamples: [1, 2],
		drained: true,
		pending: 0,
		terminal: {},
		publishLog: [],
		clients: [],
		faults: {},
		admission: null
	});
	assert.deepEqual(out, []);
});
