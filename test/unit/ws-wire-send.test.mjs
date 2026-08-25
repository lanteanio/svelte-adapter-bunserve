import { test } from 'node:test';
import assert from 'node:assert/strict';

// The single-target wire senders and the per-connection codec lifecycle:
// announce-before-first-frame, caps/poison gating, degrade-to-JSON, and the
// detach sweep. Driven against fake facades whose send() returns scripted
// tri-states - the same technique the family uses, and it works here because
// the platform walks JS-visible facades.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';


const { platform } = await import('../../src/runtime/handler/platform.js');
const { WS_CAPS, WS_SUBSCRIPTIONS, wsCounters } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const { detachWireStates, ensureWireId, poisonWireState, wireStatePoisoned } = await import(
	'../../src/runtime/handler/wire-state.js'
);
const { getWireCodec, _resetWireCodecRegistry } = await import(
	'../../src/runtime/handler/codec-registry.js'
);
const { parseBinaryFrame } = await import('../../src/runtime/utils/wire.js');

/**
 * A stand-in for the socket facade. `send` returns the next scripted
 * tri-state (default 1 = sent); `detach()` makes getUserData throw the way
 * the real facade does once the connection is torn down.
 */
function fakeWs(script = []) {
	const sent = [];
	const ud = { [WS_SUBSCRIPTIONS]: new Set() };
	let detached = false;
	return {
		sent,
		ud,
		script,
		detach() {
			detached = true;
		},
		getUserData() {
			if (detached) throw new Error('detached');
			return ud;
		},
		send(payload, isBinary, compress) {
			sent.push({ payload, isBinary, compress });
			return script.length ? script.shift() : 1;
		},
		get _closed() {
			return detached;
		}
	};
}

function capable(ws, cap = 'cap:1') {
	ws.ud[WS_CAPS] = new Set([cap]);
	return ws;
}

const CAP = 'cap:1';

function statelessCodec(overrides = {}) {
	return {
		capability: CAP,
		schemaVersion: 2,
		encode: (event, data) => (data == null ? null : new Uint8Array([9, 9])),
		...overrides
	};
}

function statefulCodec(track = {}) {
	track.attached = 0;
	track.detached = 0;
	track.encoded = [];
	return {
		capability: CAP,
		schemaVersion: 3,
		encode: (event, data, state) => {
			track.encoded.push({ event, data, state });
			return data == null ? null : new Uint8Array([7]);
		},
		state: {
			onAttach: () => {
				track.attached++;
				return { dict: new Map() };
			},
			onDetach: () => {
				track.detached++;
			}
		}
	};
}

test('a caps-less connection gets the JSON envelope, not a binary frame', () => {
	const ws = fakeWs();
	const result = platform.sendWire(ws, 'room', 'moved', { x: 1 }, statelessCodec());
	assert.equal(result, 1);
	assert.equal(ws.sent.length, 1);
	assert.equal(typeof ws.sent[0].payload, 'string');
	const msg = JSON.parse(ws.sent[0].payload);
	assert.equal(msg.topic, 'room');
	assert.equal(msg.event, 'moved');
	assert.deepEqual(msg.data, { x: 1 });
});

test('a capable connection gets the announce, then the 0x03 frame, in order', () => {
	const ws = capable(fakeWs());
	const result = platform.sendWire(ws, 'room', 'moved', { x: 1 }, statelessCodec());
	assert.equal(result, 1);
	assert.equal(ws.sent.length, 2);
	const announce = JSON.parse(ws.sent[0].payload);
	assert.deepEqual(announce, { type: 'wire-id', topic: 'room', id: 1 });
	const frame = parseBinaryFrame(ws.sent[1].payload);
	assert.ok(frame, 'second send is a parseable 0x03 frame');
	assert.equal(frame.schemaVersion, 2);
	assert.equal(frame.topicId, 1);
	assert.equal(frame.seq, 0, 'sendWire stamps no seq');
	assert.deepEqual([...frame.payload], [9, 9]);
	assert.equal(ws.sent[1].isBinary, true);

	// The second frame for the same topic reuses the id with no re-announce.
	platform.sendWire(ws, 'room', 'moved', { x: 2 }, statelessCodec());
	assert.equal(ws.sent.length, 3);
	assert.ok(parseBinaryFrame(ws.sent[2].payload));
});

test('a stateful codec attaches once and its state rides every encode', () => {
	const ws = capable(fakeWs());
	const track = {};
	const wire = statefulCodec(track);
	platform.sendWire(ws, 'room', 'moved', { x: 1 }, wire);
	platform.sendWire(ws, 'room', 'moved', { x: 2 }, wire);
	assert.equal(track.attached, 1, 'onAttach ran once for two sends');
	assert.equal(track.encoded.length, 2);
	assert.equal(track.encoded[0].state, track.encoded[1].state, 'same state object');
});

test('a dropped announce poisons the capability and serves JSON from then on', () => {
	// First send (the announce) is dropped: the client can never resolve the
	// id, so binary is permanently undecodable here.
	const ws = capable(fakeWs([2]));
	const track = {};
	const wire = statefulCodec(track);
	const result = platform.sendWire(ws, 'room', 'moved', { x: 1 }, wire);
	assert.equal(typeof ws.sent[1].payload, 'string', 'the frame itself went as JSON');
	assert.equal(result, 1);
	assert.equal(wireStatePoisoned(ws.ud, CAP), true);
	assert.equal(track.detached, 1, 'poison disposed the codec state');
	// Later frames take the JSON path without touching the codec.
	platform.sendWire(ws, 'room', 'moved', { x: 2 }, wire);
	assert.equal(typeof ws.sent[2].payload, 'string');
	assert.equal(track.encoded.length, 1, 'no further encodes after poison');
});

test('a dropped STATEFUL frame poisons; a dropped stateless frame does not', () => {
	// Stateful: announce delivers (1), frame drops (2).
	const wsA = capable(fakeWs([1, 2]));
	const track = {};
	platform.sendWire(wsA, 'room', 'moved', { x: 1 }, statefulCodec(track));
	assert.equal(wireStatePoisoned(wsA.ud, CAP), true);
	assert.equal(track.detached, 1);

	// Stateless: same drop, no per-connection state to desync, no poison.
	const wsB = capable(fakeWs([1, 2]));
	const dropped = platform.sendWire(wsB, 'room', 'moved', { x: 1 }, statelessCodec());
	assert.equal(dropped, 2, 'the drop is still reported');
	assert.equal(wireStatePoisoned(wsB.ud, CAP), false);
	const again = platform.sendWire(wsB, 'room', 'moved', { x: 2 }, statelessCodec());
	assert.equal(again, 1);
	assert.ok(parseBinaryFrame(wsB.sent.at(-1).payload), 'binary resumed');
});

test('BACKPRESSURE (0) is enqueued-not-dropped and never poisons', () => {
	const ws = capable(fakeWs([1, 0]));
	const track = {};
	const result = platform.sendWire(ws, 'room', 'moved', { x: 1 }, statefulCodec(track));
	assert.equal(result, 0);
	assert.equal(wireStatePoisoned(ws.ud, CAP), false);
	assert.equal(track.detached, 0);
});

test('a codec that declines the frame falls back to the JSON envelope', () => {
	const ws = capable(fakeWs());
	// data == null makes the test codecs decline.
	const result = platform.sendWire(ws, 'room', 'gone', null, statelessCodec());
	assert.equal(result, 1);
	assert.equal(typeof ws.sent[0].payload, 'string');
	assert.equal(JSON.parse(ws.sent[0].payload).data, null);
});

test('a detached socket reports DROPPED into the closed lane', () => {
	const ws = capable(fakeWs());
	ws.detach();
	const before = wsCounters.closedWsAborts;
	const result = platform.sendWire(ws, 'room', 'moved', { x: 1 }, statelessCodec());
	assert.equal(result, 2);
	assert.equal(wsCounters.closedWsAborts, before + 1);
	assert.equal(ws.sent.length, 0, 'the transport was never touched');
});

test('sendWireBatch encodes one batch frame through the -batch form', () => {
	const ws = capable(fakeWs());
	const track = {};
	const wire = statefulCodec(track);
	const result = platform.sendWireBatch(
		ws,
		'room',
		'moved',
		[{ data: { x: 1 } }, { data: { x: 2 } }],
		wire
	);
	assert.equal(result, 1);
	assert.equal(track.encoded.length, 1);
	assert.equal(track.encoded[0].event, 'moved-batch');
	assert.deepEqual(track.encoded[0].data, { updates: [{ x: 1 }, { x: 2 }] });
	// announce + one frame, not one per entry.
	assert.equal(ws.sent.length, 2);
	const frame = parseBinaryFrame(ws.sent[1].payload);
	assert.ok(frame);
	assert.equal(frame.seq, 0);
});

test('a declined batch falls back to per-entry encodes with per-entry JSON', () => {
	const ws = capable(fakeWs());
	const track = {};
	const wire = statefulCodec(track);
	// The batch form declines (data.updates is an object, so make encode
	// decline exactly the batch event).
	wire.encode = (event, data, state) => {
		track.encoded.push({ event, data, state });
		if (event === 'moved-batch') return null;
		return data == null ? null : new Uint8Array([5]);
	};
	const result = platform.sendWireBatch(
		ws,
		'room',
		'moved',
		[{ data: { x: 1 } }, { data: null }, { data: { x: 3 } }],
		wire
	);
	assert.equal(result, 1);
	// announce + binary(1) + json(null entry) + binary(3)
	assert.equal(ws.sent.length, 4);
	assert.ok(parseBinaryFrame(ws.sent[1].payload));
	assert.equal(typeof ws.sent[2].payload, 'string');
	assert.ok(parseBinaryFrame(ws.sent[3].payload));
});

test('a STATELESS codec batches as per-entry binary, not JSON', () => {
	// A stateless codec has no -batch form, so sendWireBatch routes each entry
	// through sendWire. Dumping to JSON here would hand a capable client JSON
	// from sendWireBatch while sendWire sent it binary for the same codec.
	const ws = capable(fakeWs());
	const result = platform.sendWireBatch(
		ws,
		'room',
		'moved',
		[{ data: { x: 1 } }, { data: { x: 2 } }],
		statelessCodec()
	);
	assert.equal(result, 1);
	// announce + one binary frame per entry.
	assert.equal(ws.sent.length, 3);
	assert.equal(typeof ws.sent[0].payload, 'string', 'the announce');
	assert.ok(parseBinaryFrame(ws.sent[1].payload), 'entry 1 is binary');
	assert.ok(parseBinaryFrame(ws.sent[2].payload), 'entry 2 is binary');
});

test('a caps-less batch is N JSON envelopes; an empty batch is a 1 no-op', () => {
	const ws = fakeWs();
	const result = platform.sendWireBatch(
		ws,
		'room',
		'moved',
		[{ data: { x: 1 } }, { data: { x: 2 } }],
		statefulCodec({})
	);
	assert.equal(result, 1);
	assert.equal(ws.sent.length, 2);
	assert.ok(ws.sent.every((s) => typeof s.payload === 'string'));

	const empty = platform.sendWireBatch(fakeWs(), 'room', 'moved', [], statefulCodec({}));
	assert.equal(empty, 1);
});

test('a dropped batch frame poisons and the remaining entries arrive as JSON', () => {
	// Per-entry lane: batch declines, first entry's binary frame drops.
	const ws = capable(fakeWs([1, 2]));
	const track = {};
	const wire = statefulCodec(track);
	wire.encode = (event, data, state) => {
		track.encoded.push({ event });
		if (event === 'moved-batch') return null;
		return new Uint8Array([5]);
	};
	const result = platform.sendWireBatch(
		ws,
		'room',
		'moved',
		[{ data: { x: 1 } }, { data: { x: 2 } }],
		wire
	);
	assert.equal(result, 1);
	assert.equal(wireStatePoisoned(ws.ud, CAP), true);
	// announce(1) + dropped binary + JSON for the remaining entry.
	assert.equal(typeof ws.sent.at(-1).payload, 'string');
	assert.equal(JSON.parse(ws.sent.at(-1).payload).data.x, 2);
});

test('detachWireStates disposes each live state once and skips poison sentinels', () => {
	const ws = capable(fakeWs());
	const track = {};
	const wire = statefulCodec(track);
	platform.sendWire(ws, 'room', 'moved', { x: 1 }, wire);
	poisonWireState(ws, ws.ud, CAP);
	assert.equal(track.detached, 1, 'poison already detached it');
	detachWireStates(ws, ws.ud);
	assert.equal(track.detached, 1, 'the sentinel is skipped, not re-detached');

	// A live (never poisoned) state is detached by the sweep exactly once.
	const ws2 = capable(fakeWs());
	const track2 = {};
	platform.sendWire(ws2, 'room', 'moved', { x: 1 }, statefulCodec(track2));
	detachWireStates(ws2, ws2.ud);
	detachWireStates(ws2, ws2.ud);
	assert.equal(track2.detached, 1);
});

test('a dropped announce retires the id so a second codec re-announces', () => {
	// The id table is per-topic, shared across codecs, but poison is
	// per-capability. Codec A's announce drops (poison A -> JSON); codec B on
	// the SAME topic must then re-announce a FRESH id rather than reuse the
	// one the client never received.
	const ws = capable(fakeWs([2])); // first send (A's announce) drops
	ws.ud[WS_CAPS] = new Set(['A', 'B']);
	const codecA = { capability: 'A', schemaVersion: 1, encode: () => new Uint8Array([1]) };
	const codecB = { capability: 'B', schemaVersion: 1, encode: () => new Uint8Array([2]) };
	platform.sendWire(ws, 'room', 'e', { v: 1 }, codecA);
	assert.equal(typeof ws.sent[1].payload, 'string', 'A degraded to JSON');
	// B publishes to the same topic. It must announce (fresh id), not ship a
	// frame under the id A committed and never announced.
	ws.sent.length = 0;
	platform.sendWire(ws, 'room', 'e', { v: 2 }, codecB);
	const announce = ws.sent.find((s) => typeof s.payload === 'string' && s.payload.includes('wire-id'));
	assert.ok(announce, 'B re-announced the topic id');
	const reAnnounced = JSON.parse(announce.payload);
	assert.equal(reAnnounced.topic, 'room');
	assert.notEqual(reAnnounced.id, 1, 'the dropped id 1 is retired, not reused');
	const frame = parseBinaryFrame(ws.sent.at(-1).payload);
	assert.ok(frame, 'B shipped a binary frame');
	assert.equal(frame.topicId, reAnnounced.id, 'the frame carries the freshly announced id');
});

test('ensureWireId allocates per connection and re-announces nothing', () => {
	const ws = capable(fakeWs());
	assert.equal(ensureWireId(ws, ws.ud, 'a'), 1);
	assert.equal(ensureWireId(ws, ws.ud, 'b'), 2);
	assert.equal(ensureWireId(ws, ws.ud, 'a'), 1);
	assert.equal(ws.sent.length, 2, 'one announce per distinct topic');
});

test('the codec registry is idempotent, last-wins, and resettable', () => {
	_resetWireCodecRegistry();
	const first = { capability: 'x:1', schemaVersion: 1 };
	const second = { capability: 'x:1', schemaVersion: 2 };
	platform.registerWireCodec(first);
	platform.registerWireCodec(second);
	assert.equal(getWireCodec('x:1'), second);
	platform.registerWireCodec({ notACodec: true });
	assert.equal(getWireCodec('undefined'), null);
	_resetWireCodecRegistry();
	assert.equal(getWireCodec('x:1'), null);
});
