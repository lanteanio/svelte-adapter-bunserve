import { test } from 'node:test';
import assert from 'node:assert/strict';

// The capability handshake: `{"type":"hello","caps":[...]}` is what arms every
// opt-in feature, and the live per-capability counts it maintains are the gate
// the binary publish fast path asks before walking connections at all. Driven
// through the real demux via the same resolver hook the other handler tests
// use.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';


const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { WS_CAPS, capCounts } = await import('../../src/runtime/handler/ws-state.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

function rawSocket() {
	const sent = [];
	return {
		data: {},
		sent,
		readyState: 1,
		send(payload) {
			sent.push(payload);
			return typeof payload === 'string' ? payload.length : payload.byteLength;
		},
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (fn) => fn()
	};
}

function openSocket() {
	__setHooks({});
	const raw = rawSocket();
	websocketHandlers.open(raw);
	return raw;
}

async function send(raw, frame) {
	await websocketHandlers.message(raw, typeof frame === 'string' ? frame : JSON.stringify(frame));
}

test('hello stores the declared caps and the live counts see them', async () => {
	const raw = openSocket();
	assert.equal(raw.data[WS_CAPS], undefined, 'no hello yet: the slot is absent');
	assert.equal(capCounts.has('cursor:3'), false);
	await send(raw, { type: 'hello', caps: ['cursor:3', 'presence:1'] });
	assert.deepEqual([...raw.data[WS_CAPS]].sort(), ['cursor:3', 'presence:1']);
	assert.equal(capCounts.has('cursor:3'), true);
	websocketHandlers.close(raw, 1000, '');
});

test('a re-sent hello replaces the set and releases dropped caps', async () => {
	const raw = openSocket();
	await send(raw, { type: 'hello', caps: ['bin:1', 'keep:1'] });
	await send(raw, { type: 'hello', caps: ['keep:1'] });
	assert.equal(capCounts.has('bin:1'), false, 'the dropped cap released its count');
	assert.equal(capCounts.has('keep:1'), true);
	assert.deepEqual([...raw.data[WS_CAPS]], ['keep:1']);
	websocketHandlers.close(raw, 1000, '');
});

test('non-string cap entries are dropped, not fatal to the frame', async () => {
	// A newer client may send shapes this server does not know; it must not
	// cost the caps this server DOES understand.
	const raw = openSocket();
	await send(raw, { type: 'hello', caps: ['real:1', 7, null, { cap: 'x' }] });
	assert.deepEqual([...raw.data[WS_CAPS]], ['real:1']);
	assert.equal(capCounts.has('real:1'), true);
	websocketHandlers.close(raw, 1000, '');
});

test('close releases the connection caps and clears the slot', async () => {
	const raw = openSocket();
	await send(raw, { type: 'hello', caps: ['gone:1'] });
	assert.equal(capCounts.has('gone:1'), true);
	websocketHandlers.close(raw, 1000, '');
	assert.equal(capCounts.has('gone:1'), false);
	assert.equal(raw.data[WS_CAPS], undefined);
});

test('two connections sharing a cap: the count survives the first close', async () => {
	const a = openSocket();
	const b = openSocket();
	await send(a, { type: 'hello', caps: ['shared:1'] });
	await send(b, { type: 'hello', caps: ['shared:1'] });
	websocketHandlers.close(a, 1000, '');
	assert.equal(capCounts.has('shared:1'), true, 'b still holds it');
	websocketHandlers.close(b, 1000, '');
	assert.equal(capCounts.has('shared:1'), false);
});

test('an oversized hello is refused as a control frame, not passed to the app', async () => {
	// 'hello' is a CONSUMED control type, so the oversize guard answers it with
	// the protocol refusal instead of handing 8KB of caps to the app hook.
	let appSaw = null;
	__setHooks({ message: (ws, ctx) => { appSaw = ctx.data; } });
	const raw = rawSocket();
	websocketHandlers.open(raw);
	const big = JSON.stringify({ type: 'hello', caps: ['x'.repeat(9000)] });
	await websocketHandlers.message(raw, big);
	assert.equal(appSaw, null, 'the app hook never saw it');
	assert.ok(
		raw.sent.some((f) => typeof f === 'string' && f.includes('CONTROL_FRAME_TOO_LARGE')),
		`expected the oversize refusal, got ${JSON.stringify(raw.sent.slice(-1))}`
	);
	assert.equal(raw.data[WS_CAPS], undefined, 'nothing was stored');
	websocketHandlers.close(raw, 1000, '');
});
