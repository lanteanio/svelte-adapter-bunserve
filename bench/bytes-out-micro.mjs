// Micro-bench for the per-send traffic counter (`bumpOut` in
// src/runtime/handler/ws-stats.js), which every directed send and control frame
// pays once a close hook is registered. It times the shipped function on three
// text envelopes - a short and a long ASCII one, and a German one where UTF-8
// and UTF-16 counts differ - plus the two unit choices side by side, so the
// cost of an exact UTF-8 count reads against the `length` read it replaces.
//
// Run under Bun (the shipped runtime), with the test condition so the close
// hook stub resolves: bun --conditions=bunserve-test bench/bytes-out-micro.mjs

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { __setHooks } = await import('../test/helpers/ws-handler-stub.mjs');
__setHooks({ close() {} });
const { bumpOut, closeHookRegistered } = await import('../src/runtime/handler/ws-stats.js');
const { WS_STATS } = await import('../src/runtime/handler/ws-state.js');

// Without a registered close hook bumpOut returns before counting, and the
// first column would time an early return. Refuse rather than print that.
if (!closeHookRegistered) {
	throw new Error('the close hook stub did not resolve; run with --conditions=bunserve-test');
}

const ITERS = 5_000_000;

const envelopes = {
	'ascii 90': '{"topic":"room:42","event":"update","data":{"id":1,"value":"hello world benchmark"}}'.padEnd(90, ' '),
	'ascii 400': '{"topic":"room:42","event":"update","data":{"text":"' + 'x'.repeat(340) + '"}}',
	'german 400': '{"topic":"room:42","event":"update","data":{"text":"' + 'Größenänderung übermäßig '.repeat(14).slice(0, 340) + '"}}'
};

const ud = { [WS_STATS]: { messagesIn: 0, messagesOut: 0, bytesIn: 0, bytesOut: 0 } };
const ws = { getUserData: () => ud };

function timeBump(payload) {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) bumpOut(ws, payload);
	return (Bun.nanoseconds() - t0) / ITERS;
}

let sink = 0;
function timeUnit(payload, exact) {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) sink += exact ? Buffer.byteLength(payload) : payload.length;
	return (Bun.nanoseconds() - t0) / ITERS;
}

// Warm every shape, then measure each twice and report the mean.
for (const p of Object.values(envelopes)) { timeBump(p); timeUnit(p, true); timeUnit(p, false); }

console.log('shape        chars  utf8   bumpOut ns  length ns  byteLength ns');
for (const [name, p] of Object.entries(envelopes)) {
	const bump = (timeBump(p) + timeBump(p)) / 2;
	const len = (timeUnit(p, false) + timeUnit(p, false)) / 2;
	const exact = (timeUnit(p, true) + timeUnit(p, true)) / 2;
	console.log(
		name.padEnd(12),
		String(p.length).padStart(5),
		String(Buffer.byteLength(p)).padStart(5),
		bump.toFixed(2).padStart(11),
		len.toFixed(2).padStart(10),
		exact.toFixed(2).padStart(14)
	);
}
// Every timed call counted: one warm-up and two measured passes per shape.
const expected = Object.keys(envelopes).length * 3 * ITERS;
if (ud[WS_STATS].messagesOut !== expected) {
	throw new Error(`bumpOut counted ${ud[WS_STATS].messagesOut} frames, expected ${expected}`);
}
if (sink === -1) console.log(ud);
