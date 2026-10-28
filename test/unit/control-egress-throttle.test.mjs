import { test } from 'node:test';
import assert from 'node:assert/strict';

// The control-flood line is throttled process-wide, because a client drives
// it: a reconnecting flood cut over and over must not bury every other
// warning. In a file of its own so the throttle starts from nothing.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { sendControl, CONTROL_GONE } = await import('../../src/runtime/handler/control-egress.js');
const { MAX_CONTROL_EGRESS_BYTES, WS_PLATFORM, chargeControlEgress } = await import(
	'../../src/runtime/handler/ws-state.js'
);

function spentConnection(i) {
	const ud = { [WS_PLATFORM]: { requestId: 'req-' + i } };
	const ws = {
		ends: 0,
		getUserData: () => ud,
		send: () => 1,
		end() {
			this.ends++;
		}
	};
	chargeControlEgress(ws, MAX_CONTROL_EGRESS_BYTES + 1);
	return ws;
}

test('twelve cut connections in a burst log ten lines, and every one is cut', () => {
	const lines = [];
	const real = console.warn;
	console.warn = (...args) => lines.push(args.join(' '));
	const sockets = [];
	try {
		for (let i = 1; i <= 12; i++) {
			const ws = spentConnection(i);
			sockets.push(ws);
			assert.equal(sendControl(ws, '{"type":"resumed"}'), CONTROL_GONE);
		}
	} finally {
		console.warn = real;
	}
	// The first nine, then the tenth occurrence; the eleventh and twelfth are
	// counted but not printed.
	assert.equal(lines.length, 10);
	assert.match(lines[0], /req-1\b/);
	assert.match(lines[9], /\(occurrence 10\)/);
	assert.ok(sockets.every((ws) => ws.ends === 1), 'the throttle silences the line, never the cut');
});
