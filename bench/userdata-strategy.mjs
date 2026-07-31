// A/B bench for the userData access strategy on the per-message hot path.
//
// The two candidates, both against a REAL Bun ServerWebSocket:
//
//   A. the shipped per-connection facade (handler/ws-facade.js): every event
//      handler does one wsFacade(raw) WeakMap acquisition, then calls
//      getUserData() on the held facade - a closure method that also carries
//      the detached check the throw-on-closed contract needs.
//   B. the prototype patch the probe measured (prototype-patch section of
//      probe/bun-api-facts.report.md): stamp a getUserData onto the shared
//      ServerWebSocket prototype once at boot and call it directly on the raw
//      socket - zero acquisition, zero per-connection state, and therefore no
//      place to hang the closed/detached lifecycle the facade exists for.
//
// Reading `raw.data` directly is included as the floor both sit on.
//
// The per-message cost model differs in shape, not just in per-call price:
//   facade   = 1 acquisition + K accesses
//   patch    = K accesses
// so the composite line below prints both at a representative K as well as the
// raw per-operation figures.
//
// Rounds are INTERLEAVED (A, B, A, B, ...) and the median is reported: this
// machine's runs drift by double-digit percentages, and back-to-back blocks
// would hand whichever ran second a quieter machine.
//
// Needs no fixture build. Run: bun bench/userdata-strategy.mjs

import { wsFacade } from '../src/runtime/handler/ws-facade.js';

const HOST = '127.0.0.1';
const ITERATIONS = 2_000_000;
const ROUNDS = 9;
const ACCESSES_PER_MESSAGE = 4;
const CONNECTIONS = 200_000;

let resolveSocket;
const opened = new Promise((resolve) => { resolveSocket = resolve; });

const server = Bun.serve({
	hostname: HOST,
	port: 0,
	fetch(req, srv) {
		if (srv.upgrade(req, { data: { userId: 7 } })) return undefined;
		return new Response('no', { status: 400 });
	},
	websocket: {
		open(ws) { resolveSocket(ws); },
		message() {}
	}
});

const client = await new Promise((resolve, reject) => {
	const c = new WebSocket(`ws://${HOST}:${server.port}/`);
	c.addEventListener('open', () => resolve(c));
	c.addEventListener('error', () => reject(new Error('client failed to connect')));
	setTimeout(() => reject(new Error('client connect timed out')), 3000);
});

const raw = await opened;
const facade = wsFacade(raw);

const proto = Object.getPrototypeOf(raw);
proto.benchGetUserData = function () { return this.data; };

// The checksum keeps every measured loop observable so none of the reads can
// be optimized away; it is printed at the end for the same reason.
let checksum = 0;

/** @param {() => number} op @returns {number} ns per operation */
function measure(op) {
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) checksum += op();
	return (Bun.nanoseconds() - start) / ITERATIONS;
}

/** @param {number[]} samples */
function median(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

const ops = {
	'facade acquisition (wsFacade(raw), WeakMap hit)': () => (wsFacade(raw) === facade ? 1 : 0),
	'facade getUserData() on the held facade': () => facade.getUserData().userId,
	'prototype-patched getUserData() on the raw socket': () => raw.benchGetUserData().userId,
	'raw.data direct read (floor)': () => raw.data.userId
};

// Warm every path once before any measurement, so the first op in the
// rotation is not also paying JIT warmup for its callees.
for (const op of Object.values(ops)) for (let i = 0; i < 100_000; i++) checksum += op();

const samples = Object.fromEntries(Object.keys(ops).map((name) => [name, []]));
for (let round = 0; round < ROUNDS; round++) {
	for (const [name, op] of Object.entries(ops)) {
		samples[name].push(measure(op));
	}
}

console.log(`Bun ${Bun.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} interleaved rounds, median ns/op\n`);
const results = {};
for (const [name, s] of Object.entries(samples)) {
	results[name] = median(s);
	const spread = `${Math.min(...s).toFixed(1)}..${Math.max(...s).toFixed(1)}`;
	console.log(`  ${results[name].toFixed(1).padStart(6)} ns  ${name}  (spread ${spread})`);
}

const acquisition = results['facade acquisition (wsFacade(raw), WeakMap hit)'];
const facadeAccess = results['facade getUserData() on the held facade'];
const patchAccess = results['prototype-patched getUserData() on the raw socket'];
const facadePerMessage = acquisition + ACCESSES_PER_MESSAGE * facadeAccess;
const patchPerMessage = ACCESSES_PER_MESSAGE * patchAccess;
console.log(`\nper-message composite at ${ACCESSES_PER_MESSAGE} accesses:`);
console.log(`  ${facadePerMessage.toFixed(1).padStart(6)} ns  facade (1 acquisition + ${ACCESSES_PER_MESSAGE} accesses)`);
console.log(`  ${patchPerMessage.toFixed(1).padStart(6)} ns  prototype patch (${ACCESSES_PER_MESSAGE} accesses)`);
console.log(`  delta ${(facadePerMessage - patchPerMessage).toFixed(1)} ns/message (${(((facadePerMessage / patchPerMessage) - 1) * 100).toFixed(1)}% over the patch)`);

// The facade's other cost center: creating one per connection. The patch pays
// nothing here. Plain objects stand in for sockets - wsFacade only stores the
// key and closes over it, so the key's type does not enter the cost.
{
	const conns = Array.from({ length: CONNECTIONS }, (_, i) => ({ data: { userId: i } }));
	const start = Bun.nanoseconds();
	for (const c of conns) checksum += wsFacade(c) === undefined ? 0 : 1;
	const perConn = (Bun.nanoseconds() - start) / CONNECTIONS;
	console.log(`\n  ${perConn.toFixed(1).padStart(6)} ns  facade creation per NEW connection (${CONNECTIONS.toLocaleString()} fresh keys)`);
}

console.log(`\nchecksum ${checksum}`);

delete proto.benchGetUserData;
client.close();
server.stop(true);
process.exit(0);
