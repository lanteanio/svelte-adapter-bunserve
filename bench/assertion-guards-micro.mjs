// Micro-bench for the framework invariant guards on the paths every frame takes:
// the message handler's entry guard, the envelope guard on `send`, and the
// envelope and per-topic stats guards on `publish`. Times the shipped handlers
// end to end on the healthy branch - the only one a working server takes - so it
// runs unchanged against a tree without the guards, and comparing the two runs
// is what says whether the guards cost the hot paths anything. A last pair of
// lines times the guard call alone against the bare comparison it wraps.
//
// Run under Bun (the shipped runtime), with the test condition so the hook stub
// resolves: bun --conditions=bunserve-test bench/assertion-guards-micro.mjs

// Production mode, as a deployed server runs: set before the runtime loads.
process.env.NODE_ENV = 'production';
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { __setHooks } = await import('../test/helpers/ws-handler-stub.mjs');
let received = 0;
__setHooks({ message() { received++; } });
const { websocketHandlers } = await import('../src/runtime/handler/ws.js');
const { platform } = await import('../src/runtime/handler/platform.js');
const { wsFacade } = await import('../src/runtime/handler/ws-facade.js');
const { CARRY_REQUEST_ID, WS_PLATFORM, setServer } = await import('../src/runtime/handler/ws-state.js');

// A server with one subscriber everywhere, so every publish takes the whole
// path - stamp, envelope, egress charge on a topic already in the stats map -
// and the native fan-out is a constant that both trees pay.
setServer(/** @type {any} */ ({ subscriberCount: () => 1, publish: () => 1 }));

const ITERS = 2_000_000;
const ROUNDS = 7;

const raw = {
	data: { [CARRY_REQUEST_ID]: 'bench' },
	readyState: 1,
	send: (/** @type {string} */ payload) => payload.length,
	subscribe: () => true,
	unsubscribe: () => true,
	isSubscribed: () => false,
	close() {},
	terminate() {},
	getBufferedAmount: () => 0,
	cork: (/** @type {() => unknown} */ fn) => fn()
};
websocketHandlers.open(raw);
const ws = wsFacade(raw);

// An application frame: no control prefix, so it takes the path straight to
// the app's hook - the one nearly every inbound frame takes.
const appFrame = '{"topic":"room:42","event":"move","data":{"x":12,"y":7}}';
const data = { x: 12, y: 7 };

function timeMessage() {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) websocketHandlers.message(raw, appFrame);
	return (Bun.nanoseconds() - t0) / ITERS;
}

function timePublish() {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) platform.publish('room:42', 'move', data);
	return (Bun.nanoseconds() - t0) / ITERS;
}

function timeSend() {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) platform.send(ws, 'room:42', 'move', data);
	return (Bun.nanoseconds() - t0) / ITERS;
}

// The guard alone, against the comparison it wraps. Only meaningful in a tree
// that has the module; skipped where it does not exist.
let guard = null;
try {
	guard = await import('../src/runtime/utils/assertions.js');
} catch {
	guard = null;
}
const slot = raw.data[WS_PLATFORM];
let sink = 0;
function timeBare() {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) if (!slot) sink++;
	return (Bun.nanoseconds() - t0) / ITERS;
}
function timeGuard() {
	const fatal = /** @type {any} */ (guard).fatal;
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) fatal(slot, 'ws.platform-missing-in-message', null);
	return (Bun.nanoseconds() - t0) / ITERS;
}

const median = (/** @type {number[]} */ xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// Warm every shape, then measure interleaved so drift lands on all of them.
timeMessage(); timeSend(); timePublish(); timeBare(); if (guard) timeGuard();
/** @type {Record<string, number[]>} */
const runs = { message: [], send: [], publish: [], bare: [], guard: [] };
for (let r = 0; r < ROUNDS; r++) {
	runs.message.push(timeMessage());
	runs.send.push(timeSend());
	runs.publish.push(timePublish());
	runs.bare.push(timeBare());
	if (guard) runs.guard.push(timeGuard());
}

console.log(`Bun ${Bun.version}, ${ITERS.toLocaleString()} iterations x ${ROUNDS} rounds, median ns/op`);
console.log(`  message (app frame)   ${median(runs.message).toFixed(2)}`);
console.log(`  platform.send         ${median(runs.send).toFixed(2)}`);
console.log(`  platform.publish      ${median(runs.publish).toFixed(2)}`);
if (guard) {
	console.log(`  bare !slot check      ${median(runs.bare).toFixed(2)}`);
	console.log(`  fatal(slot, ...)      ${median(runs.guard).toFixed(2)}`);
}
// Every timed message reached the app's hook: the bench measured the real path.
const expected = ITERS * (1 + ROUNDS);
if (received !== expected) throw new Error(`the hook saw ${received} frames, expected ${expected}`);
if (sink === -1) console.log(sink);
