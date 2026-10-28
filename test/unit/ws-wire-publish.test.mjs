import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

// The binary fan-out members: capable subscribers get the 0x03 frame, everyone
// else the exact publish() envelope with the SAME seq, the fast path never
// walks, and the shared tier splits into cohort topics. Fake facades are
// injected into the live-connection registry - the platform walks JS-visible
// facades, which is what makes the scripted-send technique work.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';


const { platform } = await import('../../src/runtime/handler/platform.js');
const { WS_CAPS, WS_PLATFORM, WS_SHARED_COHORTS, WS_SUBSCRIPTIONS, capCounts, maxAuthoritativeSeq, sharedTopics, setServer, topicSeqs, wsConnections, wsCounters } =
	await import('../../src/runtime/handler/ws-state.js');
const { trackedSubscribe, trackedUnsubscribe } = await import('../../src/runtime/utils/ws-symbols.js');
const { wireStatePoisoned } = await import('../../src/runtime/handler/wire-state.js');
const { deliveryAuthorization } = await import('../../src/runtime/handler/delivery-authorization.js');
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
				(err) => err instanceof TypeError && /positive integer number or bigint/.test(err.message),
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

// Every production broadcast encode site must expose codec failures to its
// caller before announcing a wire id or sending a fallback for that encode.
for (const lane of ['stateless', 'stateless-batch', 'stateful-shared', 'stateful', 'batch', 'per-entry']) {
	function setupBroadcast(encode, onDetach = () => {}) {
		const wire = statelessCodec({ encode });
		if (!lane.startsWith('stateless')) {
			wire.state = { onAttach: () => lane === 'stateful-shared' ? null : {}, onDetach };
		}
		const publish = () => lane.includes('batch') || lane === 'per-entry'
			? platform.publishWireBatch('room', 'moved', [{ data: 1 }, { data: 2 }], wire)
			: platform.publishWire('room', 'moved', 1, wire);
		return publish;
	}

	test(`${lane} broadcast propagates codec exceptions without sending or poisoning`, () => {
		const server = fakeServer();
		setServer(server);
		const capable = fakeWs({ topics: ['room'], caps: [CAP] });
		const later = fakeWs({ topics: ['room'], caps: [CAP] });
		const failure = new Error('codec failure');
		let fail = true;
		let detached = 0;
		const publish = setupBroadcast((event) => {
			if (lane === 'per-entry' && event.endsWith('-batch')) return null;
			if (fail) throw failure;
			return new Uint8Array([4, 2]);
		}, () => detached++);
		withConnections([capable, later], () => {
			assert.throws(publish, (error) => error === failure);
			assert.equal(capable.sent.length, 0, 'no announcement or JSON substitution');
			assert.equal(later.sent.length, 0, 'the failed broadcast stops its walk');
			assert.equal(server.published.length, 0);
			assert.equal(wireStatePoisoned(capable.ud, CAP), false);
			assert.equal(detached, 0);
			fail = false;
			assert.equal(publish(), true);
			assert.ok(capable.sent.some((frame) => frame.payload instanceof Uint8Array));
		});
	});

	test(`${lane} broadcast rejects invalid payloads before announcing or sending`, () => {
		for (const value of [{}, 'bytes', Promise.resolve(new Uint8Array([1])), new Uint16Array([1]), new ArrayBuffer(1)]) {
			const server = fakeServer();
			setServer(server);
			const capable = fakeWs({ topics: ['room'], caps: [CAP] });
			const publish = setupBroadcast((event) => lane === 'per-entry' && event.endsWith('-batch') ? null : value);
			withConnections([capable], () => {
				assert.throws(publish, { name: 'TypeError', message: 'wire.encode must return Uint8Array or null' });
				assert.equal(capable.sent.length, 0);
				assert.equal(server.published.length, 0);
				assert.equal(wireStatePoisoned(capable.ud, CAP), false);
			});
		}
	});

	test(`${lane} broadcast accepts Uint8Array payloads from another realm`, () => {
		setServer(fakeServer());
		const capable = fakeWs({ topics: ['room'], caps: [CAP] });
		const payload = runInNewContext('new Uint8Array([4, 2])');
		assert.equal(payload instanceof Uint8Array, false);
		const publish = setupBroadcast((event) => lane === 'per-entry' && event.endsWith('-batch') ? null : payload);
		withConnections([capable], () => {
			assert.equal(publish(), true);
			const binary = capable.sent.filter((frame) => frame.isBinary);
			assert.equal(binary.length, lane === 'per-entry' || lane === 'stateless-batch' ? 2 : 1);
			for (const frame of binary) assert.deepEqual([...parseBinaryFrame(frame.payload).payload], [4, 2]);
			assert.equal(wireStatePoisoned(capable.ud, CAP), false);
		});
	});
}

test('directed single and batch sends propagate codec exceptions without poisoning', () => {
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
		assert.throws(() => platform.sendWire(capable, 'room', 'snapshot', { x: 1 }, wire), /encode died/);
		assert.equal(wireStatePoisoned(capable.ud, CAP), false, 'sendWire leaves recovery to the caller');
		fail = false;
		capable.sent.length = 0;
		platform.sendWire(capable, 'room', 'snapshot', { x: 2 }, wire);
		assert.ok(
			capable.sent.some((s) => s.payload instanceof Uint8Array),
			'the next successful encode remains binary'
		);

		const capable2 = fakeWs({ topics: ['room'], caps: [CAP] });
		const wire2 = {
			capability: CAP,
			schemaVersion: 2,
			state: { onAttach: () => ({}) },
			encode: (event) => {
				if (event === 'snap-batch') throw new Error('batch encode died');
				return new Uint8Array([4, 2]);
			}
		};
		assert.throws(
			() => platform.sendWireBatch(capable2, 'room', 'snap', [{ data: { x: 1 } }, { data: { x: 2 } }], wire2),
			/batch encode died/
		);
		assert.equal(
			wireStatePoisoned(capable2.ud, CAP),
			false,
			'sendWireBatch leaves recovery to the caller'
		);
		assert.equal(capable2.sent.length, 0, 'a failed batch encode sends no envelopes');
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
			const before = wsCounters.publishCount;
			withConnections([capable], () => {
				assert.throws(run, TypeError, lane);
			});
			assert.equal(maxAuthoritativeSeq.get('room'), undefined, lane + ': marked nothing');
			assert.equal(wsCounters.publishCount, before, lane + ': counted nothing');
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

test('serialization failures leave the counter untouched while reentrant publishes keep their sequence', () => {
	const server = fakeServer();
	setServer(server);
	try {
		platform.publish('room', 'said', { x: 1 }, { seq: true });
		assert.equal(topicSeqs.get('room'), 1);
		assert.throws(() => platform.publish('room', 'said', { n: 1n }, { seq: true }), TypeError);
		assert.equal(topicSeqs.get('room'), 1, 'serialization precedes the counter draw');
		platform.publish('room', 'said', { toJSON() {
			platform.publish('room', 'nested', 'inner', { seq: true });
			return 'outer';
		} }, { seq: true });
		assert.equal(topicSeqs.get('room'), 3);
		assert.throws(() => platform.publish('room', 'said', { toJSON() {
			platform.publish('room', 'nested', 'before failure', { seq: true });
			throw new Error('serialization failed');
		} }, { seq: true }), /serialization failed/);
		assert.equal(topicSeqs.get('room'), 4, 'a failed outer value does not rewind a delivered nested frame');
		platform.publish('room', 'said', 'after failure', { seq: true });
		const delivered = server.published.map(({ payload }) => JSON.parse(payload));
		assert.deepEqual(delivered.map(({ seq }) => seq), [1, 2, 3, 4, 5]);
		assert.deepEqual(delivered.map(({ data }) => data), [{ x: 1 }, 'inner', 'outer', 'before failure', 'after failure']);
		assert.equal(maxAuthoritativeSeq.get('room'), undefined);
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
		const before = wsCounters.publishCount;
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
		assert.equal(wsCounters.publishCount, before + 1, 'and its count');
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
		const before = wsCounters.publishCount;
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
		assert.equal(wsCounters.publishCount, before, 'not one refused publish was counted');
		// One control PER LANE. With a single control, deleting any one of the
		// three increments leaves every assertion above passing while that lane
		// silently stops counting - the dead-assertion shape this suite exists to
		// avoid. The batch control also pins that it counts per entry, not per
		// call.
		platform.publish('room', 'said', { x: 1 }, { seq: 5 });
		assert.equal(wsCounters.publishCount, before + 1, 'publish counts the one it made');
		platform.publishWire('room', 'moved', { x: 1 }, statelessCodec(), { seq: 6 });
		assert.equal(wsCounters.publishCount, before + 2, 'publishWire counts the one it made');
		platform.publishWireBatch(
			'room',
			'moved',
			[{ data: { x: 1 }, seq: 7 }, { data: { x: 2 }, seq: 8 }],
			statefulCodec
		);
		assert.equal(wsCounters.publishCount, before + 4, 'publishWireBatch counts one per entry');
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

for (const armed of [false, true]) for (const dropped of ['announce', 'frame']) {
	test(`a declined stateful batch preserves its JSON suffix after ${dropped} drop (${armed ? 'armed' : 'unarmed'})`, () => {
		setServer(fakeServer());
		const capable = fakeWs({ topics: ['room'], caps: [CAP], script: dropped === 'announce' ? [2, 1, 1, 1] : [1, 2, 1, 1] });
		const peer = fakeWs({ topics: ['room'] });
		for (const ws of [capable, peer]) ws.getBufferedAmount = () => 0;
		const seen = new Map();
		if (armed) platform.authorizeDelivery((_ws, context) => {
			if (!context.binary) {
				const key = context.data.x;
				if (seen.has(key)) assert.equal(context, seen.get(key), 'suffix preserves the per-entry shared parse cache');
				else seen.set(key, context);
			}
			return true;
		});
		const wire = { capability: CAP, schemaVersion: 1, state: { onAttach: () => ({}) },
			encode: (event, data) => event.endsWith('-batch') ? null : new Uint8Array([data.x]) };
		try {
			withConnections([capable, peer], () => {
				const before = wsCounters.closedWsAborts;
				assert.equal(platform.publishWireBatch('room', 'value', [1, 2, 3].map(x => ({ data: { x } })), wire), true);
				const json = capable.sent.filter(frame => typeof frame.payload === 'string').map(frame => JSON.parse(frame.payload)).filter(frame => !frame.type);
				assert.deepEqual(json.map(frame => frame.data.x), dropped === 'announce' ? [1, 2, 3] : [2, 3]);
				assert.equal(wireStatePoisoned(capable.ud, CAP), true);
				assert.equal(wsCounters.closedWsAborts, before, 'a dropped frame must not become a caught indexing exception');
			});
		} finally { deliveryAuthorization.reset(); }
	});
}

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

// A CALL-LEVEL EXCLUSION, WHICH ONLY ONE LANE USED TO HONOUR. The stateless
// reroute forwards the call options to publishWire per entry, which reads
// excludeWs; the stateful lane read the per-entry field alone. So the same call
// excluded the author through a stateless codec and delivered to it through a
// stateful one - and adding `state` to a codec is the documented way to opt
// into batch framing, so an app could lose its exclusion by upgrading a codec
// it had already got working, with no error and no log.

test('a call-level excludeWs withholds the whole batch on the stateful lane', () => {
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
			[{ data: { x: 1 } }, { data: { x: 2 } }],
			wire,
			{ excludeWs: author }
		);
		assert.equal(author.sent.length, 0, 'every entry withheld');
		assert.equal(other.sent.length, 2);
	});
});

test('the stateless lane answers the identical call identically', () => {
	setServer(fakeServer());
	const author = fakeWs({ topics: ['room'] });
	const other = fakeWs({ topics: ['room'] });
	withConnections([author, other], () => {
		platform.publishWireBatch(
			'room',
			'moved',
			[{ data: { x: 1 } }, { data: { x: 2 } }],
			statelessCodec(),
			{ excludeWs: author }
		);
		assert.equal(author.sent.length, 0, 'the two lanes agree now');
		assert.equal(other.sent.length, 2);
	});
});

test('an entry excludeWs overrides the call-level one; null inherits it', () => {
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
			[
				{ data: { x: 1 } },
				{ data: { x: 2 }, excludeWs: null },
				{ data: { x: 3 }, excludeWs: other }
			],
			wire,
			{ excludeWs: author }
		);
		// Entry 2's null is ABSENT, so it inherits the call-level exclusion
		// exactly as entry 1 does - reading it as "opt back in" would give
		// `excludeWs: null` a meaning it has nowhere else in the family. Entry 3
		// names someone else, which REPLACES the call-level exclusion for that
		// entry rather than adding to it, so the author receives it.
		assert.deepEqual(
			author.sent.map((s) => JSON.parse(s.payload).data),
			[{ x: 3 }]
		);
		assert.deepEqual(
			other.sent.map((s) => JSON.parse(s.payload).data),
			[{ x: 1 }, { x: 2 }]
		);
	});
});

test('the pre-pass reads each entry accessor exactly once', () => {
	// The records exist so that what the batch publishes is what the call was
	// handed. A getter read twice defeats that on its own: it can answer
	// "defined" to the presence test and something else to the value read, so
	// delivery, the recipient discount and the resume capture end up disagreeing
	// about who was excluded.
	setServer(fakeServer());
	const author = fakeWs({ topics: ['room'] });
	const other = fakeWs({ topics: ['room'] });
	const reads = { excludeWs: 0, data: 0, seq: 0 };
	let flip = 0;
	const hostile = {
		get excludeWs() {
			reads.excludeWs++;
			// Defined on the first read, a different socket on the next.
			return flip++ === 0 ? other : author;
		},
		get data() { reads.data++; return { x: 1 }; },
		get seq() { reads.seq++; return undefined; }
	};
	withConnections([author, other], () => {
		platform.publishWireBatch('room', 'moved', [hostile], {
			capability: CAP,
			schemaVersion: 3,
			encode: () => new Uint8Array([1]),
			state: { onAttach: () => ({}) }
		}, {});
	});
	assert.equal(reads.excludeWs, 1, 'the exclusion accessor ran once');
	assert.equal(reads.data, 1, 'so did the payload accessor');
	assert.equal(reads.seq, 1, 'and the seq accessor');
	// The first read is the one that counts, everywhere: `other` was excluded,
	// so it received nothing and the author received the entry.
	assert.equal(other.sent.length, 0, 'the socket named by the first read is the excluded one');
	assert.equal(author.sent.length, 1);
});

// - tracked membership on a shared topic --------------------------------------
// A plugin joins and leaves through trackedSubscribe / trackedUnsubscribe, which
// find this server's cohort registry through the slots on the connection's own
// platform clone.

/** A fake facade whose userData carries a platform clone, as open makes it. */
function trackedWs(opts) {
	const ws = fakeWs(opts);
	ws.ud[WS_PLATFORM] = Object.create(platform);
	return ws;
}

test('a tracked join of a shared topic enters the binary cohort and is announced once', () => {
	const server = fakeServer();
	setServer(server);
	const capable = trackedWs({ caps: [CAP] });
	const member = fakeWs({ topics: ['world'], caps: [CAP] });
	withConnections([capable, member], () => {
		// Shared before the tracked join: the join must enter the cohort itself.
		platform.publishWire('world', 'tick', { t: 0 }, statelessCodec({ shared: true }));
		const id = getSharedWireId('world');
		assert.ok(id !== undefined && id >= SHARED_WIRE_ID_BASE);

		assert.equal(trackedSubscribe(capable, 'world'), true);
		assert.ok(capable.nativeSubs.has('world'), 'the logical topic');
		assert.ok(capable.nativeSubs.has('world\0bin'), 'and the binary cohort');
		assert.ok(!capable.nativeSubs.has('world\0json'));
		assert.ok(capable.ud[WS_SHARED_COHORTS].has('world'));
		assert.deepEqual(JSON.parse(capable.sent[0].payload), { type: 'wire-id', topic: 'world', id });

		assert.equal(trackedSubscribe(capable, 'world'), true);
		assert.equal(capable.sent.length, 1, 'a second join of the held topic announces nothing');

		server.published.length = 0;
		platform.publishWire('world', 'tick', { t: 1 }, statelessCodec({ shared: true }));
		assert.ok(server.published.some((p) => p.topic === 'world\0bin'), 'the binary cohort is published to');
		assert.ok(!server.published.some((p) => p.topic === 'world'), 'not the logical topic: no per-member walk either');
		assert.equal(capable.sent.length, 1, 'and nothing per connection');

		// The leave takes it out of both cohorts and gives its reference back.
		assert.equal(trackedUnsubscribe(capable, 'world'), true);
		assert.ok(!capable.nativeSubs.has('world'));
		assert.ok(!capable.nativeSubs.has('world\0bin'));
		assert.ok(!capable.ud[WS_SHARED_COHORTS].has('world'));
		assert.equal(getSharedWireId('world'), id, 'the other member still holds the id');
		leaveSharedCohort(member, member.ud, 'world');
		assert.equal(getSharedWireId('world'), undefined, 'the last reference retired it');
	});
});

test('a tracked join of a shared topic from a JSON-only connection enters the JSON cohort', () => {
	setServer(fakeServer());
	const jsonOnly = trackedWs();
	const member = fakeWs({ topics: ['world'], caps: [CAP] });
	withConnections([jsonOnly, member], () => {
		platform.publishWire('world', 'tick', { t: 0 }, statelessCodec({ shared: true }));
		assert.equal(trackedSubscribe(jsonOnly, 'world'), true);
		assert.ok(jsonOnly.nativeSubs.has('world\0json'));
		assert.ok(!jsonOnly.nativeSubs.has('world\0bin'));
		assert.equal(jsonOnly.sent.length, 0, 'nothing to announce to a JSON-only client');
		trackedUnsubscribe(jsonOnly, 'world');
		assert.ok(!jsonOnly.nativeSubs.has('world\0json'));
	});
});

test('a tracked join of a topic that is not shared enters no cohort', () => {
	setServer(fakeServer());
	const capable = trackedWs({ caps: [CAP] });
	withConnections([capable], () => {
		assert.equal(trackedSubscribe(capable, 'plain'), true);
		assert.deepEqual([...capable.nativeSubs], ['plain']);
		assert.equal(capable.ud[WS_SHARED_COHORTS], undefined);
		assert.equal(capable.sent.length, 0);
	});
});
