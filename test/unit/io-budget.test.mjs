import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// I/O BUDGETS. Performance gates that can actually run on every change.
//
// These count OPERATIONS - encode calls, native publishes, socket writes - and
// never measure time. A wall-clock assertion cannot gate CI: it fails on a busy
// runner and passes on a fast one, so it gets retried until green and then
// ignored. A count is deterministic, so a failure here is always a real change
// in what the code does. The real-harness wall-clock benches in bench/ stay as
// they are, run by hand.
//
// The load-bearing shape is the SCALING invariant rather than any single
// number: "6x the input must not increase the count of X". That is what detects
// a lost batch, a lost encode-once, or a fan-out that quietly became a walk -
// the regressions that are invisible in a one-connection test and only show up
// as a flat line in a flame graph nobody is looking at.
//
// POLICY. Lowering a budget is welcome at any time and needs no discussion.
// RAISING one is a design decision: it says the adapter now does more I/O per
// unit of work than it used to. Record why in the comment on the budget, in the
// same commit that raises it. A budget edited without a reason is the gate
// failing silently.

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { platform } = await import('../../src/runtime/handler/platform.js');
const { WS_CAPS, WS_SUBSCRIPTIONS, capCounts, maxAuthoritativeSeq, sharedTopics, setServer, topicSeqs, wsConnections } =
	await import('../../src/runtime/handler/ws-state.js');
const { _resetSharedWireIds } = await import('../../src/runtime/utils/shared-wire-id.js');

const CAP = 'budget:1';

/** How much bigger the "6x" run is than the baseline run. */
const SCALE = 6;

/**
 * A native server that counts publishes instead of performing them. This is the
 * seam the cohort/fast-path fan-out goes through, so it is where "one native
 * publish, not a walk" is observable.
 */
function countingServer() {
	const counts = { publish: 0 };
	return {
		counts,
		publish(_topic, payload) {
			counts.publish++;
			return typeof payload === 'string' ? payload.length : payload.byteLength;
		},
		subscriberCount: () => 0
	};
}

/** A connection facade that counts socket writes, split by frame kind. */
function countingWs({ topics = [], caps = null } = {}) {
	const counts = { send: 0, binary: 0, text: 0 };
	const ud = { [WS_SUBSCRIPTIONS]: new Set(topics) };
	if (caps) ud[WS_CAPS] = new Set(caps);
	return {
		counts,
		ud,
		getUserData: () => ud,
		send(payload, isBinary) {
			counts.send++;
			if (isBinary) counts.binary++;
			else counts.text++;
			return 1;
		},
		subscribe: () => true,
		unsubscribe: () => true
	};
}

/** A codec that counts encode calls. `shared` picks the cohort fan-out. */
function countingCodec({ shared = false, stateful = false } = {}) {
	const counts = { encode: 0 };
	/** @type {any} */
	const wire = {
		capability: CAP,
		schemaVersion: 1,
		counts,
		encode(event) {
			counts.encode++;
			// Batch forms are declined so the per-entry fallback is exercised
			// where a test wants it; the batch tests use their own codec.
			return event.endsWith('-batch') ? null : new Uint8Array([1, 2, 3]);
		}
	};
	if (shared) wire.shared = true;
	if (stateful) wire.state = { onAttach: () => ({ n: 0 }), onDetach: () => {} };
	return wire;
}

/** Register fakes as live connections, run fn, then unwind the registry. */
function withConnections(fakes, fn) {
	for (const f of fakes) {
		wsConnections.add(f);
		if (f.ud[WS_CAPS]) capCounts.adjust(null, f.ud[WS_CAPS]);
	}
	try {
		return fn();
	} finally {
		for (const f of fakes) {
			wsConnections.delete(f);
			if (f.ud[WS_CAPS]) capCounts.adjust(f.ud[WS_CAPS], null);
		}
		sharedTopics.clear();
		topicSeqs.clear();
		maxAuthoritativeSeq.clear();
		_resetSharedWireIds();
	}
}

/**
 * Run `measure` at size 1 and at size SCALE, and assert the counted quantity did
 * not grow. The message names both readings, because "6 !== 1" alone does not
 * say which direction the regression went.
 *
 * @param {string} what
 * @param {(size: number) => number} measure
 */
function assertNoScaling(what, measure) {
	const one = measure(1);
	const many = measure(SCALE);
	assert.equal(
		many,
		one,
		`${what} scaled with the input: ${one} at 1x, ${many} at ${SCALE}x. ` +
		'Something that was amortized now runs per unit.'
	);
}

test('BUDGET: a stateless codec encodes ONCE however many capable subscribers there are', () => {
	// encode-once is the whole reason the stateless tier exists: the bytes are
	// identical for every subscriber, so the encode is hoisted out of the walk.
	// If this scales, the walk started encoding per connection and every binary
	// publish just got N times more expensive.
	assertNoScaling('stateless encode calls', (n) => {
		setServer(countingServer());
		const wire = countingCodec();
		const conns = Array.from({ length: n }, () => countingWs({ topics: ['room'], caps: [CAP] }));
		withConnections(conns, () => {
			platform.publishWire('room', 'moved', { x: 1 }, wire, { seq: true });
		});
		return wire.counts.encode;
	});
});

test('BUDGET: a shared codec is 2 native publishes, never a per-connection walk', () => {
	// A `shared` stateless codec splits the topic into bin/json cohorts and
	// hands both to the native layer: two publishes total, whatever the
	// subscriber count. Scaling here means the cohort split stopped applying and
	// the fan-out silently became a JS walk over every connection.
	const BUDGET = 2;
	let firstReading = -1;
	assertNoScaling('shared-codec native publishes', (n) => {
		const server = countingServer();
		setServer(server);
		const wire = countingCodec({ shared: true });
		const conns = Array.from({ length: n }, (_, i) =>
			countingWs({ topics: ['room'], caps: i % 2 === 0 ? [CAP] : null })
		);
		withConnections(conns, () => {
			platform.publishWire('room', 'tick', { x: 1 }, wire, { seq: true });
		});
		if (firstReading === -1) firstReading = server.counts.publish;
		return server.counts.publish;
	});
	assert.equal(firstReading, BUDGET, `the shared tier costs ${BUDGET} native publishes per event`);
});

test('BUDGET: the JSON fast path is 1 native publish and 0 socket walks', () => {
	// Nobody wants binary, so publishWire must degrade to exactly what publish()
	// would have done: one native fan-out, and the per-connection loop never
	// runs. A socket write appearing here means the fast path was lost.
	const server = countingServer();
	setServer(server);
	const wire = countingCodec();
	const conns = Array.from({ length: SCALE }, () => countingWs({ topics: ['room'] }));
	withConnections(conns, () => {
		platform.publishWire('room', 'moved', { x: 1 }, wire, { seq: true });
	});
	assert.equal(server.counts.publish, 1, 'one native publish');
	assert.equal(wire.counts.encode, 0, 'and the codec was never asked to encode');
	for (const c of conns) assert.equal(c.counts.send, 0, 'the walk never ran');
});

test('BUDGET: a batch is ONE frame per capable connection, not one per entry', () => {
	// The batch member exists to collapse a tick's updates into a single frame.
	// If the frame count follows the entry count, the batch form was declined or
	// dropped and every subscriber is paying per-entry framing again.
	const statefulBatchCodec = () => ({
		capability: CAP,
		schemaVersion: 1,
		encode: () => new Uint8Array([9]),
		state: { onAttach: () => ({ n: 0 }), onDetach: () => {} }
	});
	assertNoScaling('binary frames per capable connection', (entries) => {
		setServer(countingServer());
		const capable = countingWs({ topics: ['room'], caps: [CAP] });
		withConnections([capable], () => {
			platform.publishWireBatch(
				'room',
				'moved',
				Array.from({ length: entries }, (_, i) => ({ data: { x: i } })),
				statefulBatchCodec(),
				{ seq: true }
			);
		});
		return capable.counts.binary;
	});
});

test('BUDGET: publishing to a topic nobody holds costs zero socket writes', () => {
	// The no-op case. A publish with no subscribers must not touch a socket, and
	// must not encode. This is the cheapest possible regression detector for a
	// fan-out that stopped checking membership before doing work.
	const server = countingServer();
	setServer(server);
	const wire = countingCodec();
	const bystanders = Array.from({ length: SCALE }, () => countingWs({ topics: ['other'] }));
	withConnections(bystanders, () => {
		platform.publishWire('room', 'moved', { x: 1 }, wire, { seq: true });
	});
	for (const b of bystanders) assert.equal(b.counts.send, 0, 'no socket was written');
});

test('the scaling detector detects scaling (this file has teeth)', () => {
	// A budget gate that cannot fail is worse than no gate: it reads as coverage
	// and gates nothing. So the detector is pointed at a case that MUST scale -
	// a stateful codec carries per-connection dictionary state, so its encode
	// genuinely runs once per capable connection and cannot be hoisted.
	//
	// If this test ever fails, assertNoScaling has stopped detecting growth and
	// every budget above it is passing vacuously.
	const stateful = countingCodec({ stateful: true });
	assert.throws(
		() =>
			assertNoScaling('deliberately-scaling encode calls', (n) => {
				setServer(countingServer());
				const conns = Array.from({ length: n }, () =>
					countingWs({ topics: ['room'], caps: [CAP] })
				);
				withConnections(conns, () => {
					platform.publishWire('room', 'moved', { x: 1 }, stateful, { seq: true });
				});
				return stateful.counts.encode;
			}),
		/scaled with the input/,
		'the detector must reject a per-connection encode'
	);
});
