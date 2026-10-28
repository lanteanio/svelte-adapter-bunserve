import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A wire-id announce is a control frame the client's subscribe bought, so it
// goes out through the budgeted control sender: charged to the connection's
// control budget, refused with the connection cut when that budget is spent,
// and handled the same way as any other undelivered announce.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { ensureWireId } = await import('../../src/runtime/handler/wire-state.js');
const { joinSharedCohort, cohortTopics } = await import('../../src/runtime/handler/cohort.js');
const { MAX_CONTROL_EGRESS_BYTES, WS_CAPS, WS_SHARED_COHORTS, WS_TOPIC_IDS, chargeControlEgress, wsCounters } =
	await import('../../src/runtime/handler/ws-state.js');
const { sharedWireIdRefs, _resetSharedWireIds } = await import('../../src/runtime/utils/shared-wire-id.js');
const { CONTROL_FLOOD_CLOSE_CODE } = await import('../../src/runtime/utils/control-frame.js');
const { SEND_DROPPED } = await import('../../src/runtime/utils/send-result.js');

const CAP = 'cap:1';
const TOPIC = 'room';

function fakeWs({ script = [], throws = false } = {}) {
	const sent = [];
	const subscribed = [];
	const ud = { [WS_CAPS]: new Set([CAP]) };
	return {
		sent,
		subscribed,
		ud,
		ended: null,
		getUserData: () => ud,
		send(payload) {
			if (throws) throw new Error('closed');
			sent.push(payload);
			return script.length ? script.shift() : 1;
		},
		end(code, reason) {
			this.ended = { code, reason };
		},
		subscribe(topic) {
			subscribed.push(topic);
			return true;
		},
		unsubscribed: [],
		unsubscribe(topic) {
			this.unsubscribed.push(topic);
			return true;
		}
	};
}

const isAnnounce = (p) => typeof p === 'string' && JSON.parse(p).type === 'wire-id';

/** Run fn with console.warn captured; returns the lines it printed. */
function captureWarn(fn) {
	const lines = [];
	const real = console.warn;
	console.warn = (...args) => lines.push(args.join(' '));
	try {
		fn();
	} finally {
		console.warn = real;
	}
	return lines;
}

/** The budget left, read by spending it: everything left fits, one byte more does not. */
function assertBudgetLeft(ws, bytes, label) {
	assert.equal(chargeControlEgress(ws, bytes), true, label + ': the remainder fits');
	assert.equal(chargeControlEgress(ws, 1), false, label + ': and nothing more');
}

test('a delivered announce is charged to the control budget at its UTF-8 size', () => {
	const ws = fakeWs();
	const topic = 'räume';
	const id = ensureWireId(ws, ws.ud, topic);
	assert.ok(id > 0);
	assert.equal(ws.sent.length, 1);
	assert.ok(isAnnounce(ws.sent[0]));
	assertBudgetLeft(ws, MAX_CONTROL_EGRESS_BYTES - Buffer.byteLength(ws.sent[0]), 'per-connection id');
	// Allocated once: the next frame on this topic reuses it with no announce.
	assert.equal(ensureWireId(ws, ws.ud, topic), id);
	assert.equal(ws.sent.length, 1);
});

test('a spent control budget refuses the announce and cuts the connection', () => {
	const ws = fakeWs();
	assert.equal(chargeControlEgress(ws, MAX_CONTROL_EGRESS_BYTES), true);
	const lines = captureWarn(() => {
		assert.equal(ensureWireId(ws, ws.ud, TOPIC), -1);
	});
	assert.equal(lines.length, 1, 'the cut is reported once');
	assert.equal(ws.sent.some(isAnnounce), false, 'no announce reached the socket');
	assert.equal(ws.ended?.code, CONTROL_FLOOD_CLOSE_CODE);
	assert.equal(ws.ud[WS_TOPIC_IDS].byName.has(TOPIC), false, 'the id nobody learned is retired');
});

test('an announce refused past backpressure, or into a closed socket, is not delivered', () => {
	const refused = fakeWs({ script: [SEND_DROPPED] });
	assert.equal(ensureWireId(refused, refused.ud, TOPIC), -1);
	assert.equal(refused.ud[WS_TOPIC_IDS].byName.has(TOPIC), false);
	assert.equal(refused.ended, null, 'backpressure is not a flood');
	// The retired topic re-announces a FRESH id on the next attempt, never the
	// one the client did not receive.
	const again = ensureWireId(refused, refused.ud, TOPIC);
	assert.ok(again > 0);
	assert.ok(isAnnounce(refused.sent.at(-1)));
	assert.equal(JSON.parse(refused.sent.at(-1)).id, again);
	assert.notEqual(JSON.parse(refused.sent[0]).id, again);

	const closed = fakeWs({ throws: true });
	const aborts = wsCounters.closedWsAborts;
	assert.equal(ensureWireId(closed, closed.ud, TOPIC), -1);
	assert.equal(wsCounters.closedWsAborts, aborts + 1);
	assert.equal(closed.ud[WS_TOPIC_IDS].byName.has(TOPIC), false);
});

test('a shared-cohort announce is charged to the control budget and joins the binary cohort', () => {
	_resetSharedWireIds();
	const ws = fakeWs();
	joinSharedCohort(ws, ws.ud, TOPIC, CAP);
	const { bin } = cohortTopics(TOPIC);
	assert.deepEqual(ws.subscribed, [bin]);
	assert.equal(ws.ud[WS_SHARED_COHORTS].has(TOPIC), true);
	assert.equal(sharedWireIdRefs(TOPIC), 1);
	assertBudgetLeft(ws, MAX_CONTROL_EGRESS_BYTES - Buffer.byteLength(ws.sent[0]), 'shared id');
	_resetSharedWireIds();
});

test('a refused shared-cohort announce serves JSON; a spent budget or a closed socket joins nothing', () => {
	const { json } = cohortTopics(TOPIC);

	_resetSharedWireIds();
	const refused = fakeWs({ script: [SEND_DROPPED] });
	joinSharedCohort(refused, refused.ud, TOPIC, CAP);
	assert.deepEqual(refused.subscribed, [json]);
	assert.equal(sharedWireIdRefs(TOPIC), 0, 'the reference the announce would have held is released');

	_resetSharedWireIds();
	const spent = fakeWs();
	assert.equal(chargeControlEgress(spent, MAX_CONTROL_EGRESS_BYTES), true);
	const lines = captureWarn(() => joinSharedCohort(spent, spent.ud, TOPIC, CAP));
	assert.equal(lines.length, 1);
	assert.deepEqual(spent.subscribed, [], 'a cut connection is subscribed to nothing');
	assert.equal(spent.sent.some(isAnnounce), false);
	assert.equal(spent.ended?.code, CONTROL_FLOOD_CLOSE_CODE);
	assert.equal(sharedWireIdRefs(TOPIC), 0);

	_resetSharedWireIds();
	const closed = fakeWs({ throws: true });
	joinSharedCohort(closed, closed.ud, TOPIC, CAP);
	assert.deepEqual(closed.subscribed, []);
	assert.equal(sharedWireIdRefs(TOPIC), 0);
	_resetSharedWireIds();
});

test('the modules that announce wire ids hold no raw send', () => {
	for (const rel of ['../../src/runtime/handler/wire-state.js', '../../src/runtime/handler/cohort.js']) {
		const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
		assert.doesNotMatch(src, /\bws\.send\(/, rel);
	}
});

test('a publish walk that spends one subscriber\'s budget cuts it and still serves the rest', async () => {
	const { platform } = await import('../../src/runtime/handler/platform.js');
	const { WS_SUBSCRIPTIONS, capCounts, setServer, sharedTopics, topicSeqs, wsConnections } = await import(
		'../../src/runtime/handler/ws-state.js'
	);
	/** A capable subscriber whose sends throw once it is cut, as a closed facade's do. */
	function subscriber() {
		const ws = fakeWs();
		ws.ud[WS_SUBSCRIPTIONS] = new Set([TOPIC]);
		const send = ws.send;
		ws.send = function (payload) {
			if (this.ended) throw new Error('closed');
			return send.call(this, payload);
		};
		return ws;
	}
	const cut = subscriber();
	const next = subscriber();
	chargeControlEgress(cut, MAX_CONTROL_EGRESS_BYTES + 1);
	setServer({ publish: () => 0, subscriberCount: () => 2 });
	for (const ws of [cut, next]) {
		wsConnections.add(ws);
		capCounts.adjust(null, ws.ud[WS_CAPS]);
	}
	const aborts = wsCounters.closedWsAborts;
	try {
		const wire = { capability: CAP, schemaVersion: 2, encode: () => new Uint8Array([4, 2]) };
		const lines = captureWarn(() => {
			assert.equal(platform.publishWire(TOPIC, 'moved', { x: 1 }, wire), true);
		});
		assert.equal(lines.length, 1);
	} finally {
		for (const ws of [cut, next]) {
			wsConnections.delete(ws);
			capCounts.adjust(ws.ud[WS_CAPS], null);
		}
		sharedTopics.clear();
		topicSeqs.clear();
	}
	assert.equal(cut.ended?.code, CONTROL_FLOOD_CLOSE_CODE);
	assert.deepEqual(cut.sent, [], 'nothing reached the cut socket');
	assert.equal(wsCounters.closedWsAborts, aborts + 1, 'its JSON fallback met a closed socket once');
	assert.equal(next.sent.length, 2, 'the next subscriber got its announce and its frame');
	assert.ok(isAnnounce(next.sent[0]));
	assert.ok(next.sent[1] instanceof Uint8Array);
});

test('a repeated join for a held topic takes no second reference and sends no second announce', () => {
	_resetSharedWireIds();
	const ws = fakeWs();
	joinSharedCohort(ws, ws.ud, TOPIC, CAP);
	joinSharedCohort(ws, ws.ud, TOPIC, CAP);
	assert.equal(sharedWireIdRefs(TOPIC), 1);
	assert.equal(ws.sent.filter(isAnnounce).length, 1);
	_resetSharedWireIds();
});

test('a connection served JSON by a refused announce moves to the binary cohort when a later join succeeds', () => {
	_resetSharedWireIds();
	const { bin, json } = cohortTopics(TOPIC);
	const ws = fakeWs({ script: [SEND_DROPPED] });
	joinSharedCohort(ws, ws.ud, TOPIC, CAP);
	assert.deepEqual(ws.subscribed, [json]);
	joinSharedCohort(ws, ws.ud, TOPIC, CAP);
	assert.deepEqual(ws.subscribed, [json, bin]);
	assert.ok(ws.unsubscribed.includes(json), 'off the JSON cohort, or it would get every publish twice');
	assert.equal(sharedWireIdRefs(TOPIC), 1);
	_resetSharedWireIds();
});

test('a binary member that lost the capability moves to the JSON cohort and gives its reference back', () => {
	_resetSharedWireIds();
	const { bin, json } = cohortTopics(TOPIC);
	const ws = fakeWs();
	joinSharedCohort(ws, ws.ud, TOPIC, CAP);
	assert.equal(sharedWireIdRefs(TOPIC), 1);
	// A re-sent hello replaces the capability set.
	ws.ud[WS_CAPS] = new Set();
	joinSharedCohort(ws, ws.ud, TOPIC, CAP);
	assert.ok(ws.unsubscribed.includes(bin));
	assert.equal(ws.subscribed.at(-1), json);
	assert.equal(ws.ud[WS_SHARED_COHORTS].has(TOPIC), false);
	assert.equal(sharedWireIdRefs(TOPIC), 0);
	_resetSharedWireIds();
});
