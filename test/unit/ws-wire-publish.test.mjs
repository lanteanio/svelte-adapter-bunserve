import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The binary fan-out members: capable subscribers get the 0x03 frame, everyone
// else the exact publish() envelope with the SAME seq, the fast path never
// walks, and the shared tier splits into cohort topics. Fake facades are
// injected into the live-connection registry - the platform walks JS-visible
// facades, which is what makes the scripted-send technique work.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

register('../helpers/ws-handler-loader.mjs', import.meta.url);

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
	assert.equal(errors.length, 3, 'each bad return was reported');
	assert.ok(errors[0].includes('Return a Uint8Array'), errors[0]);
	assert.ok(errors[0].includes('object'), 'and named the type it got: ' + errors[0]);
	assert.ok(errors[1].includes('string'), 'and named the type it got: ' + errors[1]);
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
		setServer(fakeServer());
		const capable = fakeWs({ topics: ['room'], caps: [CAP] });
		try {
			const before = platform.publishCount;
			withConnections([capable], () => {
				assert.throws(run, TypeError, lane);
			});
			assert.equal(maxAuthoritativeSeq.get('room'), undefined, lane + ': marked nothing');
			assert.equal(platform.publishCount, before, lane + ': counted nothing');
			assert.equal(capable.sent.length, 0, lane + ': sent nothing');
		} finally {
			maxAuthoritativeSeq.clear();
			topicSeqs.clear();
		}
	}
});

test('the stateless batch reroute keeps what already went out, and marks no more', () => {
	// This lane is N independent publishWire calls, so it is NOT atomic and the
	// contract is deliberately different: entry 0 really was delivered, so its
	// mark and its count must STAND. What must not happen is the failing entry
	// marking a seq that never reached a socket. Pinned explicitly so the
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
						[{ data: { x: 1 }, seq: 40 }, { data: { n: 1n }, seq: 41 }],
						statelessCodec()
					),
				TypeError
			);
		});
		assert.equal(maxAuthoritativeSeq.get('room'), 40, 'the entry that DID publish kept its mark');
		assert.equal(platform.publishCount, before + 1, 'and its count');
		assert.notEqual(maxAuthoritativeSeq.get('room'), 41, 'the entry that threw marked nothing');
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
