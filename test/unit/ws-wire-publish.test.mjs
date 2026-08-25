import { test } from 'node:test';
import assert from 'node:assert/strict';

// The binary fan-out members: capable subscribers get the 0x03 frame, everyone
// else the exact publish() envelope with the SAME seq, the fast path never
// walks, and the shared tier splits into cohort topics. Fake facades are
// injected into the live-connection registry - the platform walks JS-visible
// facades, which is what makes the scripted-send technique work.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';


const { platform } = await import('../../src/runtime/handler/platform.js');
const { WS_CAPS, WS_SUBSCRIPTIONS, capCounts, maxAuthoritativeSeq, sharedTopics, setServer, topicSeqs, wsConnections } =
	await import('../../src/runtime/handler/ws-state.js');
const { wireStatePoisoned } = await import('../../src/runtime/handler/wire-state.js');
const { leaveSharedCohort } = await import('../../src/runtime/handler/cohort.js');
const { parseBinaryFrame } = await import('../../src/runtime/utils/wire.js');
const { SHARED_WIRE_ID_BASE, _resetSharedWireIds, getSharedWireId } = await import(
	'../../src/runtime/utils/shared-wire-id.js'
);

const CAP = 'cap:1';

/** A fake native server recording its publishes. */
function fakeServer() {
	const published = [];
	return {
		published,
		publish(topic, payload, compress) {
			published.push({ topic, payload, compress });
			return typeof payload === 'string' ? payload.length : payload.byteLength;
		},
		subscriberCount: () => 0
	};
}

function fakeWs({ topics = [], caps = null, script = [] } = {}) {
	const sent = [];
	const nativeSubs = new Set(topics);
	const ud = { [WS_SUBSCRIPTIONS]: new Set(topics) };
	if (caps) ud[WS_CAPS] = new Set(caps);
	return {
		sent,
		ud,
		nativeSubs,
		getUserData: () => ud,
		send(payload, isBinary, compress) {
			sent.push({ payload, isBinary, compress });
			return script.length ? script.shift() : 1;
		},
		subscribe(topic) {
			nativeSubs.add(topic);
			return true;
		},
		unsubscribe(topic) {
			return nativeSubs.delete(topic);
		}
	};
}

/**
 * Run fn with the given fakes registered as live connections. Declared caps
 * are counted in the live capability counts the way a real hello would, and
 * released afterwards the way close does.
 */
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
		_resetSharedWireIds();
	}
}

const statelessCodec = (overrides = {}) => ({
	capability: CAP,
	schemaVersion: 2,
	encode: (event, data) => (data == null ? null : new Uint8Array([4, 2])),
	...overrides
});

setServer(fakeServer());

test('the JSON fast path is one native publish when nobody wants binary', () => {
	const server = fakeServer();
	setServer(server);
	const jsonOnly = fakeWs({ topics: ['room'] });
	withConnections([jsonOnly], () => {
		const ok = platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { seq: true });
		assert.equal(ok, true);
		assert.equal(server.published.length, 1, 'one native fan-out, no walk');
		assert.equal(server.published[0].topic, 'room');
		assert.equal(jsonOnly.sent.length, 0, 'the walk never ran');
		const env = JSON.parse(server.published[0].payload);
		assert.equal(env.seq, 1, 'the fast path still stamps seq');
	});
});

test('a mixed room: binary to the capable, the SAME-seq envelope to the rest', () => {
	setServer(fakeServer());
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	const jsonOnly = fakeWs({ topics: ['room'] });
	const stranger = fakeWs({ topics: ['other'] });
	withConnections([capable, jsonOnly, stranger], () => {
		const ok = platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { seq: true });
		assert.equal(ok, true);
		// Capable: announce, then the frame.
		assert.equal(capable.sent.length, 2);
		assert.deepEqual(JSON.parse(capable.sent[0].payload), { type: 'wire-id', topic: 'room', id: 1 });
		const frame = parseBinaryFrame(capable.sent[1].payload);
		assert.ok(frame);
		assert.deepEqual([...frame.payload], [4, 2]);
		// JSON-only: the envelope, with the SAME seq the frame carries.
		assert.equal(jsonOnly.sent.length, 1);
		const env = JSON.parse(jsonOnly.sent[0].payload);
		assert.equal(env.seq, frame.seq, 'binary frame and JSON envelope carry one seq');
		assert.equal(env.topic, 'room');
		// Non-subscriber: nothing.
		assert.equal(stranger.sent.length, 0);
	});
});

test('a seq the wire cannot carry throws, and publishes nothing at all', () => {
	// The defect this pins: an explicit seq went to both wires unchecked, and
	// the frame varint encodes -1 and parses it back as 127 while the envelope
	// keeps -1. A capable client and a JSON-only client on the same topic then
	// read two different sequence numbers for one event - the exact parity the
	// binary tier exists to guarantee - and the watermark the client stores is a
	// number the server never meant. It fails fast now rather than corrupting
	// the wire: publishing seq-less instead would degrade the client's resume
	// dedup with nothing to notice it by.
	setServer(fakeServer());
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	const jsonOnly = fakeWs({ topics: ['room'] });
	try {
		withConnections([capable, jsonOnly], () => {
			assert.throws(
				() => platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { seq: -1 }),
				(err) => err instanceof TypeError && /integer >= 1/.test(err.message),
				'a TypeError naming the rule'
			);
			assert.equal(capable.sent.length, 0, 'no binary frame went out');
			assert.equal(jsonOnly.sent.length, 0, 'and no envelope either');
			assert.equal(maxAuthoritativeSeq.get('room'), undefined, 'the topic was not marked');
		});
	} finally {
		maxAuthoritativeSeq.clear();
	}
});

test('0 and a fractional seq throw too, from BOTH publish lanes', () => {
	// 0 is the binary frame's "no seq" sentinel, so a stamped 0 vanishes for
	// binary subscribers while the envelope carries "seq":0. A fractional seq
	// splits the wires the other way: truncated on the frame, printed in full in
	// the envelope. Driven through publishWireBatch's PER-ENTRY seq as well,
	// because that path stamps without reaching stampSeq and would otherwise
	// keep its own unchecked lane.
	setServer(fakeServer());
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
	try {
		withConnections([capable], () => {
			assert.throws(
				() => platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { seq: 0 }),
				TypeError,
				'0 is the no-seq sentinel, not a seq'
			);
			assert.throws(
				() => platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { seq: 1.5 }),
				TypeError
			);
			assert.throws(
				() =>
					platform.publishWireBatch(
						'room',
						'moved',
						[{ data: { x: 1 }, seq: 2.5 }],
						statefulCodec
					),
				TypeError,
				'the per-entry lane takes the same check'
			);
			// The batch is refused WHOLE: a bad entry anywhere must not leave the
			// earlier ones fanned out with the topic's mark already advanced.
			assert.throws(
				() =>
					platform.publishWireBatch(
						'room',
						'moved',
						[{ data: { x: 1 }, seq: 5 }, { data: { x: 2 }, seq: 0 }],
						statefulCodec
					),
				TypeError
			);
			assert.equal(capable.sent.length, 0, 'nothing was sent for the half-good batch');
			assert.equal(
				maxAuthoritativeSeq.get('room'),
				undefined,
				'and the valid entry did not mark the topic on the way past'
			);
		});
	} finally {
		maxAuthoritativeSeq.clear();
	}
});

test('a toJSON mutating a later entry cannot change what the batch publishes', () => {
	// The preflight accepted [21, 22]; the publish loops then run app code
	// (completeEnvelope's JSON.stringify calls any toJSON), which holds live
	// references to the caller's entries. Re-reading entry.seq after that
	// point stamps a value the preflight never saw - and on the stateless
	// reroute, where entry 0 has already fanned out, the re-read value throws
	// MID-batch, breaking the whole-batch-or-nothing rule the preflight
	// exists to enforce. The seqs published must be the seqs validated, on
	// both lanes.
	const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
	try {
		for (const wire of [statelessCodec(), statefulCodec]) {
			const srv = fakeServer();
			setServer(srv);
			const entries = [
				{ data: { toJSON: () => { entries[1].seq = 0; return { x: 1 }; } }, seq: 21 },
				{ data: { x: 2 }, seq: 22 }
			];
			const ok = platform.publishWireBatch('room', 'moved', entries, wire);
			assert.equal(ok, true, 'the batch went out whole');
			assert.equal(entries[1].seq, 0, 'the mutation really ran');
			assert.equal(srv.published.length, 2, 'both entries were published');
			assert.deepEqual(
				srv.published.map((p) => JSON.parse(p.payload).seq),
				[21, 22],
				'each entry carries the seq the preflight accepted'
			);
			assert.equal(maxAuthoritativeSeq.get('room'), 22, 'the mark followed the stamped seqs');
			maxAuthoritativeSeq.clear();
		}
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test("a toJSON writing into the caller's options cannot hand later entries a seq", () => {
	// The batch-level numeric-seq refusal runs once, up front. A toJSON that
	// writes a number into the SAME options object afterwards would hand
	// every later entry an explicit seq no preflight saw - the refused
	// batch-level form, readmitted through the back door and marking the
	// topic on the way.
	const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
	try {
		for (const wire of [statelessCodec(), statefulCodec]) {
			const srv = fakeServer();
			setServer(srv);
			const options = { compress: false };
			const entries = [
				{ data: { toJSON: () => { options.seq = 7; return { x: 1 }; } } },
				{ data: { x: 2 } }
			];
			const ok = platform.publishWireBatch('room', 'moved', entries, wire, options);
			assert.equal(ok, true);
			assert.equal(options.seq, 7, 'the mutation really ran');
			assert.equal(srv.published.length, 2);
			// The options carried no seq, so every entry draws the per-topic
			// counter - consecutively, and never the injected 7.
			const stamped = srv.published.map((p) => JSON.parse(p.payload).seq);
			assert.equal(stamped.includes(7), false, 'no entry drew the injected seq');
			assert.equal(typeof stamped[0], 'number');
			assert.equal(stamped[1], stamped[0] + 1, 'consecutive counter values');
			assert.equal(maxAuthoritativeSeq.get('room'), undefined, 'and the topic was never marked');
			maxAuthoritativeSeq.clear();
		}
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test('a toJSON growing or shrinking the batch cannot change its membership', () => {
	// entries.push from inside a payload's toJSON would otherwise feed the
	// publish loops an entry whose seq was never preflighted: an invalid one
	// throws mid-batch with the earlier entries already delivered (stateless
	// reroute) or refuses a batch the preflight accepted whole (stateful
	// lane). entries.pop is the other direction: a hole where an accepted
	// entry stood, and dereferencing it throws mid-batch the same way. The
	// membership published is the membership handed in.
	const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
	try {
		for (const wire of [statelessCodec(), statefulCodec]) {
			const srv = fakeServer();
			setServer(srv);
			const entries = [
				{
					data: { toJSON: () => { entries.push({ data: { x: 3 }, seq: 0 }); return { x: 1 }; } },
					seq: 21
				},
				{ data: { x: 2 }, seq: 22 }
			];
			const ok = platform.publishWireBatch('room', 'moved', entries, wire);
			assert.equal(ok, true, 'the accepted batch went out whole');
			assert.equal(entries.length, 3, 'the mutation really ran');
			assert.equal(srv.published.length, 2, 'the appended entry was not published');
			maxAuthoritativeSeq.clear();

			const srv2 = fakeServer();
			setServer(srv2);
			const shrinking = [
				{
					data: { toJSON: () => { shrinking.pop(); return { x: 1 }; } },
					seq: 31
				},
				{ data: { x: 2 }, seq: 32 },
				{ data: { x: 3 }, seq: 33 }
			];
			const ok2 = platform.publishWireBatch('room', 'moved', shrinking, wire);
			assert.equal(ok2, true, 'the accepted batch went out whole');
			assert.equal(shrinking.length, 2, 'the mutation really ran');
			assert.deepEqual(
				srv2.published.map((p) => JSON.parse(p.payload).seq),
				[31, 32, 33],
				'every accepted entry was still published'
			);
			maxAuthoritativeSeq.clear();
		}
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test('a toJSON flipping excludeWs cannot change who a batch excludes', () => {
	// Exclusion is a delivery contract, not payload: the socket a caller
	// excluded at call time must stay excluded on every path (fan-out choice,
	// per-socket walk, resume capture), and one a caller did NOT exclude must
	// be delivered to. Re-reading the live entry lets a toJSON answer those
	// questions differently at different points in one call.
	try {
		// Stateless reroute: entry 0's toJSON excludes the only subscriber
		// from entry 1. Captured, entry 1 still fans out natively.
		const srv = fakeServer();
		setServer(srv);
		const jsonOnly = fakeWs({ topics: ['room'] });
		withConnections([jsonOnly], () => {
			const entries = [
				{ data: { toJSON: () => { entries[1].excludeWs = jsonOnly; return { x: 1 }; } } },
				{ data: { x: 2 } }
			];
			const ok = platform.publishWireBatch('room', 'moved', entries, statelessCodec());
			assert.equal(ok, true);
			assert.equal(entries[1].excludeWs, jsonOnly, 'the mutation really ran');
			assert.equal(srv.published.length, 2, 'both entries kept the native fan-out');
		});

		// Stateful lane: entry 0 excludes a socket at call time, and its own
		// toJSON then CLEARS that exclusion. Captured, the walk still
		// withholds entry 0 from the excluded socket.
		const srv2 = fakeServer();
		setServer(srv2);
		const excluded = fakeWs({ topics: ['room'] });
		const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
		withConnections([excluded], () => {
			const entries = [
				{
					data: { toJSON: () => { entries[0].excludeWs = undefined; return { x: 1 }; } },
					excludeWs: excluded
				},
				{ data: { x: 2 } }
			];
			const ok = platform.publishWireBatch('room', 'moved', entries, statefulCodec);
			assert.equal(ok, true);
			assert.equal(entries[0].excludeWs, undefined, 'the mutation really ran');
			assert.equal(excluded.sent.length, 1, 'the excluded socket received only entry 1');
			assert.ok(excluded.sent[0].payload.includes('"x":2'), excluded.sent[0].payload);
			assert.equal(srv2.published.length, 0, 'an excluding batch never takes the fast path');
		});
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test('an options accessor cannot answer the seq refusal and the stamp differently', () => {
	// The batch-level numeric-seq refusal and the value the counter lane later
	// stamps from must be ONE read. With two reads, a getter can answer the
	// refusal with `true` and the stamp with a number - the refused
	// batch-level form back in through the side door, stamping every entry
	// with one shared seq and marking the topic for a value no check accepted.
	const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
	try {
		for (const wire of [statelessCodec(), statefulCodec]) {
			const srv = fakeServer();
			setServer(srv);
			let reads = 0;
			const options = { get seq() { return reads++ === 0 ? true : 7; } };
			const entries = [{ data: { x: 1 } }, { data: { x: 2 } }];
			const ok = platform.publishWireBatch('room', 'moved', entries, wire, options);
			assert.equal(ok, true);
			assert.equal(reads, 1, 'the capture is the single read the accessor ever answers');
			assert.deepEqual(
				srv.published.map((p) => JSON.parse(p.payload).seq),
				[1, 2],
				'the one captured read (true) drew the counter, never the 7'
			);
			assert.equal(maxAuthoritativeSeq.get('room'), undefined, 'the topic was never marked');
			maxAuthoritativeSeq.clear();
			topicSeqs.clear();
		}
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test('a batch-level numeric seq carried on a prototype is refused like an own one', () => {
	// The capture reads named fields through the prototype chain. A spread
	// would copy own enumerable properties only, so a numeric seq sitting on
	// a prototype - a class-based config object, an inherited accessor -
	// would vanish from the copy and publish the batch seq-less, while
	// publish() hands the same object to stampSeq, reads through the chain,
	// and throws. One options object must mean one thing on every lane.
	class Config {
		get seq() {
			return 500;
		}
	}
	const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
	try {
		for (const wire of [statelessCodec(), statefulCodec]) {
			for (const options of [Object.create({ seq: 500 }), new Config()]) {
				const srv = fakeServer();
				setServer(srv);
				assert.throws(
					() => platform.publishWireBatch('room', 'moved', [{ data: { x: 1 } }], wire, options),
					(err) => err instanceof TypeError && /batch-level/.test(err.message),
					'refused exactly like an own-property batch-level seq'
				);
				assert.equal(srv.published.length, 0, 'nothing was published');
				assert.equal(maxAuthoritativeSeq.get('room'), undefined, 'and nothing was marked');
			}
		}
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test('app code flipping options.seq mid-publish cannot change what gets recorded', () => {
	// stampSeq consumes options.seq before completeEnvelope runs the
	// payload's toJSON; the authority decision and the resume capture read it
	// after. Uncaptured, a toJSON that writes a number into the caller's
	// options hands notePublishedSeq a COUNTER value marked authoritative - a
	// local counter seq entering the cluster-authoritative dedup floor, the
	// cross-space clobber that mark's own contract rules out, and the next
	// gap-fill window then discards genuine explicit-seq frames as
	// already-seen. The inverse flip would strip a delivered explicit seq of
	// its authority. Both single lanes; the batch pins the same discipline in
	// the accessor test above.
	const lanes = {
		publish: (data, opts) => platform.publish('room', 'said', data, opts),
		publishWire: (data, opts) => platform.publishWire('room', 'moved', data, statelessCodec(), opts)
	};
	for (const [lane, run] of Object.entries(lanes)) {
		setServer(fakeServer());
		try {
			const counterOpts = { seq: true };
			run({ toJSON() { counterOpts.seq = 7; return { x: 1 }; } }, counterOpts);
			assert.equal(counterOpts.seq, 7, lane + ': the mutation really ran');
			assert.equal(topicSeqs.get('room'), 1, lane + ': the counter lane stamped normally');
			assert.equal(
				maxAuthoritativeSeq.get('room'),
				undefined,
				lane + ': the counter value never entered the authoritative space'
			);

			const explicitOpts = { seq: 9 };
			run({ toJSON() { explicitOpts.seq = true; return { x: 1 }; } }, explicitOpts);
			assert.equal(explicitOpts.seq, true, lane + ': the inverse mutation really ran');
			assert.equal(
				maxAuthoritativeSeq.get('room'),
				9,
				lane + ': the stamped explicit seq kept its authority'
			);
		} finally {
			maxAuthoritativeSeq.clear();
			topicSeqs.clear();
		}
	}
});

test('a toJSON swapping a later entry\'s payload reference publishes the reference handed in', () => {
	// The record pins the data REFERENCE at the top of the call; only the
	// object's contents stay live. Re-reading entry.data lets entry 0's
	// toJSON hand entry 1 a different object - and on the walk lanes the
	// binary encode reads data later than the JSON envelope did, so the two
	// wires could carry different payloads under one seq.
	const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
	try {
		for (const wire of [statelessCodec(), statefulCodec]) {
			const srv = fakeServer();
			setServer(srv);
			const entries = [
				{ data: { toJSON: () => { entries[1].data = { x: 99 }; return { x: 1 }; } } },
				{ data: { x: 2 } }
			];
			const ok = platform.publishWireBatch('room', 'moved', entries, wire);
			assert.equal(ok, true);
			assert.deepEqual(entries[1].data, { x: 99 }, 'the mutation really ran');
			assert.ok(
				srv.published[1].payload.includes('"x":2'),
				'entry 1 published the object it was handed: ' + srv.published[1].payload
			);
		}
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test('a codec returning a non-Uint8Array declines, it does not hang the loop', { timeout: 5000 }, () => {
	// safeEncode exists to keep a misbehaving codec from taking the fan-out with
	// it, and it caught a THROW but not a wrong-type return. Untyped, the value
	// reached buildBinaryFrame, which sizes its writer `8 + payload.length` -
	// NaN for anything without a numeric length - and the writer's growth loop
	// could not grow a zero-capacity buffer. The codec's bug became a hung event
	// loop. An accidentally-async encode is the likely route: a Promise is
	// truthy and has no length.
	const errors = [];
	const realError = console.error;
	console.error = (...args) => errors.push(args.map(String).join(' '));
	try {
		for (const bad of [{}, 'bytes', Promise.resolve(new Uint8Array([1]))]) {
			const srv = fakeServer();
			setServer(srv);
			const capable = fakeWs({ topics: ['room'], caps: [CAP] });
			withConnections([capable], () => {
				const ok = platform.publishWire(
					'room',
					'moved',
					{ x: 1 },
					statelessCodec({ encode: () => bad })
				);
				assert.equal(ok, true, 'the publish still reported delivery');
			});
			assert.equal(srv.published.length, 1, 'it went out as the plain JSON fan-out instead');
			// The type IS the assertion: a binary frame would be a Uint8Array
			// here. Checking the connection's own sends would prove nothing -
			// the declined path returns before any per-connection walk, so that
			// list is empty either way.
			assert.equal(
				typeof srv.published[0].payload,
				'string',
				'the fan-out carried the JSON envelope, not a frame built from the bad value'
			);
			assert.ok(srv.published[0].payload.includes('"topic":"room"'), srv.published[0].payload);
		}
	} finally {
		console.error = realError;
	}
	// An EXACT count, which holds only while the shared throttle enters this
	// test with fewer than seven failures consumed (the schedule logs every
	// one of the first nine). Earlier tests in this file fail no encodes, so
	// that holds today; the any-offset contract is the bounded test below.
	assert.equal(errors.length, 3, 'each bad return was reported');
	assert.ok(errors[0].includes('Return a Uint8Array'), errors[0]);
	assert.ok(errors[0].includes('object'), 'and named the type it got: ' + errors[0]);
	assert.ok(errors[1].includes('string'), 'and named the type it got: ' + errors[1]);
});

test('a persistently broken codec produces a BOUNDED diagnostic, not one line per publish', () => {
	// safeEncode runs inside the fan-out, so an unthrottled failure log is one
	// synchronous stderr write per publish - on a busy topic that trades the
	// codec's bug for an event-loop stall, which is the same class of failure
	// the wrong-type guard itself exists to prevent. The log goes through the
	// decaying throttle: every one of the first nine, then powers of ten, so
	// ten thousand failures may produce at most fourteen lines from ANY
	// starting point in the schedule. The exact count depends on what earlier
	// tests consumed from the shared throttle; the BOUND does not, and the
	// bound is the contract.
	const errors = [];
	const realError = console.error;
	console.error = (...args) => errors.push(args.map(String).join(' '));
	const N = 10_000;
	try {
		setServer(fakeServer());
		const capable = fakeWs({ topics: ['room'], caps: [CAP] });
		withConnections([capable], () => {
			const wire = statelessCodec({ encode: () => ({}) });
			for (let i = 0; i < N; i++) {
				platform.publishWire('room', 'moved', { x: i }, wire);
			}
		});
	} finally {
		console.error = realError;
	}
	assert.ok(errors.length >= 1, 'the failure is still reported at all');
	assert.ok(
		errors.length <= 14,
		`${N} failures produced ${errors.length} log lines - the throttle is not wired`
	);
	assert.match(
		errors[errors.length - 1],
		/x\d+/,
		'the last line carries the occurrence count, so an operator sees it is ongoing'
	);
});

test('a failing STATEFUL encode poisons the capability to JSON; a decline does not', () => {
	// A stateful codec mutates its per-connection state during encode -
	// interned keys, advanced baselines. An encode that threw, or returned a
	// wrong-type value, escaped partway: that state may now reference entries
	// the client never received, and the next successful frame would decode
	// against a dictionary the client does not have, silently. Same evidence
	// as a dropped stateful frame, same recovery tier: JSON until reconnect.
	// A null return is the codec's deliberate decline, leaves its state
	// coherent by contract, and must keep binary available.
	const realError = console.error;
	console.error = () => {};
	try {
		for (const failure of ['throw', 'wrong-type']) {
			setServer(fakeServer());
			const capable = fakeWs({ topics: ['room'], caps: [CAP] });
			let mode = 'ok';
			const wire = {
				capability: CAP,
				schemaVersion: 2,
				state: { onAttach: () => ({}) },
				encode: () => {
					if (mode === 'throw') throw new Error('codec died mid-encode');
					if (mode === 'wrong-type') return {};
					if (mode === 'decline') return null;
					return new Uint8Array([4, 2]);
				}
			};
			withConnections([capable], () => {
				platform.publishWire('room', 'moved', { x: 1 }, wire);
				assert.ok(
					capable.sent.some((s) => s.payload instanceof Uint8Array),
					failure + ': binary flowed while the codec behaved'
				);
				capable.sent.length = 0;
				mode = 'decline';
				platform.publishWire('room', 'moved', { x: 2 }, wire);
				mode = 'ok';
				platform.publishWire('room', 'moved', { x: 3 }, wire);
				assert.equal(wireStatePoisoned(capable.ud, CAP), false, failure + ': a decline poisons nothing');
				assert.ok(
					capable.sent.some((s) => s.payload instanceof Uint8Array),
					failure + ': binary still available after a decline'
				);
				capable.sent.length = 0;
				mode = failure;
				platform.publishWire('room', 'moved', { x: 4 }, wire);
				assert.equal(wireStatePoisoned(capable.ud, CAP), true, failure + ': the failure poisoned');
				mode = 'ok';
				platform.publishWire('room', 'moved', { x: 5 }, wire);
				assert.ok(capable.sent.length >= 2, failure + ': both frames were still delivered');
				assert.ok(
					capable.sent.every((s) => typeof s.payload === 'string'),
					failure + ': JSON only, from the failing frame on'
				);
			});
		}
	} finally {
		console.error = realError;
	}
});

test("an inner re-entrant failure cannot poison an outer codec's clean decline", () => {
	// encode is app code and may publish re-entrantly. The failure flag is
	// written after EVERY return path of the encode it describes - an
	// entry-time reset instead would let an inner call's failure survive an
	// outer call's clean decline, and one codec's bug would then poison a
	// DIFFERENT codec's healthy connection.
	const realError = console.error;
	console.error = () => {};
	try {
		setServer(fakeServer());
		const innerWire = { capability: 'cap:inner', schemaVersion: 1, encode: () => ({}) };
		const outer = fakeWs({ topics: ['room'], caps: [CAP, 'cap:inner'] });
		const outerWire = {
			capability: CAP,
			schemaVersion: 2,
			state: { onAttach: () => ({}) },
			encode: () => {
				// The inner publish FAILS (wrong-type return, stateless codec:
				// poisons nothing itself) and then this codec declines cleanly.
				platform.publishWire('room', 'inner-moved', { x: 1 }, innerWire);
				return null;
			}
		};
		withConnections([outer], () => {
			platform.publishWire('room', 'moved', { x: 1 }, outerWire);
			assert.equal(
				wireStatePoisoned(outer.ud, CAP),
				false,
				"the outer decline stayed a decline - the inner failure's flag did not leak"
			);
			assert.equal(
				wireStatePoisoned(outer.ud, 'cap:inner'),
				false,
				'and the stateless inner codec never poisons anything'
			);
		});
	} finally {
		console.error = realError;
	}
});

test('a failing stateful BATCH encode poisons and serves the JSON envelopes', () => {
	// The batch form encodes every entry against the connection state in one
	// call. A failure may have advanced the dictionaries partway, so the
	// per-entry retry a clean decline earns would encode against state the
	// client never learned; a failure serves the whole list as JSON and
	// degrades the capability, exactly like the dropped-frame poisoning
	// beside it.
	const realError = console.error;
	console.error = () => {};
	try {
		setServer(fakeServer());
		const capable = fakeWs({ topics: ['room'], caps: [CAP] });
		let fail = true;
		const wire = {
			capability: CAP,
			schemaVersion: 2,
			state: { onAttach: () => ({}) },
			encode: (event) => {
				if (fail && event === 'moved-batch') throw new Error('batch encode died');
				return new Uint8Array([4, 2]);
			}
		};
		withConnections([capable], () => {
			const ok = platform.publishWireBatch(
				'room',
				'moved',
				[{ data: { x: 1 } }, { data: { x: 2 } }],
				wire
			);
			assert.equal(ok, true, 'the entries were still delivered');
			assert.equal(capable.sent.length, 2, 'one JSON envelope per entry');
			assert.ok(
				capable.sent.every((s) => typeof s.payload === 'string'),
				'no per-entry binary was built from the failed state'
			);
			assert.equal(wireStatePoisoned(capable.ud, CAP), true, 'the capability is poisoned');
			fail = false;
			capable.sent.length = 0;
			platform.publishWireBatch('room', 'moved', [{ data: { x: 3 } }], wire);
			assert.ok(
				capable.sent.every((s) => typeof s.payload === 'string'),
				'JSON until reconnect'
			);
		});
	} finally {
		console.error = realError;
	}
});

test('a failing stateful encode poisons on the send lanes too', () => {
	const realError = console.error;
	console.error = () => {};
	try {
		setServer(fakeServer());
		const capable = fakeWs({ topics: ['room'], caps: [CAP] });
		let fail = true;
		const wire = {
			capability: CAP,
			schemaVersion: 2,
			state: { onAttach: () => ({}) },
			encode: () => {
				if (fail) throw new Error('encode died');
				return new Uint8Array([4, 2]);
			}
		};
		platform.sendWire(capable, 'room', 'snapshot', { x: 1 }, wire);
		assert.equal(wireStatePoisoned(capable.ud, CAP), true, 'sendWire poisoned on the failure');
		fail = false;
		capable.sent.length = 0;
		platform.sendWire(capable, 'room', 'snapshot', { x: 2 }, wire);
		assert.ok(
			capable.sent.every((s) => typeof s.payload === 'string'),
			'JSON after the poison'
		);

		const capable2 = fakeWs({ topics: ['room'], caps: [CAP] });
		let failBatch = true;
		const wire2 = {
			capability: CAP,
			schemaVersion: 2,
			state: { onAttach: () => ({}) },
			encode: (event) => {
				if (failBatch && event === 'snap-batch') throw new Error('batch encode died');
				return new Uint8Array([4, 2]);
			}
		};
		platform.sendWireBatch(capable2, 'room', 'snap', [{ data: { x: 1 } }, { data: { x: 2 } }], wire2);
		assert.equal(
			wireStatePoisoned(capable2.ud, CAP),
			true,
			'sendWireBatch poisoned on the batch failure'
		);
		assert.equal(capable2.sent.length, 2, 'both entries arrived as JSON envelopes');
		assert.ok(capable2.sent.every((s) => typeof s.payload === 'string'));
	} finally {
		console.error = realError;
	}
});

const statefulCodec = () => ({ capability: CAP, schemaVersion: 2, encode: () => null, state: {} });

test('a publish refused on a PAYLOAD leaves no mark, on every atomic lane', () => {
	// The seq check refuses before anything is stamped. The envelope build is
	// the OTHER throw site - it runs JSON.stringify, so any payload the app
	// cannot serialise, including a toJSON of its own - and every lane used to
	// raise the topic's authoritative mark before reaching it.
	//
	// That mark is the resume dedup floor. Raised for a frame that never went
	// out, the next gap-fill window discards the republished frame as
	// already-seen: a silent gap, and strictly worse than the publishCount
	// drift sitting next to it.
	//
	// The two-entry batch is not redundant with the single publishes. It pins
	// the WHOLE-batch guarantee: an entry that serialised successfully, before a
	// later one threw, must also leave no mark behind.
	const lanes = {
		publish: () => platform.publish('room', 'said', { n: 1n }, { seq: 40 }),
		publishWire: () =>
			platform.publishWire('room', 'moved', { n: 1n }, statelessCodec(), { seq: 40 }),
		'publishWireBatch (stateful)': () =>
			platform.publishWireBatch(
				'room',
				'moved',
				[{ data: { x: 1 }, seq: 40 }, { data: { n: 1n }, seq: 41 }],
				statefulCodec()
			)
	};
	for (const [lane, run] of Object.entries(lanes)) {
		const srv = fakeServer();
		setServer(srv);
		const capable = fakeWs({ topics: ['room'], caps: [CAP] });
		try {
			const before = platform.publishCount;
			withConnections([capable], () => {
				assert.throws(run, TypeError, lane);
			});
			assert.equal(maxAuthoritativeSeq.get('room'), undefined, lane + ': marked nothing');
			assert.equal(platform.publishCount, before, lane + ': counted nothing');
			// Both delivery routes: publish() reaches sockets only through the
			// native fan-out, the wire lanes through the walk - asserting one
			// of them would leave the other lane's assertion vacuous.
			assert.equal(capable.sent.length, 0, lane + ': sent nothing on the walk');
			assert.equal(srv.published.length, 0, lane + ': and nothing on the native fan-out');
		} finally {
			maxAuthoritativeSeq.clear();
			topicSeqs.clear();
		}
	}
});

test('a refused publish leaves the { seq: true } counter advanced, on purpose', () => {
	// The one piece of state a refusal does NOT rewind, pinned as a decision
	// on the record.
	//
	// It cannot be rewound safely: completeEnvelope runs JSON.stringify, so a
	// toJSON can publish re-entrantly and take the next counter value, and a
	// rollback would then hand two frames the same seq - which is worse than a
	// gap by exactly the margin that makes seqs useful. And it costs nothing:
	// the counter is a separate space, never deduped and never marking the
	// topic, so the only consequence is a gap in that topic's counter numbering.
	// Nothing in the README or the wire contract calls that lane contiguous.
	setServer(fakeServer());
	try {
		platform.publish('room', 'said', { x: 1 }, { seq: true });
		assert.equal(topicSeqs.get('room'), 1);
		assert.throws(() => platform.publish('room', 'said', { n: 1n }, { seq: true }), TypeError);
		platform.publish('room', 'said', { x: 3 }, { seq: true });
		assert.equal(topicSeqs.get('room'), 3, 'the refused publish consumed its counter value');
		assert.equal(
			maxAuthoritativeSeq.get('room'),
			undefined,
			'and marked nothing, which is why the gap is harmless'
		);
	} finally {
		topicSeqs.clear();
		maxAuthoritativeSeq.clear();
	}
});

test('the stateless batch reroute keeps what already went out, and marks no more', () => {
	// This lane is N sequential publishWire calls, so it is NOT atomic and the
	// contract is deliberately different: entry 0 really was delivered, so its
	// mark and its count must STAND, the failing entry marks nothing, and the
	// throw carries out of the call - entries AFTER the failure are never
	// attempted, not published independently. Pinned explicitly so the
	// asymmetry with the stateful lane above is a decision on the record rather
	// than something a later reader has to infer from a passing suite.
	setServer(fakeServer());
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	try {
		const before = platform.publishCount;
		withConnections([capable], () => {
			assert.throws(
				() =>
					platform.publishWireBatch(
						'room',
						'moved',
						[
							{ data: { x: 1 }, seq: 40 },
							{ data: { n: 1n }, seq: 41 },
							{ data: { x: 3 }, seq: 42 }
						],
						statelessCodec()
					),
				TypeError
			);
		});
		assert.equal(maxAuthoritativeSeq.get('room'), 40, 'the entry that DID publish kept its mark');
		assert.equal(platform.publishCount, before + 1, 'and its count');
		assert.notEqual(maxAuthoritativeSeq.get('room'), 41, 'the entry that threw marked nothing');
		assert.equal(
			capable.sent.length,
			2,
			'announce plus one frame: the entry after the failure was never attempted'
		);
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test('a refused publish is not counted in publishCount, on any lane', () => {
	// `publishCount` is documented as "topic publishes since boot". Counting
	// before the call can still throw makes a publish that put nothing on any
	// wire drift a public metric upward, and only ever on the app's own bug -
	// the hardest kind of drift to notice. Each lane has TWO throw sites: the
	// seq stamp, and the envelope build for a payload JSON cannot carry. All
	// three members are pinned because they reached the ordering separately.
	setServer(fakeServer());
	const statefulCodec = { capability: CAP, schemaVersion: 2, encode: () => null, state: {} };
	try {
		const before = platform.publishCount;
		// Refused on the seq.
		assert.throws(() => platform.publish('room', 'said', { x: 1 }, { seq: 0 }), TypeError);
		assert.throws(
			() => platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { seq: -1 }),
			TypeError
		);
		assert.throws(
			() =>
				platform.publishWireBatch('room', 'moved', [{ data: { x: 1 }, seq: 1.5 }], statefulCodec),
			TypeError
		);
		// Refused on the payload instead, which throws LATER - past the point all
		// three of these used to count at, so the seq cases alone would not have
		// pinned the ordering that matters here.
		assert.throws(() => platform.publish('room', 'said', { n: 1n }), TypeError);
		assert.throws(
			() => platform.publishWire('room', 'moved', { n: 1n }, statelessCodec()),
			TypeError
		);
		assert.throws(
			() => platform.publishWireBatch('room', 'moved', [{ data: { n: 1n } }], statefulCodec),
			TypeError
		);
		assert.equal(platform.publishCount, before, 'not one refused publish was counted');
		// One control PER LANE. With a single control, deleting any one of the
		// three increments leaves every assertion above passing while that lane
		// silently stops counting - the dead-assertion shape this suite exists to
		// avoid. The batch control also pins that it counts per entry, not per
		// call.
		platform.publish('room', 'said', { x: 1 }, { seq: 5 });
		assert.equal(platform.publishCount, before + 1, 'publish counts the one it made');
		platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { seq: 6 });
		assert.equal(platform.publishCount, before + 2, 'publishWire counts the one it made');
		platform.publishWireBatch(
			'room',
			'moved',
			[{ data: { x: 1 }, seq: 7 }, { data: { x: 2 }, seq: 8 }],
			statefulCodec
		);
		assert.equal(platform.publishCount, before + 4, 'publishWireBatch counts one per entry');
	} finally {
		maxAuthoritativeSeq.clear();
		topicSeqs.clear();
	}
});

test('excludeWs walks and skips exactly that socket', () => {
	setServer(fakeServer());
	const author = fakeWs({ topics: ['room'], caps: [CAP] });
	const other = fakeWs({ topics: ['room'] });
	withConnections([author, other], () => {
		platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { excludeWs: author });
		assert.equal(author.sent.length, 0, 'the author never sees its own frame');
		assert.equal(other.sent.length, 1);
	});
});

test('a stateful codec encodes per capable connection and degrades on drop', () => {
	setServer(fakeServer());
	let attaches = 0;
	const wire = {
		capability: CAP,
		schemaVersion: 3,
		encode: (event, data, state) => new Uint8Array([state.n]),
		state: {
			onAttach: () => ({ n: ++attaches }),
			onDetach: () => {}
		}
	};
	const a = fakeWs({ topics: ['room'], caps: [CAP] });
	// b's announce lands (1) but its frame drops (2): poison.
	const b = fakeWs({ topics: ['room'], caps: [CAP], script: [1, 2] });
	withConnections([a, b], () => {
		platform.publishWire('room', 'moved', { x: 1 }, wire);
		assert.equal(attaches, 2, 'one state per connection');
		const frameA = parseBinaryFrame(a.sent[1].payload);
		const frameB = parseBinaryFrame(b.sent[1].payload);
		assert.notDeepEqual([...frameA.payload], [...frameB.payload], 'per-connection payloads');
		assert.equal(wireStatePoisoned(b.ud, CAP), true, 'the dropped stateful frame poisoned b');
		assert.equal(wireStatePoisoned(a.ud, CAP), false);
		// The next publish serves b the envelope.
		platform.publishWire('room', 'moved', { x: 2 }, wire);
		assert.equal(typeof b.sent.at(-1).payload, 'string');
		assert.ok(parseBinaryFrame(a.sent.at(-1).payload), 'a stays binary');
	});
});

test('a declined stateless frame with exclusion is a per-subscriber JSON walk', () => {
	const server = fakeServer();
	setServer(server);
	const author = fakeWs({ topics: ['room'], caps: [CAP] });
	const other = fakeWs({ topics: ['room'] });
	withConnections([author, other], () => {
		// data == null makes the codec decline.
		const ok = platform.publishWire('room', 'gone', null, statelessCodec(), { excludeWs: author });
		assert.equal(ok, true);
		assert.equal(server.published.length, 0, 'no native fan-out with an exclusion');
		assert.equal(author.sent.length, 0);
		assert.equal(other.sent.length, 1);
		assert.equal(typeof other.sent[0].payload, 'string');
	});
});

test('a shared codec publishes once per cohort, not once per connection', () => {
	const server = fakeServer();
	setServer(server);
	const wire = statelessCodec({ shared: true });
	const capable = fakeWs({ topics: ['world'], caps: [CAP] });
	const jsonOnly = fakeWs({ topics: ['world'] });
	withConnections([capable, jsonOnly], () => {
		const ok = platform.publishWire('world', 'tick', { t: 1 }, wire, { seq: true });
		assert.equal(ok, true);
		// The first shared publish migrated both subscribers into cohorts.
		assert.ok(capable.nativeSubs.has('world\0bin'), 'capable joined the binary cohort');
		assert.ok(jsonOnly.nativeSubs.has('world\0json'), 'JSON-only joined the JSON cohort');
		assert.equal(sharedTopics.get('world'), CAP);
		// The capable connection was announced the SHARED id.
		const announce = JSON.parse(capable.sent[0].payload);
		assert.equal(announce.type, 'wire-id');
		assert.ok(announce.id >= SHARED_WIRE_ID_BASE, 'server-wide id space');
		// Two native publishes: the 0x03 frame to \0bin, the envelope to \0json.
		assert.equal(server.published.length, 2);
		const bin = server.published.find((p) => p.topic === 'world\0bin');
		const json = server.published.find((p) => p.topic === 'world\0json');
		assert.ok(bin && json);
		const frame = parseBinaryFrame(bin.payload);
		assert.equal(frame.topicId, announce.id);
		assert.equal(frame.seq, JSON.parse(json.payload).seq, 'one seq on both cohort forms');
	});
});

test('a shared topic with no binary cohort skips the binary fan-out', () => {
	const server = fakeServer();
	setServer(server);
	// A capable connection must exist SOMEWHERE (or the JSON fast path never
	// reaches the shared branch at all) - but not on this topic, so the
	// binary cohort stays empty and only the JSON cohort is published.
	const capableElsewhere = fakeWs({ topics: ['other'], caps: [CAP] });
	const jsonOnly = fakeWs({ topics: ['world'] });
	withConnections([capableElsewhere, jsonOnly], () => {
		platform.publishWire('world', 'tick', { t: 1 }, statelessCodec({ shared: true }));
		assert.equal(server.published.length, 1, 'only the JSON cohort published');
		assert.equal(server.published[0].topic, 'world\0json');
		assert.ok(jsonOnly.nativeSubs.has('world\0json'));
	});
});

test('leaving a shared cohort releases the wire-id ref; the last leave retires it', () => {
	setServer(fakeServer());
	const a = fakeWs({ topics: ['world'], caps: [CAP] });
	const b = fakeWs({ topics: ['world'], caps: [CAP] });
	withConnections([a, b], () => {
		platform.publishWire('world', 'tick', { t: 1 }, statelessCodec({ shared: true }));
		const id = getSharedWireId('world');
		assert.ok(id !== undefined);
		leaveSharedCohort(a, a.ud, 'world');
		assert.ok(!a.nativeSubs.has('world\0bin'), 'a left its cohort');
		assert.equal(getSharedWireId('world'), id, 'b still holds the ref');
		leaveSharedCohort(b, b.ud, 'world');
		assert.equal(getSharedWireId('world'), undefined, 'last ref retired the id');
	});
});

test('publishWireBatch sends one batch frame per capable connection', () => {
	setServer(fakeServer());
	const encoded = [];
	const wire = {
		capability: CAP,
		schemaVersion: 3,
		encode: (event, data, state) => {
			encoded.push(event);
			return new Uint8Array([1]);
		},
		state: { onAttach: () => ({}) }
	};
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	const jsonOnly = fakeWs({ topics: ['room'] });
	withConnections([capable, jsonOnly], () => {
		const ok = platform.publishWireBatch(
			'room',
			'moved',
			[{ data: { x: 1 } }, { data: { x: 2 } }],
			wire,
			{ seq: true }
		);
		assert.equal(ok, true);
		assert.deepEqual(encoded, ['moved-batch'], 'one batch encode, not two');
		// Capable: announce + ONE frame whose header seq is the LAST entry's.
		assert.equal(capable.sent.length, 2);
		const frame = parseBinaryFrame(capable.sent[1].payload);
		assert.equal(frame.seq, 2);
		// JSON-only: one envelope per entry, each with its own seq.
		assert.equal(jsonOnly.sent.length, 2);
		assert.equal(JSON.parse(jsonOnly.sent[0].payload).seq, 1);
		assert.equal(JSON.parse(jsonOnly.sent[1].payload).seq, 2);
	});
});

test('a per-entry excludeWs withholds exactly that entry from that socket', () => {
	setServer(fakeServer());
	const author = fakeWs({ topics: ['room'] });
	const other = fakeWs({ topics: ['room'] });
	const wire = {
		capability: CAP,
		schemaVersion: 3,
		encode: () => new Uint8Array([1]),
		state: { onAttach: () => ({}) }
	};
	withConnections([author, other], () => {
		platform.publishWireBatch(
			'room',
			'moved',
			[{ data: { x: 1 }, excludeWs: author }, { data: { x: 2 } }],
			wire
		);
		// Neither has caps, so both receive JSON - but the author only entry 2.
		assert.equal(author.sent.length, 1);
		assert.deepEqual(JSON.parse(author.sent[0].payload).data, { x: 2 });
		assert.equal(other.sent.length, 2);
	});
});

test('a stateless batch routes through publishWire per entry', () => {
	const server = fakeServer();
	setServer(server);
	const jsonOnly = fakeWs({ topics: ['room'] });
	withConnections([jsonOnly], () => {
		const ok = platform.publishWireBatch(
			'room',
			'moved',
			[{ data: { x: 1 } }, { data: { x: 2 } }],
			statelessCodec()
		);
		assert.equal(ok, true);
		// No capable connection: each entry took the fast path.
		assert.equal(server.published.length, 2);
	});
});

test('an empty batch publishes nothing and reports false', () => {
	const server = fakeServer();
	setServer(server);
	assert.equal(platform.publishWireBatch('room', 'moved', [], statelessCodec()), false);
	assert.equal(server.published.length, 0);
});

test('publishWire reports false when the walk reaches no recipient', () => {
	setServer(fakeServer());
	// A capable connection exists (so the walk runs) but subscribes elsewhere,
	// so this topic has zero recipients - the return must say so, like publish.
	const capableElsewhere = fakeWs({ topics: ['other'], caps: [CAP] });
	withConnections([capableElsewhere], () => {
		const ok = platform.publishWire('room', 'moved', { x: 1 }, statelessCodec());
		assert.equal(ok, false, 'no subscriber on the topic -> false');
	});
});

test('publishWire reports true when a subscriber actually receives it', () => {
	setServer(fakeServer());
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	withConnections([capable], () => {
		assert.equal(platform.publishWire('room', 'moved', { x: 1 }, statelessCodec()), true);
	});
});

test('publishWireBatch reports false when its walk reaches no recipient', () => {
	setServer(fakeServer());
	// A capable connection exists (so the stateful walk runs rather than the
	// fast path) but subscribes elsewhere: nothing is delivered, and the
	// return must say so - the twin of the publishWire case.
	const capableElsewhere = fakeWs({ topics: ['other'], caps: [CAP] });
	const wire = {
		capability: CAP,
		schemaVersion: 3,
		encode: () => new Uint8Array([1]),
		state: { onAttach: () => ({}) }
	};
	withConnections([capableElsewhere], () => {
		const ok = platform.publishWireBatch('room', 'moved', [{ data: { x: 1 } }], wire);
		assert.equal(ok, false, 'no subscriber on the topic -> false');
	});
});

test('publishWireBatch reports true once a subscriber receives it', () => {
	setServer(fakeServer());
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	const wire = {
		capability: CAP,
		schemaVersion: 3,
		encode: () => new Uint8Array([1]),
		state: { onAttach: () => ({}) }
	};
	withConnections([capable], () => {
		assert.equal(
			platform.publishWireBatch('room', 'moved', [{ data: { x: 1 } }], wire),
			true
		);
	});
});

test('a declined batch that falls back to JSON still reports delivery', () => {
	setServer(fakeServer());
	// The per-entry fallback path sends envelopes directly; it must count as
	// delivery, or the return under-reports frames the client actually got.
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	const wire = {
		capability: CAP,
		schemaVersion: 3,
		// Declines both the batch form and every entry -> pure JSON fallback.
		encode: () => null,
		state: { onAttach: () => ({}) }
	};
	withConnections([capable], () => {
		const ok = platform.publishWireBatch('room', 'moved', [{ data: { x: 1 } }], wire);
		assert.equal(ok, true, 'JSON envelopes are delivery too');
		assert.ok(capable.sent.some((s) => typeof s.payload === 'string'));
	});
});

test('a declined batch with exclusion stamps each frame with ITS OWN seq', () => {
	// The subset a socket receives is filtered by excludeWs; the seq list must
	// be filtered with it. Indexing the unfiltered seqs with a subset index
	// stamps one entry's payload with another entry's seq, and the client then
	// records a watermark that never matches the frame it holds.
	setServer(fakeServer());
	const author = fakeWs({ topics: ['room'] });
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	const wire = {
		capability: CAP,
		schemaVersion: 3,
		// Declines the batch form, encodes per entry - the lane under test.
		encode: (event, data) => (event.endsWith('-batch') ? null : new Uint8Array([data.x])),
		state: { onAttach: () => ({}) }
	};
	withConnections([author, capable], () => {
		platform.publishWireBatch(
			'room',
			'moved',
			[{ data: { x: 1 } }, { data: { x: 2 }, excludeWs: capable }, { data: { x: 3 } }],
			wire,
			{ seq: true }
		);
		// `capable` is excluded from the MIDDLE entry, so its subset is entries 1
		// and 3 - seqs 1 and 3. Indexing the unfiltered seq array with the subset
		// index stamps them 1 and 2, so the first frame still looks right and only
		// the second is wrong. Excluding the FIRST entry instead would leave a
		// single surviving frame and a weaker assertion.
		const frames = capable.sent.map((s) => parseBinaryFrame(s.payload)).filter(Boolean);
		assert.equal(frames.length, 2, 'the two non-excluded entries');
		assert.deepEqual([...frames[0].payload], [1], 'entry 1 payload');
		assert.equal(frames[0].seq, 1, 'entry 1 seq');
		assert.deepEqual([...frames[1].payload], [3], 'entry 3 payload');
		assert.equal(frames[1].seq, 3, 'entry 3 seq, not entry 2 seq');
	});
});

test('a declined batch with no exclusion stamps every frame from the shared list', () => {
	// The no-exclusion common case reuses the unfiltered arrays rather than
	// building a subset. Nothing else in this lane covers that default: if it
	// were wrong, every frame would ship the wire's no-seq sentinel and only the
	// live wire lane would notice.
	setServer(fakeServer());
	const capable = fakeWs({ topics: ['room'], caps: [CAP] });
	const wire = {
		capability: CAP,
		schemaVersion: 3,
		encode: (event, data) => (event.endsWith('-batch') ? null : new Uint8Array([data.x])),
		state: { onAttach: () => ({}) }
	};
	withConnections([capable], () => {
		platform.publishWireBatch(
			'room',
			'moved',
			[{ data: { x: 1 } }, { data: { x: 2 } }],
			wire,
			{ seq: true }
		);
		const frames = capable.sent.map((s) => parseBinaryFrame(s.payload)).filter(Boolean);
		assert.equal(frames.length, 2, 'both entries');
		assert.equal(frames[0].seq, 1, 'entry 1 seq');
		assert.equal(frames[1].seq, 2, 'entry 2 seq');
	});
});

test('a fan-out that only drops frames reports no delivery', () => {
	// A declining stateless codec with an exclusion takes publishWire's
	// per-subscriber JSON walk; a subscriber whose send is refused past the
	// backpressure limit received nothing, so the call delivered nothing.
	setServer(fakeServer());
	const author = fakeWs({ topics: ['room'], caps: [CAP] });
	const dropping = fakeWs({ topics: ['room'], script: [2] });
	withConnections([author, dropping], () => {
		const ok = platform.publishWire('room', 'gone', null, statelessCodec(), {
			excludeWs: author
		});
		assert.equal(ok, false, 'every send dropped -> false');
		// Without this the test also passes when the walk never reaches the
		// socket at all - an inverted subscription check would read as success.
		assert.equal(dropping.sent.length, 1, 'the subscriber was actually visited');
	});
});

test('a fan-out where one send drops and another lands still reports delivery', () => {
	// The mirror of the all-dropped case: delivery is per call, not per socket,
	// so one subscriber that received the frame makes the call a delivery.
	setServer(fakeServer());
	const author = fakeWs({ topics: ['room'], caps: [CAP] });
	const dropping = fakeWs({ topics: ['room'], script: [2] });
	const landing = fakeWs({ topics: ['room'] });
	withConnections([author, dropping, landing], () => {
		const ok = platform.publishWire('room', 'gone', null, statelessCodec(), {
			excludeWs: author
		});
		assert.equal(ok, true, 'one delivered subscriber is delivery');
		assert.equal(dropping.sent.length, 1);
		assert.equal(landing.sent.length, 1);
	});
});

test('a nullish wire falls back to a plain publish rather than crashing', () => {
	const server = fakeServer();
	setServer(server);
	const jsonOnly = fakeWs({ topics: ['room'] });
	withConnections([jsonOnly], () => {
		assert.doesNotThrow(() => platform.publishWire('room', 'moved', { x: 1 }, null));
		assert.doesNotThrow(() => platform.publishWireBatch('room', 'moved', [{ data: { x: 1 } }], null));
		assert.ok(server.published.length >= 1, 'the plain publish still fanned out');
		assert.equal(JSON.parse(server.published[0].payload).topic, 'room');
	});
});
