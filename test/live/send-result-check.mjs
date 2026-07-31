// Live test for the send-result shim against a REAL slow consumer.
//
// The unit table (test/unit/send-result.test.mjs) pins the value mapping over
// integer literals; this suite pins the mapping's MEANING. It drives the real
// facade over a real Bun socket whose client cannot read - the client shares
// this event loop, so a synchronous burst saturates the socket buffer exactly
// like the probe's slow consumer - and then checks the tri-state against what
// the client actually received:
//
//   - every frame the shim called SUCCESS or BACKPRESSURE must arrive, because
//     BACKPRESSURE means "enqueued, WILL deliver". If it does not arrive, the
//     shim is losing frames silently.
//   - no frame the shim called DROPPED may arrive. If it arrives, the shim
//     reports delivered frames as lost - today a false loss to any caller that
//     checks its send result, and the false degrade-to-JSON signal the family
//     contract keys on once a binary wire tier exists.
//
// Those two directions are the exact misreads the shim exists to prevent, and
// neither is checkable over integer literals - only delivery decides them.
//
// Needs no fixture build: the server here is a bare Bun.serve wrapping the real
// ws-facade.js, with the probe's slow-consumer shape (16x1MiB burst against a
// 64KiB backpressureLimit - see probe/bun-api-facts.report.md,
// `backpressure-limit`).
//
// Run the whole live lane with: npm run test:live

import { wsFacade, WsClosedError } from '../../src/runtime/handler/ws-facade.js';
import {
	SEND_BACKPRESSURE,
	SEND_SUCCESS,
	SEND_DROPPED
} from '../../src/runtime/utils/send-result.js';

const HOST = '127.0.0.1';
const FRAME_BYTES = 1 << 20;
const BURST_FRAMES = 16;
const BACKPRESSURE_LIMIT = 64 * 1024;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
	if (cond) {
		passed++;
		console.log(`  ok  ${name}`);
	} else {
		failed++;
		failures.push(`${name}${detail ? ' :: ' + detail : ''}`);
		console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
	}
}

function label(state) {
	if (state === SEND_SUCCESS) return 'SUCCESS';
	if (state === SEND_BACKPRESSURE) return 'BACKPRESSURE';
	if (state === SEND_DROPPED) return 'DROPPED';
	return `unknown(${state})`;
}

/** One indexed 1MiB frame, so the client can report WHICH frames arrived. */
function indexedFrame(index) {
	const payload = new Uint8Array(FRAME_BYTES);
	new DataView(payload.buffer).setUint32(0, index, true);
	return payload;
}

let resolveSocket;
const nextSocket = () => new Promise((resolve) => { resolveSocket = resolve; });

const server = Bun.serve({
	hostname: HOST,
	port: 0,
	fetch(req, srv) {
		if (srv.upgrade(req, { data: {} })) return undefined;
		return new Response('not a websocket request', { status: 400 });
	},
	websocket: {
		backpressureLimit: BACKPRESSURE_LIMIT,
		closeOnBackpressureLimit: false,
		open(ws) { resolveSocket(ws); },
		message() {}
	}
});

function openClient() {
	return new Promise((resolve, reject) => {
		const client = new WebSocket(`ws://${HOST}:${server.port}/`);
		client.binaryType = 'arraybuffer';
		client.addEventListener('open', () => resolve(client));
		client.addEventListener('error', () => reject(new Error('client failed to connect')));
		setTimeout(() => reject(new Error('client connect timed out')), 3000);
	});
}

try {
	// --- the slow consumer ---------------------------------------------------

	const opened = nextSocket();
	const client = await openClient();
	const raw = await opened;
	const facade = wsFacade(raw);

	const received = new Set();
	let emptyToSlow = 0;
	client.addEventListener('message', (e) => {
		if (typeof e.data === 'string') {
			if (e.data.length === 0) emptyToSlow++;
			return;
		}
		received.add(new DataView(e.data).getUint32(0, true));
	});

	// The burst is synchronous, so the client (same event loop) cannot read a
	// byte until it ends - that is what makes it a slow consumer.
	const results = [];
	for (let i = 0; i < BURST_FRAMES; i++) {
		results.push(facade.send(indexedFrame(i)));
	}

	// While the socket is still saturated (nothing drains until this synchronous
	// stretch yields): an empty payload also returns 0 from Bun here, and the
	// frame is genuinely dropped (probed) - the facade's backlog check must keep
	// the DROPPED reading rather than misreading it as a healthy empty send.
	const emptyWhileSaturated = facade.send('');
	check(
		'an empty send against the saturated socket maps to DROPPED',
		emptyWhileSaturated === SEND_DROPPED,
		`got ${label(emptyWhileSaturated)}`
	);

	const states = new Set(results);
	check(
		'the first frame of the burst maps to SUCCESS',
		results[0] === SEND_SUCCESS,
		`got ${label(results[0])}`
	);
	// The shape assumes the loopback send buffer is far smaller than the 16MiB
	// burst, which holds by default everywhere this runs; a host tuned with an
	// SO_SNDBUF that swallows the whole burst fails this assertion LOUDLY
	// instead of letting the suite pass without ever saturating.
	check(
		'the burst reaches all three tri-states (the consumer was genuinely slow)',
		states.has(SEND_SUCCESS) && states.has(SEND_BACKPRESSURE) && states.has(SEND_DROPPED),
		`saw ${[...states].map(label).join(', ')}`
	);
	// Nothing drains inside a synchronous loop, so once the buffer is past the
	// limit it stays past it: a non-DROPPED result after the first DROPPED
	// would mean the mapping reads a saturated socket as writable.
	const firstDrop = results.indexOf(SEND_DROPPED);
	check(
		'every result after the first DROPPED is DROPPED',
		firstDrop === -1 || results.slice(firstDrop).every((r) => r === SEND_DROPPED),
		results.map(label).join(', ')
	);

	const expected = new Set();
	for (let i = 0; i < BURST_FRAMES; i++) {
		if (results[i] !== SEND_DROPPED) expected.add(i);
	}

	// Let the client drain. The loop exits early only once every expected frame
	// is in and one further poll adds nothing; a MISSING frame therefore burns
	// the full 10s window before the assertion below reports it - slow, but
	// loud rather than green.
	let lastSize = -1;
	for (let i = 0; i < 100; i++) {
		if (received.size >= expected.size && received.size === lastSize) break;
		lastSize = received.size;
		await Bun.sleep(100);
	}

	const missing = [...expected].filter((i) => !received.has(i));
	check(
		'every frame mapped SUCCESS or BACKPRESSURE is delivered (BACKPRESSURE is not a drop)',
		missing.length === 0,
		`missing frames [${missing.join(', ')}] of ${expected.size} expected`
	);
	const phantom = [...received].filter((i) => !expected.has(i));
	check(
		'no frame mapped DROPPED is delivered (DROPPED is not "enqueued")',
		phantom.length === 0,
		`frames [${phantom.join(', ')}] arrived despite mapping to DROPPED`
	);
	check(
		'the dropped empty frame is never delivered',
		emptyToSlow === 0,
		`${emptyToSlow} zero-length frame(s) arrived`
	);

	client.close();
	await Bun.sleep(200);

	// --- the closed socket ---------------------------------------------------

	// A FRESH, unburdened connection, exactly like the probe: the burst socket
	// still holds backlog, which would confound "closed" with "past the limit".
	const openedB = nextSocket();
	const clientB = await openClient();
	const rawB = await openedB;
	const facadeB = wsFacade(rawB);

	// While this socket is still healthy: an empty send returns 0 from Bun yet
	// the frame is delivered (probed), so the facade must report SUCCESS - the
	// backlog is empty - and the client must actually see the frame.
	let emptyToB = 0;
	clientB.addEventListener('message', (e) => {
		const len = typeof e.data === 'string' ? e.data.length : e.data.byteLength;
		if (len === 0) emptyToB++;
	});
	const emptyHealthy = facadeB.send('');
	check(
		'an empty send on a healthy socket maps to SUCCESS, not DROPPED',
		emptyHealthy === SEND_SUCCESS,
		`got ${label(emptyHealthy)}`
	);
	for (let i = 0; i < 30 && emptyToB === 0; i++) await Bun.sleep(50);
	check(
		'the healthy empty frame is delivered',
		emptyToB > 0,
		'no zero-length frame arrived within 1.5s'
	);

	clientB.close();
	for (let i = 0; i < 50 && rawB.readyState === 1; i++) await Bun.sleep(50);
	check('the fresh socket observed its client close', rawB.readyState !== 1, `readyState ${rawB.readyState}`);

	// Bun returns 0 from a closed send - the same value as "past the limit" -
	// which is why the facade must throw BEFORE the mapping ever runs. Reaching
	// the mapping here would book a closed send as a backpressure drop and
	// poison wire state for a connection that is already gone.
	let thrown = null;
	let mapped = null;
	try {
		mapped = facadeB.send('late');
	} catch (err) {
		thrown = err;
	}
	check(
		'send on the closed socket throws instead of mapping',
		thrown !== null,
		`mapped to ${mapped === null ? 'nothing' : label(mapped)}`
	);
	check(
		'the throw is WsClosedError with code WS_CLOSED naming the operation',
		thrown instanceof WsClosedError && thrown.code === 'WS_CLOSED' && thrown.operation === 'send',
		thrown ? `${thrown.name} code=${thrown.code} operation=${thrown.operation}` : 'no error'
	);
} catch (err) {
	failed++;
	failures.push(`harness: ${err.message}`);
	console.log(`FAIL  harness :: ${err.message}`);
} finally {
	server.stop(true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
	console.log('failures:');
	for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
