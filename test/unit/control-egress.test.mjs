import { test } from 'node:test';
import assert from 'node:assert/strict';

// A connection that spends its control-frame budget is closed 4429 with
// nothing written before the close; the operator gets a console line naming
// the connection's request id.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { sendControl, CONTROL_DELIVERED, CONTROL_GONE } = await import('../../src/runtime/handler/control-egress.js');
const { CARRY_REQUEST_ID, MAX_CONTROL_EGRESS_BYTES, WS_PLATFORM, chargeControlEgress } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
const { CONTROL_FLOOD_CLOSE_CODE } = await import('../../src/runtime/utils/control-frame.js');

/** userData as it stands after open: the request id lives on the platform clone. */
function fakeWs(requestId) {
	const ud = { [WS_PLATFORM]: { requestId } };
	return {
		sent: [],
		ends: [],
		getUserData: () => ud,
		send(payload) {
			this.sent.push(payload);
			return 1;
		},
		end(code, reason) {
			this.ends.push({ code, reason });
		}
	};
}

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

test('a spent control budget closes 4429 with nothing written before the close', () => {
	const ws = fakeWs('req-flood-1');
	assert.equal(sendControl(ws, '{"type":"resumed"}'), CONTROL_DELIVERED);
	assert.equal(ws.sent.length, 1);
	// Over the limit; a refused charge is still recorded, so the window is spent.
	assert.equal(chargeControlEgress(ws, MAX_CONTROL_EGRESS_BYTES), false);

	const lines = captureWarn(() => {
		assert.equal(sendControl(ws, '{"type":"resumed"}'), CONTROL_GONE);
	});
	assert.equal(ws.sent.length, 1, 'no frame, refusal or otherwise, went out');
	assert.deepEqual(
		ws.ends.map((e) => e.code),
		[CONTROL_FLOOD_CLOSE_CODE]
	);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /req-flood-1/);
	assert.match(lines[0], /4429/);
});

test('the line names the request id the upgrade carried, through a real open', () => {
	// The fakes above hand-build userData; this one lets the open handler build
	// it from the slot the upgrade writes, so the line reads what production has.
	const raw = {
		data: { [CARRY_REQUEST_ID]: 'req-from-upgrade' },
		sent: [],
		ended: null,
		readyState: 1,
		send(payload) {
			this.sent.push(payload);
			return payload.length;
		},
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close(code, reason) {
			this.ended = this.ended ?? { code, reason };
		},
		terminate() {
			this.ended = this.ended ?? { code: 1006, reason: 'terminated' };
		},
		getBufferedAmount: () => 0,
		cork: (fn) => fn()
	};
	websocketHandlers.open(raw);
	const ws = wsFacade(raw);
	const before = raw.sent.length;
	chargeControlEgress(ws, MAX_CONTROL_EGRESS_BYTES);
	const lines = captureWarn(() => {
		assert.equal(sendControl(ws, '{"type":"resumed"}'), CONTROL_GONE);
	});
	assert.equal(raw.sent.length, before, 'nothing written before the close');
	assert.equal(raw.ended?.code, CONTROL_FLOOD_CLOSE_CODE);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /req-from-upgrade/);
});

test('a console.warn that throws does not keep a flooding connection open', () => {
	const ws = fakeWs('req-flood-throwing-logger');
	chargeControlEgress(ws, MAX_CONTROL_EGRESS_BYTES);
	const real = console.warn;
	console.warn = () => {
		throw new Error('logger down');
	};
	try {
		assert.equal(sendControl(ws, '{"type":"resumed"}'), CONTROL_GONE);
	} finally {
		console.warn = real;
	}
	assert.deepEqual(
		ws.ends.map((e) => e.code),
		[CONTROL_FLOOD_CLOSE_CODE]
	);
	assert.equal(ws.sent.length, 0);
});

test('a second sender that meets the same spent budget neither closes again nor reports again', () => {
	const ws = fakeWs('req-flood-2');
	chargeControlEgress(ws, MAX_CONTROL_EGRESS_BYTES);
	const lines = captureWarn(() => {
		assert.equal(sendControl(ws, '{"type":"resumed"}'), CONTROL_GONE);
		assert.equal(sendControl(ws, '{"type":"resumed"}'), CONTROL_GONE);
	});
	assert.equal(ws.sent.length, 0);
	assert.equal(ws.ends.length, 1);
	assert.equal(lines.length, 1);
});
