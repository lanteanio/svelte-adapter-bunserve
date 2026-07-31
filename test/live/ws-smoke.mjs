// Live smoke test for the JSON realtime tier. Boots the built fixture under
// Bun, drives a real WebSocket client against it, and asserts the wire
// protocol end to end. Run the whole live lane with: npm run test:live

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8802;
const BUILD = buildPath();

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

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});



/** A client that queues frames and lets the test await the next one. */
function client(query = '') {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`);
	ws.binaryType = 'arraybuffer';
	const queue = [];
	const waiters = [];
	ws.onmessage = (e) => {
		if (waiters.length) waiters.shift()(e.data);
		else queue.push(e.data);
	};
	ws.next = (ms = 2000) =>
		new Promise((resolve, reject) => {
			if (queue.length) return resolve(queue.shift());
			const waiter = (d) => { clearTimeout(timer); resolve(d); };
			const timer = setTimeout(() => {
				// REMOVE the waiter. Leaving it queued meant a timed-out next()
				// still swallowed the following frame, so one deliberate timeout
				// desynchronized every later assertion in the run.
				const at = waiters.indexOf(waiter);
				if (at !== -1) waiters.splice(at, 1);
				reject(new Error('timeout waiting for frame'));
			}, ms);
			waiters.push(waiter);
		});
	/** Frames received but not yet consumed - for asserting SILENCE. */
	ws.pending = () => queue.length;
	ws.opened = new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error('ws error'));
	});
	return ws;
}

const j = (raw) => JSON.parse(raw);

try {
	await waitForServer(proc, PORT);

	// --- upgrade lane ------------------------------------------------------
	const plainGet = await fetch(`http://127.0.0.1:${PORT}/ws`);
	check('plain GET on the ws path is 426, not SSR', plainGet.status === 426, `got ${plainGet.status}`);

	const denied = await fetch(`http://127.0.0.1:${PORT}/ws?deny=1`, {
		headers: { upgrade: 'websocket', connection: 'Upgrade' }
	});
	check('upgrade hook returning a Response rejects with it', denied.status === 401, `got ${denied.status}`);

	const foreign = await fetch(`http://127.0.0.1:${PORT}/ws`, {
		headers: { upgrade: 'websocket', connection: 'Upgrade', origin: 'https://evil.example' }
	});
	check('foreign Origin is refused (CSWSH defense)', foreign.status === 403, `got ${foreign.status}`);

	// The fixture's upgrade hook awaits a real timer, then selects the first
	// offered subprotocol through its context headers channel - so this one
	// connection proves both halves end to end: the handshake survives an
	// awaited hook, and a header the hook set reaches the client on the 101.
	const proto = new WebSocket(`ws://127.0.0.1:${PORT}/ws?user=proto`, ['alpha', 'beta']);
	await new Promise((resolve, reject) => {
		proto.onopen = resolve;
		proto.onerror = () => reject(new Error('subprotocol client failed to connect'));
	});
	check(
		'an awaited upgrade hook sets the subprotocol through the context headers',
		proto.protocol === 'alpha',
		`got "${proto.protocol}"`
	);
	proto.close();

	// --- connection lifecycle ---------------------------------------------
	const a = client('?user=alice');
	await a.opened;
	const welcome = j(await a.next());
	check('welcome frame carries a sessionId', welcome.type === 'welcome' && typeof welcome.sessionId === 'string', JSON.stringify(welcome));

	const opened = j(await a.next());
	check('open hook ran and sees userData from the upgrade hook', opened.data?.user === 'alice', JSON.stringify(opened));
	check('platform.connections counts the live connection', opened.data?.connections === 1, JSON.stringify(opened.data));

	// --- subscribe / ack ---------------------------------------------------
	a.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 7 }));
	const subAck = j(await a.next());
	check('subscribe acks with the client ref', subAck.type === 'subscribed' && subAck.ref === 7 && subAck.topic === 'room', JSON.stringify(subAck));
	check('subscribed ack carries the seq-space epoch', typeof subAck.epoch === 'number', JSON.stringify(subAck));

	a.send(JSON.stringify({ type: 'subscribe', topic: 'forbidden', ref: 8 }));
	const denyAck = j(await a.next());
	check('the app subscribe hook can deny a topic', denyAck.type === 'subscribe-denied' && denyAck.reason === 'FORBIDDEN', JSON.stringify(denyAck));

	a.send(JSON.stringify({ type: 'subscribe', topic: '__internal', ref: 9 }));
	const sysAck = j(await a.next());
	check('system __ topics are refused by default', sysAck.type === 'subscribe-denied' && sysAck.reason === 'INVALID_TOPIC', JSON.stringify(sysAck));

	a.send(JSON.stringify({ type: 'subscribe', topic: 'bad"topic', ref: 10 }));
	const badAck = j(await a.next());
	check('a topic that would corrupt an envelope is refused', badAck.type === 'subscribe-denied' && badAck.reason === 'INVALID_TOPIC', JSON.stringify(badAck));

	// --- fan-out -----------------------------------------------------------
	const b = client('?user=bob');
	await b.opened;
	await b.next(); // welcome
	await b.next(); // opened
	b.send(JSON.stringify({ type: 'subscribe', topic: 'room', ref: 1 }));
	await b.next(); // subscribed

	b.send(JSON.stringify({ type: 'fixture-publish', topic: 'room', data: { hello: 'world' } }));
	const fanA = j(await a.next());
	const fanB = j(await b.next());
	check('publish reaches every subscriber', fanA.topic === 'room' && fanA.event === 'said' && fanA.data.hello === 'world', JSON.stringify(fanA));
	check('publish reaches the publishing connection too (server.publish)', fanB.topic === 'room', JSON.stringify(fanB));
	check('{seq:true} stamps a sequence number', typeof fanA.seq === 'number' && fanA.seq >= 1, JSON.stringify(fanA));

	// --- observability -----------------------------------------------------
	a.send(JSON.stringify({ type: 'fixture-stats', topic: 'room' }));
	const stats = j(await a.next());
	check('platform.subscribers reads native membership', stats.data.subscribers === 2, JSON.stringify(stats.data));
	check('platform.connections sees both sockets', stats.data.connections === 2, JSON.stringify(stats.data));
	check('platform.maxPayloadLength reports the configured cap', stats.data.maxPayloadLength === 1048576, JSON.stringify(stats.data));
	check('platform.bufferedAmount is readable on a healthy socket', stats.data.buffered === 0, JSON.stringify(stats.data));

	// --- the SSR request path carries the same platform --------------------
	const httpPub = await fetch(`http://127.0.0.1:${PORT}/publish?topic=room`, { method: 'POST' });
	const httpBody = await httpPub.json();
	check('an SSR route can publish to websocket clients', httpBody.delivered === true, JSON.stringify(httpBody));
	check('the SSR platform still carries requestId', typeof httpBody.requestId === 'string', JSON.stringify(httpBody));
	check('the SSR platform sees live connections', httpBody.connections === 2, JSON.stringify(httpBody));
	const fromHttp = j(await a.next());
	check('the frame published from HTTP arrives on the socket', fromHttp.event === 'from-http' && fromHttp.data.via === 'ssr', JSON.stringify(fromHttp));
	await b.next(); // drain b's copy so later assertions stay aligned

	// --- unsubscribe -------------------------------------------------------
	a.send(JSON.stringify({ type: 'unsubscribe', topic: 'room', ref: 11 }));
	const unsubHook = j(await a.next());
	check('the app unsubscribe hook fires', unsubHook.event === 'unsubscribe-hook' && unsubHook.data.topic === 'room', JSON.stringify(unsubHook));
	const unsubAck = j(await a.next());
	check('unsubscribe acks with the ref', unsubAck.type === 'unsubscribed' && unsubAck.ref === 11, JSON.stringify(unsubAck));

	a.send(JSON.stringify({ type: 'fixture-stats', topic: 'room' }));
	const stats2 = j(await a.next());
	check('unsubscribe drops native membership', stats2.data.subscribers === 1, JSON.stringify(stats2.data));

	// --- pass-through and framing -----------------------------------------
	a.send('just text');
	check('a non-control text frame reaches the app hook', (await a.next()) === 'just text');

	a.send(new Uint8Array([1, 2, 3]).buffer);
	const echoed = await a.next();
	check('a binary frame round-trips as binary', echoed instanceof ArrayBuffer && new Uint8Array(echoed)[2] === 3, String(echoed));

	const huge = JSON.stringify({ type: 'subscribe', topic: 'x'.repeat(9000) });
	a.send(huge);
	const tooLarge = j(await a.next());
	check('an oversized control frame is rejected explicitly',
		tooLarge.type === 'error' && tooLarge.code === 'CONTROL_FRAME_TOO_LARGE', JSON.stringify(tooLarge));
	check('the refusal uses the field names the family client gates on',
		typeof tooLarge.code === 'string' && typeof tooLarge.limit === 'number' && typeof tooLarge.size === 'number',
		JSON.stringify(tooLarge));

	// An oversized APPLICATION frame that merely begins {"ty must reach the app
	// hook, not be swallowed by the control-frame guard.
	const bigApp = JSON.stringify({ type: 'fixture-echo-big', pad: 'p'.repeat(9000) });
	a.send(bigApp);
	check('an oversized app frame beginning {"ty still reaches the app hook', (await a.next()) === bigApp);

	// A subscribe-batch is answered PER ENTRY, with the same frames a single
	// subscribe produces. The family client keys its denial store and its
	// per-topic epochs off those frames and re-subscribes everything as a batch
	// on reconnect, so a summary frame it does not recognise silently loses
	// every denial. The amplification that per-entry acks imply is bounded by
	// the per-connection control-egress budget instead, not by the protocol.
	a.send(JSON.stringify({ type: 'subscribe-batch', topics: Array.from({ length: 256 }, (_, i) => 't' + i), ref: 12 }));
	let acks = 0;
	const reasons = new Set();
	let untopiced = 0;
	for (let i = 0; i < 256; i++) {
		const f = j(await a.next());
		// A reply the client cannot key by topic is one the family client
		// discards on `typeof msg.topic === 'string'`, silently.
		if (typeof f.topic !== 'string') untopiced++;
		if (f.type === 'subscribe-denied') reasons.add(f.reason);
		acks++;
	}
	check('a full subscribe-batch answers every entry', acks === 256, `acked ${acks}`);
	check('every per-entry answer names its topic', untopiced === 0, `${untopiced} unnamed`);
	check('the per-entry frames are the ones the family client understands',
		reasons.size === 0 || [...reasons].every((r) => typeof r === 'string'), [...reasons].join(','));

	// One entry past the limit is refused WHOLE, in one frame. The reply must
	// not scale with the inbound frame: a maximal frame of two-byte entries
	// answered per entry is 800KB of egress bought with 8KB of input.
	a.send(JSON.stringify({ type: 'subscribe-batch', topics: Array.from({ length: 257 }, (_, i) => 'x' + i), ref: 13 }));
	const refused = j(await a.next());
	check('an oversized batch is refused with a single frame',
		refused.type === 'error' && refused.code === 'BATCH_TOO_LARGE', JSON.stringify(refused));
	check('the refusal reports the limit and what arrived',
		refused.limit === 256 && refused.size === 257, JSON.stringify(refused));
	// PEEK for silence after giving anything in flight time to land - never
	// await a timeout, which swallows the next frame and desynchronizes
	// every assertion after it.
	await Bun.sleep(200);
	check('no entry of an oversized batch was applied', a.pending() === 0, `${a.pending()} queued`);

	// And the refusal does not depend on a ref: it is the client learning its
	// frame did nothing, not an ack.
	a.send(JSON.stringify({ type: 'subscribe-batch', topics: Array.from({ length: 300 }, (_, i) => 'y' + i) }));
	const refusedNoRef = j(await a.next());
	check('an oversized batch is refused even with no ref',
		refusedNoRef.code === 'BATCH_TOO_LARGE' && refusedNoRef.size === 300, JSON.stringify(refusedNoRef));

	// --- close bookkeeping -------------------------------------------------
	b.close();
	await Bun.sleep(200);
	a.send(JSON.stringify({ type: 'fixture-stats', topic: 'room' }));
	const stats3 = j(await a.next());
	check('closing a connection deregisters it', stats3.data.connections === 1, JSON.stringify(stats3.data));
	check('closing drops that connection subscriptions', stats3.data.subscribers === 0, JSON.stringify(stats3.data));

	// --- managed drain -----------------------------------------------------
	// An async filter must advise NOBODY. A Promise is truthy, so treating it
	// as a verdict would drain every connection on the node - the opposite of
	// what a caller filtering for one tenant asked for.
	const asyncDrain = await (await fetch(`http://127.0.0.1:${PORT}/drain?async=1`, { method: 'POST' })).json();
	check('adviseReconnect fails CLOSED on an async filter', asyncDrain.advised === 0, JSON.stringify(asyncDrain));

	const drainClient = client('?user=drainee');
	await drainClient.opened;
	await drainClient.next(); // welcome
	await drainClient.next(); // opened
	const drainClosed = new Promise((resolve) => { drainClient.onclose = (e) => resolve({ code: e.code, reason: e.reason }); });
	const drained = await (await fetch(`http://127.0.0.1:${PORT}/drain?windowMs=50`, { method: 'POST' })).json();
	check('adviseReconnect advises the live connections', drained.advised >= 1, JSON.stringify(drained));
	const advisory = j(await drainClient.next());
	check('the client is told to reconnect on a jittered window',
		advisory.type === 'reconnect' && advisory.windowMs === 50, JSON.stringify(advisory));
	const closeEvt = await Promise.race([
		drainClosed,
		new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 2000))
	]);
	check('the drained connection is then closed with a real code, not a 1006',
		closeEvt.code === 1012, JSON.stringify(closeEvt));

	// --- a release still in flight when the connection dies ----------------
	// The release happens BEFORE the app's unsubscribe hook is dispatched, and
	// it removes the topic from the subscription set the close hook is handed.
	// So a hook that has not finished when the socket dies is dropped, and
	// unless the topic is carried across some other way the app is never told
	// to release its per-topic state at all. `hang:` never settles, so this is
	// that case exactly.
	const hangClient = client('?user=hanger');
	await hangClient.opened;
	await hangClient.next(); // welcome
	await hangClient.next(); // opened
	hangClient.send(JSON.stringify({ type: 'subscribe', topic: 'hang:1', ref: 90 }));
	const hangSubbed = j(await hangClient.next());
	check('a hang topic subscribes normally', hangSubbed.type === 'subscribed', JSON.stringify(hangSubbed));
	hangClient.send(JSON.stringify({ type: 'unsubscribe', topic: 'hang:1', ref: 91 }));
	const hookFired = j(await hangClient.next());
	check('the unsubscribe hook ran for the released topic',
		hookFired.event === 'unsubscribe-hook', JSON.stringify(hookFired));
	hangClient.close();
	await Bun.sleep(250);

	a.close();
	await Bun.sleep(150);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err && err.message ? err.message : String(err)));
	console.log('FAIL  threw: ' + (err && err.stack ? err.stack : err));
} finally {
	proc.kill();
	const out = await new Response(proc.stdout).text();
	const errText = await new Response(proc.stderr).text();
	// Asserted from the server's own log because the close hook's view is the
	// thing under test, and no client can observe it.
	const hangClose = out.split('\n').find((line) => line.includes('[fixture] close') && line.includes('hang:1'));
	check('a release whose hook never finished still reaches the close hook',
		Boolean(hangClose), 'no close line named hang:1');
	if (failed > 0) {
		console.log('\n--- server stdout ---\n' + out.slice(-3000));
		if (errText.trim()) console.log('\n--- server stderr ---\n' + errText.slice(-3000));
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(failed === 0 ? 0 : 1);
