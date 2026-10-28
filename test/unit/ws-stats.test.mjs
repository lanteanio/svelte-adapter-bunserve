import { test } from 'node:test';
import assert from 'node:assert/strict';

// The per-connection traffic counters a close hook receives. The counters
// exist only when the app registered a close hook, and ws-stats reads that once
// at load, so the hook goes in before the module is imported.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
__setHooks({ close() {} });

const { bumpIn, bumpOut, closeHookRegistered } = await import('../../src/runtime/handler/ws-stats.js');
const { WS_CAPS, WS_STATS, WS_SUBSCRIPTIONS, capCounts, setServer, sharedTopics, topicSeqs, wsConnections, wsCounters } =
	await import('../../src/runtime/handler/ws-state.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { SEND_DROPPED } = await import('../../src/runtime/utils/send-result.js');
const { _resetSharedWireIds } = await import('../../src/runtime/utils/shared-wire-id.js');
const { ensureWireId, wireStatePoisoned } = await import('../../src/runtime/handler/wire-state.js');
const { joinSharedCohort } = await import('../../src/runtime/handler/cohort.js');

/** A socket facade with stats allocated, whose send answers from a script. */
function fakeWs(script = [], { topics = [], caps = null } = {}) {
	const sent = [];
	const ud = {
		[WS_SUBSCRIPTIONS]: new Set(topics),
		[WS_STATS]: { messagesIn: 0, messagesOut: 0, bytesIn: 0, bytesOut: 0 }
	};
	if (caps) ud[WS_CAPS] = new Set(caps);
	return {
		sent,
		ud,
		stats: ud[WS_STATS],
		getUserData: () => ud,
		send(payload, isBinary) {
			sent.push({ payload, isBinary });
			return script.length ? script.shift() : 1;
		},
		subscribe: () => true,
		unsubscribe: () => true
	};
}

test('resume replay charges the saved frame to the receiving connection', async () => {
	const { beginResumeCapture, flushResumeTopic } = await import('../../src/runtime/handler/resume-buffer.js');
	const { captureResumeFrame } = await import('../../src/runtime/handler/ws-state.js');
	const ws = fakeWs();
	const capture = beginResumeCapture(['room'], ws);
	captureResumeFrame('room', 1, 'ENV1', false, null, true);
	flushResumeTopic(capture, 'room', undefined);
	assert.deepEqual(ws.sent, [{ payload: 'ENV1', isBinary: false }]);
	assert.equal(ws.stats.messagesOut, 1);
	assert.equal(ws.stats.bytesOut, 4);
});

// UTF-16 length 13, UTF-8 length 19: the two units disagree on this one.
const GERMAN = 'Größe € 😀 ab';

test('the counters are live once a close hook is registered', () => {
	assert.equal(closeHookRegistered, true);
	assert.notEqual(GERMAN.length, Buffer.byteLength(GERMAN));
});

test('bytesOut counts a text frame in UTF-16 code units', () => {
	const ws = fakeWs();
	bumpOut(ws, 'abc');
	assert.equal(ws.stats.bytesOut, 3);
	bumpOut(ws, GERMAN);
	assert.equal(ws.stats.bytesOut, 3 + GERMAN.length);
	assert.equal(ws.stats.messagesOut, 2);
});

test('bytesOut counts a binary frame in bytes, not elements', () => {
	const ws = fakeWs();
	bumpOut(ws, new Uint8Array(5));
	bumpOut(ws, new Uint16Array(3));
	assert.equal(ws.stats.bytesOut, 5 + 6);
	assert.equal(ws.stats.messagesOut, 2);
});

test('bytesIn counts the UTF-8 bytes a peer sent in a text frame', () => {
	const ws = fakeWs();
	bumpIn(ws, GERMAN);
	assert.equal(ws.stats.bytesIn, Buffer.byteLength(GERMAN));
	bumpIn(ws, new Uint16Array(2));
	assert.equal(ws.stats.bytesIn, Buffer.byteLength(GERMAN) + 4);
	assert.equal(ws.stats.messagesIn, 2);
});

test('platform.send charges queued and written frames but excludes dropped frames', () => {
	// 0 = queued behind backpressure (it still goes out), 1 = written, 2 = dropped.
	const ws = fakeWs([0, 1, SEND_DROPPED]);
	platform.send(ws, 'room', 'msg', { text: GERMAN });
	const written = ws.sent[0].payload;
	assert.equal(typeof written, 'string');
	assert.ok(written.includes(GERMAN));
	assert.equal(ws.stats.bytesOut, written.length);
	assert.equal(ws.stats.messagesOut, 1);

	platform.send(ws, 'room', 'msg', { text: GERMAN });
	assert.equal(ws.stats.bytesOut, 2 * written.length);
	assert.equal(ws.stats.messagesOut, 2);

	assert.equal(platform.send(ws, 'room', 'msg', { text: GERMAN }), SEND_DROPPED);
	assert.equal(ws.stats.bytesOut, 2 * written.length);
	assert.equal(ws.stats.messagesOut, 2);
});

for (const method of ['sendTo', 'adviseReconnect']) {
	test(`${method} retains attempted return counts but charges only non-dropped frames`, () => {
		const targets = [fakeWs([0]), fakeWs([1]), fakeWs([SEND_DROPPED])];
		const throwing = fakeWs();
		throwing.send = () => { throw new Error('socket closed'); };
		const filtered = fakeWs();
		const filter = (data) => data !== filtered.ud;
		withConnections([...targets, throwing, filtered], () => {
			const count = method === 'sendTo'
				? platform.sendTo(filter, 'room', 'msg', { text: GERMAN })
				: platform.adviseReconnect({ windowMs: 100, close: false, filter });
			assert.equal(count, 3);
		});
		for (const [index, ws] of targets.entries()) {
			assert.equal(ws.stats.messagesOut, index === 2 ? 0 : 1);
			assert.equal(ws.stats.bytesOut, index === 2 ? 0 : ws.sent[0].payload.length);
		}
		assert.equal(throwing.stats.messagesOut, 0);
		assert.equal(throwing.stats.bytesOut, 0);
		assert.equal(filtered.sent.length, 0);
		assert.equal(filtered.stats.messagesOut, 0);
	});
}

test('a wire-id announce is charged when it is delivered, and not when it is dropped', () => {
	const delivered = fakeWs();
	assert.ok(ensureWireId(delivered, delivered.ud, 'room') > 0);
	assert.equal(delivered.stats.messagesOut, 1);
	assert.equal(delivered.stats.bytesOut, delivered.sent[0].payload.length);

	const dropped = fakeWs([SEND_DROPPED]);
	assert.equal(ensureWireId(dropped, dropped.ud, 'room'), -1);
	assert.equal(dropped.stats.messagesOut, 0);
	assert.equal(dropped.stats.bytesOut, 0);

	_resetSharedWireIds();
	const cohort = fakeWs([], { caps: ['cap:1'] });
	joinSharedCohort(cohort, cohort.ud, 'room', 'cap:1');
	assert.equal(cohort.stats.messagesOut, 1);
	assert.equal(cohort.stats.bytesOut, cohort.sent[0].payload.length);
	_resetSharedWireIds();
});

// A live topic broadcast is not charged to any subscriber, on any lane: the
// native publish never could be, and the lanes that walk subscribers themselves
// (publishWire, publishWireBatch) count the same nothing. The one frame a walk
// may still charge is the wire-id announce, a control frame like any other.

const CAP = 'cap:1';
const ROOM = 'room';

function fakeServer() {
	return { publish: (topic, payload) => payload.length ?? payload.byteLength, subscriberCount: () => 0 };
}

/** Run fn with the fakes registered as live connections, caps counted. */
function withConnections(fakes, fn) {
	setServer(fakeServer());
	for (const f of fakes) {
		wsConnections.add(f);
		if (f.ud[WS_CAPS]) capCounts.adjust(null, f.ud[WS_CAPS]);
	}
	try {
		fn();
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

function isAnnounce(payload) {
	if (typeof payload !== 'string') return false;
	try {
		return JSON.parse(payload).type === 'wire-id';
	} catch {
		return false;
	}
}

/** What reached a socket, in order: 'announce', 'binary' or 'json'. */
function frames(ws) {
	return ws.sent.map((s) =>
		s.payload instanceof Uint8Array ? 'binary' : isAnnounce(s.payload) ? 'announce' : 'json'
	);
}

/**
 * The subscriber received broadcast data, and its counters hold exactly the
 * announces it was sent and nothing else.
 */
function chargedOnlyAnnounces(ws, label) {
	// The counters are live, or a zero below would prove nothing.
	assert.equal(closeHookRegistered, true);
	const announces = ws.sent.filter((s) => isAnnounce(s.payload));
	assert.ok(ws.sent.length > announces.length, label + ': broadcast data reached the socket');
	assert.equal(ws.stats.messagesOut, announces.length, label + ': messagesOut');
	assert.equal(
		ws.stats.bytesOut,
		announces.reduce((n, s) => n + s.payload.length, 0),
		label + ': bytesOut'
	);
}

const binary = new Uint8Array([4, 2]);

test('publishWire charges no subscriber on the stateless walk', () => {
	const capable = fakeWs([], { topics: [ROOM], caps: [CAP] });
	const jsonOnly = fakeWs([], { topics: [ROOM] });
	withConnections([capable, jsonOnly], () => {
		const wire = { capability: CAP, schemaVersion: 2, encode: () => binary };
		assert.equal(platform.publishWire(ROOM, 'moved', { text: GERMAN }, wire), true);
	});
	assert.deepEqual(frames(capable), ['announce', 'binary']);
	assert.deepEqual(frames(jsonOnly), ['json']);
	chargedOnlyAnnounces(capable, 'binary subscriber');
	chargedOnlyAnnounces(jsonOnly, 'JSON subscriber');
});

test('publishWire charges no subscriber when a declined frame walks for an exclusion', () => {
	const sender = fakeWs([], { topics: [ROOM] });
	const other = fakeWs([], { topics: [ROOM] });
	withConnections([sender, other], () => {
		const wire = { capability: CAP, schemaVersion: 2, encode: () => null };
		assert.equal(platform.publishWire(ROOM, 'moved', { text: GERMAN }, wire, { excludeWs: sender }), true);
	});
	assert.equal(sender.sent.length, 0);
	assert.deepEqual(frames(other), ['json']);
	chargedOnlyAnnounces(other, 'declined-frame subscriber');
});

test('publishWire charges no subscriber on the stateful walk', () => {
	const capable = fakeWs([], { topics: [ROOM], caps: [CAP] });
	const stateless = fakeWs([], { topics: [ROOM], caps: [CAP] });
	const jsonOnly = fakeWs([], { topics: [ROOM] });
	withConnections([capable, stateless, jsonOnly], () => {
		const wire = {
			capability: CAP,
			schemaVersion: 2,
			// An older client negotiates no state and shares the baseline encode.
			state: { onAttach: (ws) => (ws === stateless ? null : {}) },
			encode: () => binary
		};
		assert.equal(platform.publishWire(ROOM, 'moved', { text: GERMAN }, wire), true);
	});
	assert.deepEqual(frames(capable), ['announce', 'binary']);
	assert.deepEqual(frames(stateless), ['announce', 'binary']);
	assert.deepEqual(frames(jsonOnly), ['json']);
	chargedOnlyAnnounces(capable, 'per-connection encode');
	chargedOnlyAnnounces(stateless, 'shared baseline encode');
	chargedOnlyAnnounces(jsonOnly, 'JSON subscriber');
});

test('publishWireBatch charges no subscriber on any of its per-connection sends', () => {
	const entries = [{ data: { text: GERMAN } }, { data: { text: 'b' } }, { data: { text: 'c' } }];
	// The whole batch in one binary frame, and a JSON subscriber beside it.
	const batched = fakeWs([], { topics: [ROOM], caps: [CAP] });
	const jsonOnly = fakeWs([], { topics: [ROOM] });
	withConnections([batched, jsonOnly], () => {
		const wire = { capability: CAP, schemaVersion: 2, state: { onAttach: () => ({}) }, encode: () => binary };
		assert.equal(platform.publishWireBatch(ROOM, 'moved', entries, wire), true);
	});
	assert.deepEqual(frames(batched), ['announce', 'binary'], 'one frame for the whole batch');
	assert.deepEqual(frames(jsonOnly), ['json', 'json', 'json']);
	chargedOnlyAnnounces(batched, 'batch frame');
	chargedOnlyAnnounces(jsonOnly, 'JSON batch');

	// A declined batch encode falls back per entry: binary where the entry
	// encodes, the JSON envelope where it declines.
	const perEntry = fakeWs([], { topics: [ROOM], caps: [CAP] });
	withConnections([perEntry], () => {
		const wire = {
			capability: CAP,
			schemaVersion: 2,
			state: { onAttach: () => ({}) },
			encode: (event, data) => (event.endsWith('-batch') || data.text === 'b' ? null : binary)
		};
		assert.equal(platform.publishWireBatch(ROOM, 'moved', entries, wire), true);
	});
	assert.deepEqual(frames(perEntry), ['announce', 'binary', 'json', 'binary']);
	chargedOnlyAnnounces(perEntry, 'per-entry fallback');
});

test('no broadcast lane charges a subscriber, at any of its send sites', () => {
	// The walks above reach every inline send; this holds the call sites the
	// walks reach only through a shared helper (the JSON fallbacks) to the same
	// rule, so a charge added beside any of them is caught as well.
	// The directed senders that do charge are named too: the JSON fallback of a
	// broadcast walk writes the same bytes wireJsonSend would, so a refactor
	// onto that helper would charge them without a literal bumpOut in sight.
	const charging = /\bbumpOut\(|\bwireJsonSend\(|\bsendControl\(|\b(this|platform)\.send(Wire|WireBatch|To)?\(/;
	for (const name of ['publish', 'publishWire', 'publishWireBatch']) {
		assert.doesNotMatch(platform[name].toString(), charging, name);
	}
});

test('a walk that falls back to JSON for one subscriber charges it nothing', () => {
	// The announce is refused past backpressure, so the walk poisons the
	// capability and serves the JSON envelope through the shared fallback.
	const capable = fakeWs([SEND_DROPPED], { topics: [ROOM], caps: [CAP] });
	withConnections([capable], () => {
		const wire = { capability: CAP, schemaVersion: 2, encode: () => binary };
		assert.equal(platform.publishWire(ROOM, 'moved', { text: GERMAN }, wire), true);
	});
	assert.deepEqual(frames(capable), ['announce', 'json']);
	assert.equal(capable.stats.messagesOut, 0, 'neither the dropped announce nor the broadcast');
	assert.equal(capable.stats.bytesOut, 0);
});

test('sendCoalesced is a directed send: what it writes is charged, as on svelte-adapter-uws', () => {
	const ws = fakeWs();
	platform.sendCoalesced(ws, { key: 'k', topic: 'room', event: 'moved', data: { text: GERMAN } });
	assert.equal(ws.stats.messagesOut, 1);
	assert.equal(ws.stats.bytesOut, ws.sent[0].payload.length);
});

test('a coalesced frame the socket dropped is charged once, when it finally goes out', () => {
	const ws = fakeWs([SEND_DROPPED]);
	platform.sendCoalesced(ws, { key: 'k', topic: 'room', event: 'moved', data: 1 });
	assert.equal(ws.stats.messagesOut, 0, 'dropped: nothing went out');
	platform.sendCoalesced(ws, { key: 'k', topic: 'room', event: 'moved', data: 2 });
	assert.equal(ws.stats.messagesOut, 1);
	assert.equal(ws.stats.bytesOut, ws.sent.at(-1).payload.length);
});


for (const status of [0, 1, SEND_DROPPED]) {
	test(`directed wire lanes charge only accepted JSON and binary frames: status ${status}`, () => {
		for (const lane of ['single-json', 'single-binary', 'batch-json', 'batch-binary', 'batch-entry-binary', 'batch-entry-json']) {
			const binaryLane = lane.endsWith('binary');
			const ws = fakeWs(binaryLane ? [1, status] : [status], { caps: [CAP] });
			const wire = {
				capability: CAP,
				schemaVersion: 1,
				state: { onAttach: () => ({}) },
				encode: (event) => {
					if (lane.includes('entry') && event.endsWith('-batch')) return null;
					return binaryLane ? binary : null;
				}
			};
			const result = lane.startsWith('single')
				? platform.sendWire(ws, ROOM, 'moved', 1, wire)
				: platform.sendWireBatch(ws, ROOM, 'moved', [{ data: 1 }], wire);
			assert.equal(result, status, lane);
			const accepted = status === SEND_DROPPED ? ws.sent.slice(0, -1) : ws.sent;
			assert.equal(ws.stats.messagesOut, accepted.length, lane);
			assert.equal(ws.stats.bytesOut, accepted.reduce((sum, frame) => sum + (typeof frame.payload === 'string' ? frame.payload.length : frame.payload.byteLength), 0), lane);
			if (binaryLane) assert.equal(wireStatePoisoned(ws.ud, CAP), status === SEND_DROPPED, lane);
		}
	});
}

test('a dropped stateful batch entry poisons the codec while later queued and written JSON count normally', () => {
	const ws = fakeWs([1, SEND_DROPPED, 0, 1], { caps: [CAP] });
	const wire = {
		capability: CAP, schemaVersion: 1, state: { onAttach: () => ({}) },
		encode: event => event.endsWith('-batch') ? null : binary
	};
	assert.equal(platform.sendWireBatch(ws, ROOM, 'moved', [{ data: 1 }, { data: 2 }, { data: 3 }], wire), 1, 'the final frame determines the return status');
	assert.deepEqual(frames(ws), ['announce', 'binary', 'json', 'json']);
	assert.equal(wireStatePoisoned(ws.ud, CAP), true);
	const accepted = [ws.sent[0], ...ws.sent.slice(2)];
	assert.equal(ws.stats.messagesOut, 3);
	assert.equal(ws.stats.bytesOut, accepted.reduce((sum, frame) => sum + frame.payload.length, 0));
});

for (const method of ['sendWire', 'sendWireBatch']) {
	test(`${method} counts queued JSON after a dropped announce without charging the announce`, () => {
		const ws = fakeWs([SEND_DROPPED, 0], { caps: [CAP] });
		const wire = { capability: CAP, schemaVersion: 1, state: { onAttach: () => ({}) }, encode: () => binary };
		const result = method === 'sendWire'
			? platform.sendWire(ws, ROOM, 'moved', 1, wire)
			: platform.sendWireBatch(ws, ROOM, 'moved', [{ data: 1 }], wire);
		assert.equal(result, 0);
		assert.deepEqual(frames(ws), ['announce', 'json']);
		assert.equal(wireStatePoisoned(ws.ud, CAP), true);
		assert.equal(ws.stats.messagesOut, 1);
		assert.equal(ws.stats.bytesOut, ws.sent[1].payload.length);
	});
}

test('directed sends that throw before handing off a frame charge nothing', () => {
	const ws = fakeWs();
	ws.send = () => { throw new Error('closed'); };
	assert.equal(platform.send(ws, ROOM, 'moved', 1), SEND_DROPPED);
	assert.equal(platform.sendWire(ws, ROOM, 'moved', 1, { capability: CAP, schemaVersion: 1 }), SEND_DROPPED);
	assert.equal(platform.sendWireBatch(ws, ROOM, 'moved', [{ data: 1 }], { capability: CAP }), SEND_DROPPED);
	assert.equal(ws.stats.messagesOut, 0);
	assert.equal(ws.stats.bytesOut, 0);
});

test('reconnect requires a positive whole-millisecond window and never has a close-only mode', () => {
	const ws = fakeWs();
	let closed = 0;
	ws.end = () => closed++;
	withConnections([ws], () => {
		for (const options of [undefined, {}, { close: true }, { windowMs: 0 }, { windowMs: -1 }, { windowMs: 0.5 }, { windowMs: NaN }]) {
			assert.equal(platform.adviseReconnect(options), 0);
		}
	});
	assert.equal(ws.sent.length, 0);
	assert.equal(closed, 0);
});

test('reconnect snapshots and filters every target before the first advisory', () => {
	const first = fakeWs();
	const second = fakeWs();
	const added = fakeWs();
	first.ud.allow = second.ud.allow = added.ud.allow = true;
	const decisions = [];
	const original = first.send;
	first.send = (...args) => {
		assert.equal(decisions.length, 2, 'the entire filter pass already ran');
		second.ud.allow = false;
		return original(...args);
	};
	withConnections([first, second], () => {
		try {
			assert.equal(platform.adviseReconnect({ windowMs: 100, close: false, filter(data) {
				decisions.push(data);
				wsConnections.add(added);
				return data.allow;
			} }), 2);
		} finally { wsConnections.delete(added); }
	});
	assert.equal(second.sent.length, 1);
	assert.equal(added.sent.length, 0, 'the initial registry snapshot defines the target candidates');
});

test('a reconnect filter exception sends and closes nothing', () => {
	const first = fakeWs();
	const second = fakeWs();
	const failure = new Error('filter failure');
	let calls = 0;
	let closed = 0;
	first.end = second.end = () => closed++;
	withConnections([first, second], () => {
		assert.throws(() => platform.adviseReconnect({ windowMs: 100, filter() {
			if (++calls === 2) throw failure;
			return true;
		} }), error => error === failure);
	});
	assert.equal(first.sent.length + second.sent.length, 0);
	assert.equal(closed, 0);
});

test('reconnect retains completed attempt counts while only accepted sends enter close-hook stats', () => {
	const written = fakeWs([1]);
	const dropped = fakeWs([SEND_DROPPED]);
	const closeThrows = fakeWs();
	const sendThrows = fakeWs();
	const closed = [];
	for (const ws of [written, dropped]) ws.end = (code, reason) => closed.push([code, reason]);
	closeThrows.end = () => { throw new Error('closed during end'); };
	sendThrows.send = () => { throw new Error('closed during send'); };
	const beforeAborts = wsCounters.closedWsAborts;
	const beforeDeliveries = wsCounters.egressDeliveriesWindow;
	withConnections([written, dropped, closeThrows, sendThrows], () => {
		assert.equal(platform.adviseReconnect({ windowMs: 100 }), 2);
	});
	assert.deepEqual(closed, [[1001, 'Server draining'], [1001, 'Server draining']]);
	assert.equal(wsCounters.closedWsAborts - beforeAborts, 2);
	assert.equal(wsCounters.egressDeliveriesWindow - beforeDeliveries, 2);
	for (const ws of [written, closeThrows]) assert.equal(ws.stats.messagesOut, 1);
	assert.equal(dropped.stats.messagesOut, 0);
	assert.equal(dropped.stats.bytesOut, 0);
	assert.equal(sendThrows.stats.messagesOut, 0);
});
