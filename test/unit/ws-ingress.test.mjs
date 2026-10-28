import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { registerIngress, _resetIngressRegistry } = await import('../../src/runtime/handler/ingress.js');
const { buildBinaryFrame } = await import('../../src/runtime/wire.js');
const { WS_INGRESS_BINDINGS } = await import('../../src/runtime/utils/ws-symbols.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

beforeEach(() => { _resetIngressRegistry(); __setHooks({}); });
function open(t) {
	const raw = {
		data: upgradeData(), sent: [], readyState: 1,
		send(payload) { this.sent.push(payload); return payload.length; },
		subscribe: () => true, unsubscribe: () => true, isSubscribed: () => false,
		close() {}, terminate() {}, getBufferedAmount: () => 0, cork: fn => fn()
	};
	websocketHandlers.open(raw);
	raw.sent.length = 0;
	t.after(() => { raw.readyState = 3; websocketHandlers.close(raw, 1000, ''); });
	return raw;
}
const send = (raw, frame) => websocketHandlers.message(raw, JSON.stringify(frame));
const frames = raw => raw.sent.map(frame => JSON.parse(frame));

test('negotiated production ingress binds, decodes an offset view and routes with platform and budgeted sender', async t => {
	const raw = open(t);
	const calls = [];
	registerIngress('test:1', {
		state: { onAttach: ws => ({ requestId: ws.getUserData().requestId }) },
		decode: (payload, schema, seq, state) => ({ bytes: [...payload], schema, seq, state }),
		route: (ws, target, value, platform, seq, sendControl) => {
			calls.push({ target, value, requestId: platform.requestId, seq });
			sendControl(ws, '{"type":"ingress-test"}');
		}
	});
	await send(raw, { type: 'hello', caps: ['wire.ingress:1'] });
	await send(raw, { type: 'ingress-bind', id: 9, kind: 'test:1', target: { room: 'a' } });
	assert.deepEqual(frames(raw), [{ type: 'ingress-ok' }, { type: 'ingress-bound', id: 9 }]);
	const frame = buildBinaryFrame(2, 9, 1234, Uint8Array.of(7, 8));
	const padded = Buffer.alloc(frame.length + 11); padded.set(frame, 5);
	await websocketHandlers.message(raw, padded.subarray(5, 5 + frame.length));
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].target, { room: 'a' });
	assert.deepEqual(calls[0].value.bytes, [7, 8]);
	assert.equal(calls[0].value.schema, 2);
	assert.equal(calls[0].seq, 1234);
	assert.equal(calls[0].requestId, 'req-test');
	assert.equal(frames(raw).at(-1).type, 'ingress-test');
	assert.ok(raw.data[WS_INGRESS_BINDINGS] instanceof Map);
});

test('unnegotiated and unrelated binary frames stay application messages; repeated hello revokes ingress capability', async t => {
	const raw = open(t), app = [], routed = [];
	__setHooks({ message: (_ws, context) => app.push(context) });
	registerIngress('test:1', { decode: p => p, route: () => routed.push(true) });
	await send(raw, { type: 'ingress-bind', id: 1, kind: 'test:1' });
	const binary = Buffer.from(buildBinaryFrame(1, 1, 0, Uint8Array.of(4)));
	await websocketHandlers.message(raw, binary);
	assert.equal(app.length, 1); assert.equal(app[0].data, binary); assert.equal(app[0].isBinary, true);
	await send(raw, { type: 'hello', caps: ['wire.ingress:1'] });
	await websocketHandlers.message(raw, binary);
	await websocketHandlers.message(raw, Buffer.from([2, 4]));
	assert.equal(routed.length, 1); assert.equal(app.length, 2);
	await send(raw, { type: 'hello', caps: [] });
	await websocketHandlers.message(raw, binary);
	assert.equal(app.length, 3); assert.equal(routed.length, 1);
});

test('unknown binding, malformed frame and failing decoder or route are contained without app fallthrough', async t => {
	const raw = open(t), app = [];
	__setHooks({ message: () => app.push(true) });
	await send(raw, { type: 'hello', caps: ['wire.ingress:1'] }); raw.sent.length = 0;
	await send(raw, { type: 'ingress-bind', id: 1, kind: 'unknown' });
	assert.deepEqual(frames(raw), []);
	const binary = Buffer.from(buildBinaryFrame(1, 1, 0, Uint8Array.of(4)));
	await websocketHandlers.message(raw, binary);
	await websocketHandlers.message(raw, Buffer.from([3]));
	for (const handler of [
		{ decode() { throw Error('decode'); }, route() { assert.fail('decode failed'); } },
		{ decode: () => null, route() { assert.fail('null decoded'); } },
		{ decode: () => 0, route() { throw Error('route'); } },
		{ decode: () => 0, route: async () => { throw Error('async route'); } }
	]) {
		registerIngress('test:1', handler);
		await send(raw, { type: 'ingress-bind', id: 1, kind: 'test:1' });
		await websocketHandlers.message(raw, binary);
	}
	assert.deepEqual(app, []);
});

test('oversized ingress binding is refused by the shared control frame ceiling', async t => {
	const raw = open(t);
	registerIngress('test:1', { decode: p => p, route() {} });
	await send(raw, { type: 'ingress-bind', id: 1, kind: 'test:1', target: 'x'.repeat(9000) });
	assert.equal(frames(raw)[0].code, 'CONTROL_FRAME_TOO_LARGE');
	assert.equal(raw.data[WS_INGRESS_BINDINGS], undefined);
});
