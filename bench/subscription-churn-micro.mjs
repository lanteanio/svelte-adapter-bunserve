// Micro-bench for subscription churn through the platform: a subscribe that
// installs and the unsubscribe that releases it, on one connection, with an
// app hook that allows. Every membership change moves the worker's
// subscription total, so this is the path an accounting change lands on. It
// uses only the platform surface, so it runs unchanged against an older tree.
// Two runs in separate processes differ by several percent even on identical
// trees, so a change smaller than that is measured with
// bench/subscription-churn-ab.mjs, which times the trees side by side.
//
// Run under Bun (the shipped runtime), with the test condition so the hook stub
// resolves: bun --conditions=bunserve-test bench/subscription-churn-micro.mjs

// Production mode, as a deployed server runs: set before the runtime loads.
process.env.NODE_ENV = 'production';
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { __setHooks } = await import('../test/helpers/ws-handler-stub.mjs');
__setHooks({ subscribe: () => null });
const { websocketHandlers } = await import('../src/runtime/handler/ws.js');
const { platform } = await import('../src/runtime/handler/platform.js');
const { wsFacade } = await import('../src/runtime/handler/ws-facade.js');
const { CARRY_REQUEST_ID, WS_SUBSCRIPTIONS, wsCounters } = await import('../src/runtime/handler/ws-state.js');

const ITERS = 400_000;
const ROUNDS = 7;

const raw = {
	data: { [CARRY_REQUEST_ID]: 'bench' },
	readyState: 1,
	send: (/** @type {string} */ payload) => payload.length,
	subscribe: () => true,
	unsubscribe: () => true,
	isSubscribed: () => false,
	// A cut (the control budget, say) closes the socket for real, so the check
	// at the end can see that the bench ran on a closed connection.
	close() {
		if (raw.readyState !== 1) return;
		raw.readyState = 3;
		websocketHandlers.close(raw, 1000, '');
	},
	terminate() { raw.close(); },
	getBufferedAmount: () => 0,
	cork: (/** @type {() => unknown} */ fn) => fn()
};
websocketHandlers.open(raw);
const ws = wsFacade(raw);

// The first pair is checked rather than assumed: a subscribe the gate refused
// installs nothing, and a loop of refusals times something else entirely.
const first = await platform.subscribe(ws, 'room:42');
if (first !== null) throw new Error(`the subscribe was refused: ${first}`);
if (wsCounters.totalSubscriptions !== 1) throw new Error('the subscribe was not counted');
platform.unsubscribe(ws, 'room:42');
await websocketHandlers.message(raw, '{"type":"subscribe","topic":"room:7"}');
if (!raw.data[WS_SUBSCRIPTIONS].has('room:7')) throw new Error('the subscribe frame installed nothing');
await websocketHandlers.message(raw, '{"type":"unsubscribe","topic":"room:7"}');

async function timeChurn() {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) {
		await platform.subscribe(ws, 'room:42');
		platform.unsubscribe(ws, 'room:42');
	}
	return (Bun.nanoseconds() - t0) / ITERS;
}

// The same pair as a client drives it, through the message handler. Ref-less,
// so nothing is acked: the acks would spend the connection's control budget
// within the first round and the socket would be closed under the bench.
const subFrame = '{"type":"subscribe","topic":"room:7"}';
const unsubFrame = '{"type":"unsubscribe","topic":"room:7"}';
async function timeWireChurn() {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) {
		await websocketHandlers.message(raw, subFrame);
		await websocketHandlers.message(raw, unsubFrame);
	}
	return (Bun.nanoseconds() - t0) / ITERS;
}

// The accounting step alone, against the inline add-and-count it replaced. Only
// meaningful in a tree that has the primitives; skipped where it does not.
const SYNC_ITERS = 5_000_000;
let primitives = null;
try {
	primitives = await import('../src/runtime/utils/ws-symbols.js');
	if (typeof primitives.addLogicalSubscription !== 'function') primitives = null;
} catch {
	primitives = null;
}
const { adjustTotalSubscriptions } = await import('../src/runtime/handler/ws-state.js');
const set = new Set();
function timeInline() {
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < SYNC_ITERS; i++) {
		if (!set.has('t')) { set.add('t'); adjustTotalSubscriptions(1); }
		if (set.delete('t')) adjustTotalSubscriptions(-1);
	}
	return (Bun.nanoseconds() - t0) / SYNC_ITERS;
}
function timePrimitives() {
	const { addLogicalSubscription, removeLogicalSubscription } = /** @type {any} */ (primitives);
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < SYNC_ITERS; i++) {
		addLogicalSubscription(set, 't');
		removeLogicalSubscription(set, 't');
	}
	return (Bun.nanoseconds() - t0) / SYNC_ITERS;
}

const median = (/** @type {number[]} */ xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

await timeChurn();
await timeWireChurn();
timeInline();
if (primitives) timePrimitives();
/** @type {Record<string, number[]>} */
const runs = { churn: [], wire: [], inline: [], primitives: [] };
for (let r = 0; r < ROUNDS; r++) {
	runs.churn.push(await timeChurn());
	runs.wire.push(await timeWireChurn());
	runs.inline.push(timeInline());
	if (primitives) runs.primitives.push(timePrimitives());
}

console.log(`Bun ${Bun.version}, ${ITERS.toLocaleString()} iterations x ${ROUNDS} rounds, median ns/op`);
console.log(`  subscribe + unsubscribe   ${median(runs.churn).toFixed(2)}`);
console.log(`  same pair as wire frames  ${median(runs.wire).toFixed(2)}`);
console.log(`  inline add + count pair   ${median(runs.inline).toFixed(2)}`);
if (primitives) console.log(`  accounted add + remove    ${median(runs.primitives).toFixed(2)}`);
// Every pair installed and released: the bench measured the real path.
if (wsCounters.totalSubscriptions !== 0) throw new Error(`total is ${wsCounters.totalSubscriptions}, expected 0`);
if (raw.readyState !== 1 || ws._closed) throw new Error('the connection closed under the bench');
