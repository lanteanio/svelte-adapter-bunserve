// Empirical probe of every Bun server API behavior this adapter's design
// relies on. Run with `bun probe/bun-api-facts.mjs`; it writes
// probe/bun-api-facts.report.md next to itself. The report is committed so a
// Bun upgrade that changes an observed behavior shows up as a diff.
//
// Design rules:
// - every probe is isolated: its own server on an ephemeral port, its own
//   clients, teardown in finally. One failing probe never blocks the rest.
// - probes record what was OBSERVED, never what was expected. Interpretation
//   happens in the adapter design docs, not here.
// - anything that cannot be probed automatically (e.g. TLS SNI without certs)
//   is recorded as MANUAL so the report stays a complete checklist.

import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof Bun === 'undefined') {
	console.error('This probe must run under Bun: bun probe/bun-api-facts.mjs');
	process.exit(1);
}

const findings = [];
const HOST = '127.0.0.1';

function record(section, question, observed) {
	findings.push({ section, question, observed: String(observed) });
	console.log(`[${section}] ${question}\n    -> ${observed}`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
	let timer;
	const guard = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Open a browser-style WebSocket client and resolve once connected.
function openClient(server, { protocols, path = '/' } = {}) {
	return withTimeout(new Promise((resolve, reject) => {
		const url = `ws://${HOST}:${server.port}${path}`;
		const client = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
		client.binaryType = 'arraybuffer';
		client.addEventListener('open', () => resolve(client));
		client.addEventListener('error', (e) => reject(new Error(`client error: ${e.message || 'unknown'}`)));
	}), 3000, 'client open');
}

function closeEvent(client) {
	return withTimeout(new Promise((resolve) => {
		client.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason, wasClean: e.wasClean }));
	}), 4000, 'client close event');
}

// A serve() wrapper that hands the probe the first server-side socket.
function serveWs(wsOptions = {}, serveOptions = {}) {
	let resolveWs;
	const firstWs = new Promise((resolve) => { resolveWs = resolve; });
	const state = { messages: [], closes: [], drains: 0, sockets: [] };
	const server = Bun.serve({
		hostname: HOST,
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req, { data: { probe: true } })) return undefined;
			return new Response('not a websocket request', { status: 400 });
		},
		websocket: {
			open(ws) { state.sockets.push(ws); resolveWs(ws); },
			message(ws, message) { state.messages.push(message); },
			drain() { state.drains++; },
			close(ws, code, reason) { state.closes.push({ code, reason }); },
			...wsOptions
		},
		...serveOptions
	});
	return { server, firstWs: () => withTimeout(firstWs, 3000, 'server-side open'), state };
}

function describeValue(v) {
	if (v === undefined) return 'undefined';
	if (v === null) return 'null';
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return `${typeof v}(${String(v).slice(0, 60)})`;
}

function callAndDescribe(fn) {
	try {
		return `returned ${describeValue(fn())}`;
	} catch (err) {
		return `THREW ${err.constructor?.name || 'Error'}: ${String(err.message).slice(0, 120)}`;
	}
}

// ---------------------------------------------------------------------------

async function probeSendReturnCodes() {
	const section = 'send-return-codes';
	const { server, firstWs, state } = serveWs({}, {});
	try {
		const client = await openClient(server);
		const ws = await firstWs();

		record(section, 'send("ping") on an open socket returns', describeValue(ws.send('ping')));
		record(section, 'send(64-byte binary) on an open socket returns', describeValue(ws.send(new Uint8Array(64))));

		// Zero-length payloads, while the socket is still open and unburdened:
		// "bytes accepted" for zero bytes could plausibly be 0, which the
		// send-result mapping reads as DROPPED - and the facade routes
		// app-supplied payloads through that mapping, so the edge is reachable
		// from userland (`ws.send('')`). Delivery is recorded alongside the
		// return value because they answer different questions: a delivered
		// empty frame with return 0 means the mapping misreports it as dropped.
		const emptyFrames = [];
		client.addEventListener('message', (e) => {
			const len = typeof e.data === 'string' ? e.data.length : e.data.byteLength;
			if (len === 0) emptyFrames.push(typeof e.data === 'string' ? 'text' : 'binary');
		});
		record(section, 'send("") on an open unburdened socket returns', describeValue(ws.send('')));
		record(section, 'getBufferedAmount() right after that empty send', callAndDescribe(() => ws.getBufferedAmount()));
		record(section, 'send(0-byte binary) on an open unburdened socket returns', describeValue(ws.send(new Uint8Array(0))));
		await sleep(200);
		record(section, 'zero-length frames the client actually RECEIVED from those two sends', JSON.stringify(emptyFrames));

		// Backpressure: a synchronous burst of 1 MiB frames cannot be drained
		// mid-loop (client shares this event loop), so the socket buffer fills
		// within a few iterations. Record every distinct return value.
		const big = new Uint8Array(1 << 20);
		const seen = new Map();
		for (let i = 0; i < 64; i++) {
			const r = ws.send(big);
			if (!seen.has(r)) seen.set(r, i);
			if (seen.size >= 3) break;
		}
		record(section, 'distinct send() return values during a 1MiB-frame burst (value -> first iteration)',
			[...seen.entries()].map(([v, i]) => `${describeValue(v)} @ ${i}`).join(', '));
		record(section, 'getBufferedAmount() right after the burst', callAndDescribe(() => ws.getBufferedAmount()));

		// A FRESH, unburdened connection for the closed-socket send record - the
		// burst socket above still holds megabytes of backlog, which would
		// confound "closed" with "past the backpressure limit".
		const client2 = await openClient(server);
		await withTimeout((async () => { while (state.sockets.length < 2) await sleep(10); })(), 3000, 'second server socket');
		const ws2 = state.sockets[1];
		client2.close();
		await sleep(150);
		record(section, 'readyState of the fresh socket after its client closed', callAndDescribe(() => ws2.readyState));
		record(section, 'send("late") on that fresh client-closed socket returns', callAndDescribe(() => ws2.send('late')));
	} finally {
		server.stop(true);
	}
}

async function probeBackpressureLimitAndDrain() {
	const section = 'backpressure-limit';
	const { server, firstWs, state } = serveWs({ backpressureLimit: 64 * 1024, closeOnBackpressureLimit: false });
	try {
		const client = await openClient(server);
		const ws = await firstWs();
		// Zero-length delivery across the saturated window, for the send-result
		// mapping's empty-payload case: whether an empty frame sent PAST the
		// backpressure limit is dropped like a real frame or slips through.
		const emptyFrames = [];
		client.addEventListener('message', (e) => {
			const len = typeof e.data === 'string' ? e.data.length : e.data.byteLength;
			if (len === 0) emptyFrames.push('empty');
		});
		const big = new Uint8Array(1 << 20);
		const results = [];
		for (let i = 0; i < 16; i++) results.push(ws.send(big));
		record(section, 'send() results with backpressureLimit=64KiB during a 16x1MiB burst',
			[...new Set(results.map(describeValue))].join(', '));
		record(section, 'send("") on the socket while it is past the backpressure limit returns', describeValue(ws.send('')));
		await sleep(400); // let the client drain
		record(section, 'drain() handler invocations after the burst settled', state.drains);
		record(section, 'getBufferedAmount() after settle', callAndDescribe(() => ws.getBufferedAmount()));
		record(section, 'zero-length frames the client received after the drain settled', JSON.stringify(emptyFrames));
	} finally {
		server.stop(true);
	}
}

async function probePublish() {
	const section = 'publish';
	const { server, firstWs } = serveWs({
		open(ws) { ws.subscribe('room'); if (!server.__first) { server.__first = ws; server.__resolve?.(ws); } }
	});
	// serveWs's open override above replaces the default resolver, so capture manually.
	server.__resolve = null;
	const first = new Promise((resolve) => { server.__resolve = resolve; });
	try {
		const clientA = await openClient(server);
		const clientB = await openClient(server);
		const wsA = await withTimeout(first, 3000, 'first server socket');

		const gotA = [];
		const gotB = [];
		clientA.addEventListener('message', (e) => gotA.push(e.data));
		clientB.addEventListener('message', (e) => gotB.push(e.data));

		record(section, 'server.publish("room", "hello") returns', describeValue(server.publish('room', 'hello')));
		record(section, 'server.publish to a topic with zero subscribers returns', describeValue(server.publish('empty-room', 'x')));
		await sleep(150);
		record(section, 'subscriber count that received the server.publish', `${gotA.length > 0 ? 'A' : ''}${gotB.length > 0 ? 'B' : ''} (A=${gotA.length}, B=${gotB.length})`);

		gotA.length = 0; gotB.length = 0;
		record(section, 'wsA.publish("room", "from-A") returns', callAndDescribe(() => wsA.publish('room', 'from-A')));
		await sleep(150);
		record(section, 'default publishToSelf: did the publishing socket receive its own ws.publish?', `A=${gotA.length}, B=${gotB.length}`);

		record(section, 'ws.isSubscribed("room") on the open socket', callAndDescribe(() => wsA.isSubscribed('room')));

		// The per-topic membership count platform.subscribers() reports. uWS
		// spells this app.numSubscribers(); the question is whether Bun's
		// equivalent is a live native count (so it sees memberships created by
		// a raw ws.subscribe the adapter never brokered) or absent entirely.
		record(section, 'typeof server.subscriberCount', typeof server.subscriberCount);
		record(section, 'server.subscriberCount("room") with both sockets subscribed', callAndDescribe(() => server.subscriberCount('room')));
		record(section, 'server.subscriberCount on a topic nobody subscribed', callAndDescribe(() => server.subscriberCount('empty-room')));
		wsA.unsubscribe('room');
		record(section, 'server.subscriberCount("room") after one unsubscribe', callAndDescribe(() => server.subscriberCount('room')));
	} finally {
		server.stop(true);
	}
}

async function probeWireTransport() {
	const section = 'wire-transport';
	const { server, firstWs } = serveWs();
	try {
		const client = await openClient(server);
		const ws = await firstWs();

		// Cohort topics embed a NUL byte ('room\0bin') so they can never collide
		// with a user topic. That only works if Bun's native topic registry
		// treats the NUL as an ordinary character end to end.
		const nulTopic = 'room\0bin';
		record(section, 'ws.subscribe on a topic containing a NUL byte returns', callAndDescribe(() => ws.subscribe(nulTopic)));
		record(section, 'ws.isSubscribed on the NUL topic', callAndDescribe(() => ws.isSubscribed(nulTopic)));
		record(section, 'server.subscriberCount on the NUL topic', callAndDescribe(() => server.subscriberCount(nulTopic)));

		const gotText = [];
		const gotBinary = [];
		client.addEventListener('message', (e) => {
			if (typeof e.data === 'string') gotText.push(e.data);
			else gotBinary.push(new Uint8Array(e.data));
		});

		// Binary payloads through the native fan-out: the wire tier publishes
		// prebuilt 0x03 frames to cohort topics with server.publish.
		const frame = new Uint8Array([0x03, 1, 5, 42, 7, 7, 7]);
		record(section, 'server.publish(NUL topic, 7-byte binary) returns', callAndDescribe(() => server.publish(nulTopic, frame)));
		record(section, 'server.publish(NUL topic, "text") returns', callAndDescribe(() => server.publish(nulTopic, 'text-on-nul-topic')));
		record(section, 'server.publish(NUL topic, binary, compress=true) returns', callAndDescribe(() => server.publish(nulTopic, frame, true)));
		await sleep(200);
		record(
			section,
			'what the NUL-topic subscriber received (binary frames byte-exact / text frames)',
			`binary=${gotBinary.length} byteExact=${gotBinary.every((b) => b.length === frame.length && b.every((v, i) => v === frame[i]))}, text=${JSON.stringify(gotText)}`
		);

		record(section, 'ws.unsubscribe on the NUL topic returns', callAndDescribe(() => ws.unsubscribe(nulTopic)));
		record(section, 'server.subscriberCount on the NUL topic after unsubscribe', callAndDescribe(() => server.subscriberCount(nulTopic)));
	} finally {
		server.stop(true);
	}
}

async function probeCloseVsTerminate() {
	const section = 'close-vs-terminate';
	{
		const { server, firstWs } = serveWs();
		try {
			const client = await openClient(server);
			const ws = await firstWs();
			const closed = closeEvent(client);
			ws.close(4001, 'probe-close');
			const evt = await closed;
			record(section, 'client close event after server ws.close(4001, "probe-close")', JSON.stringify(evt));
		} finally { server.stop(true); }
	}
	{
		const { server, firstWs } = serveWs();
		try {
			const client = await openClient(server);
			const ws = await firstWs();
			const closed = closeEvent(client);
			record(section, 'ws.terminate exists', typeof ws.terminate);
			if (typeof ws.terminate === 'function') {
				ws.terminate();
				const evt = await closed;
				record(section, 'client close event after server ws.terminate()', JSON.stringify(evt));
			}
		} finally { server.stop(true); }
	}
	// Only 4001 was ever exercised here. The drain path wants a STANDARD code,
	// and some WebSocket stacks refuse to send codes they consider reserved -
	// which would throw inside the drain after the advisory frame was already
	// delivered, leaving connections advised but never closed.
	for (const code of [1001, 1012]) {
		const { server, firstWs } = serveWs();
		try {
			const client = await openClient(server);
			const ws = await firstWs();
			const closed = closeEvent(client);
			const sendResult = callAndDescribe(() => ws.close(code, 'draining'));
			record(section, `ws.close(${code}, "draining") on the server`, sendResult);
			try {
				record(section, `client close event after ws.close(${code})`, JSON.stringify(await closed));
			} catch (err) {
				record(section, `client close event after ws.close(${code})`, `NO CLOSE EVENT: ${err.message}`);
			}
		} finally { server.stop(true); }
	}
	// The pairs the spec calls unsendable, plus a reason one byte over the
	// 123-byte cap. What the runtime does with them decides what a facade may
	// pass through from a caller: observed across generations, an unchecked
	// pair reaches the client verbatim, surfaces client-side as a 1002
	// protocol error, is silently rewritten to a different code, or has its
	// reason truncated - and which of those depends on the code and the
	// runtime version, with a throw at the call the documented direction of
	// travel. That spread is why the facade clamps instead.
	for (const [code, reason, label] of [
		[999, 'x', 'code below the range'],
		[1005, 'x', 'code reserved for no-status'],
		[5000, 'x', 'code above the range'],
		[4000, 'r'.repeat(124), 'reason one byte over the cap']
	]) {
		const { server, firstWs } = serveWs();
		try {
			const client = await openClient(server);
			const ws = await firstWs();
			const closed = closeEvent(client);
			const call = callAndDescribe(() => ws.close(code, reason));
			record(section, `ws.close with ${label} on the server`, call);
			try {
				const evt = await closed;
				record(
					section,
					`client close event after the ${label}`,
					JSON.stringify({
						code: evt.code,
						reasonBytes: new TextEncoder().encode(evt.reason).length,
						wasClean: evt.wasClean
					})
				);
			} catch (err) {
				record(section, `client close event after the ${label}`, `NO CLOSE EVENT: ${err.message}`);
			}
		} finally { server.stop(true); }
	}
}

async function probePublishBackpressure() {
	const section = 'publish-backpressure';
	// platform.publish maps server.publish's return to a boolean "did anyone get
	// it". That is only sound if the return is a plain byte count. If publish
	// borrows send()'s -1 backpressure signal, a frame that WILL deliver reads
	// as "nobody received it", and a caller that falls back on false
	// double-delivers under exactly the load where it matters.
	// wsOptions merge INTO the handler set; passing them as serveOptions instead
	// replaces it wholesale and Bun refuses the server ("expects a message
	// handler").
	const { server, firstWs } = serveWs({ backpressureLimit: 64 * 1024, closeOnBackpressureLimit: false });
	try {
		const client = await openClient(server);
		const ws = await firstWs();
		ws.subscribe('room');
		// Do not read on the client, then burst far past the limit.
		const payload = 'x'.repeat(1024 * 1024);
		const seen = new Map();
		for (let i = 0; i < 24; i++) {
			const r = server.publish('room', payload);
			if (!seen.has(r)) seen.set(r, i);
		}
		record(section, 'distinct server.publish return values during a 24x1MiB burst (value -> first iteration)',
			[...seen.entries()].map(([v, i]) => `${v} @ ${i}`).join(', '));
		record(section, 'getBufferedAmount() on the subscriber right after the burst', callAndDescribe(() => ws.getBufferedAmount()));
		record(section, 'server.publish("room", "small") once the socket is saturated', callAndDescribe(() => server.publish('room', 'small')));
		client.close();
	} finally { server.stop(true); }
}

async function probeClosedSocketBehavior() {
	const section = 'closed-socket-behavior';
	const { server, firstWs, state } = serveWs();
	try {
		const client = await openClient(server);
		const ws = await firstWs();
		ws.subscribe('room');
		// Keep a SECOND, live subscriber on the topic so the closed-socket
		// publish record is not confounded with the zero-subscribers case -
		// and LISTEN on it, so delivery is observed at the client, not
		// inferred from a return code.
		const clientB = await openClient(server);
		const gotB = [];
		clientB.addEventListener('message', (e) => gotB.push(String(e.data)));
		await withTimeout((async () => { while (state.sockets.length < 2) await sleep(10); })(), 3000, 'second server socket');
		state.sockets[1].subscribe('room');
		client.close();
		await sleep(200);
		record(section, 'readyState on the dead server socket', callAndDescribe(() => ws.readyState));
		record(section, 'subscribe("t") on a closed socket', callAndDescribe(() => ws.subscribe('t')));
		record(section, 'unsubscribe("room") on a closed socket', callAndDescribe(() => ws.unsubscribe('room')));
		record(section, 'isSubscribed("room") on a closed socket', callAndDescribe(() => ws.isSubscribed('room')));
		record(section, 'getBufferedAmount() on a closed socket', callAndDescribe(() => ws.getBufferedAmount()));
		record(section, 'send("x") on a closed socket', callAndDescribe(() => ws.send('x')));
		// Multi-byte payload so a bytes-style return value is distinguishable
		// from a subscriber count ("from-closed" = 11 bytes).
		record(section, 'publish("room","from-closed") on a closed socket, with one LIVE subscriber on the topic', callAndDescribe(() => ws.publish('room', 'from-closed')));
		await sleep(200);
		record(section, 'frames the live subscriber actually RECEIVED from that closed-socket publish', JSON.stringify(gotB));
		clientB.close();
	} finally {
		server.stop(true);
	}
}

async function probePrototypePatch() {
	const section = 'prototype-patch';
	// The strategy under probe is "patch once at boot": acquire the prototype
	// via a first (throwaway) connection, stamp it, and expect the stamp to be
	// visible on sockets opened LATER, on a DIFFERENT server. Both properties
	// are probed, not assumed.
	const a = serveWs();
	const b = serveWs();
	try {
		await openClient(a.server);
		const wsA = await a.firstWs();
		const proto = Object.getPrototypeOf(wsA);
		record(section, 'prototype constructor name', proto?.constructor?.name ?? 'null prototype');
		record(section, 'prototype is extensible', Object.isExtensible(proto));
		try {
			proto.probeGetUserData = function () { return this.data; };
			record(section, 'stamped method resolves ws.data on the already-open socket', wsA.probeGetUserData?.() === wsA.data);
			// Only NOW open a socket on the second server - it must inherit the stamp.
			await openClient(b.server);
			const wsB = await b.firstWs();
			record(section, 'second server shares the same prototype object', Object.getPrototypeOf(wsB) === proto);
			record(section, 'socket opened AFTER the stamp, on the other server, sees the method', wsB.probeGetUserData?.() === wsB.data);
			delete proto.probeGetUserData;
		} catch (err) {
			record(section, 'prototype stamping', `THREW ${err.message}`);
		}
		record(section, 'ws.data holds the upgrade-time data object', JSON.stringify(wsA.data));
	} finally {
		a.server.stop(true);
		b.server.stop(true);
	}
}

async function probeIdleTimeoutCap() {
	const section = 'idle-timeout-cap';
	for (const value of [960, 961, 1200]) {
		try {
			const server = Bun.serve({
				hostname: HOST, port: 0,
				fetch(req, srv) { srv.upgrade(req); },
				websocket: { message() {}, idleTimeout: value }
			});
			server.stop(true);
			record(section, `Bun.serve accepts websocket.idleTimeout=${value}`, 'accepted');
		} catch (err) {
			record(section, `Bun.serve accepts websocket.idleTimeout=${value}`, `THREW: ${String(err.message).slice(0, 120)}`);
		}
	}
}

async function probeHttpIdleTimeout() {
	// The TOP-LEVEL idleTimeout, distinct from websocket.idleTimeout above. The
	// adapter does not set it, so whatever Bun defaults to is what ships - and
	// the question that decides whether that is safe is not the number but
	// whether a slow RESPONSE counts as idle. A streaming SSE endpoint that
	// emits less often than the timeout would be cut mid-stream, which is the
	// one failure this has to rule out before the option is wired.
	const section = 'http-idle-timeout';

	// A response that writes its first chunk immediately, then goes quiet for
	// `gapMs` before writing again. `idleTimeout: undefined` leaves Bun's own
	// default in place, which is the configuration the adapter actually ships.
	const serveSlowStream = (idleTimeout, gapMs) =>
		Bun.serve({
			hostname: HOST, port: 0,
			...(idleTimeout === undefined ? {} : { idleTimeout }),
			fetch() {
				const stream = new ReadableStream({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode('first\n'));
						await Bun.sleep(gapMs);
						controller.enqueue(new TextEncoder().encode('second\n'));
						controller.close();
					}
				});
				return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
			}
		});

	const streamCase = async (label, idleTimeout, gapMs) => {
		const server = serveSlowStream(idleTimeout, gapMs);
		try {
			const res = await fetch(`http://${HOST}:${server.port}/`);
			const body = await res.text().catch((err) => `CUT: ${err.message.slice(0, 60)}`);
			record(section, label, JSON.stringify(body));
		} catch (err) {
			record(section, label, `CUT: ${String(err.message).slice(0, 80)}`);
		} finally {
			server.stop(true);
		}
	};

	// THE ONE THAT DECIDES THE ADAPTER'S BEHAVIOUR: no idleTimeout set at all,
	// with an idle gap longer than Bun's documented 10s default. If this is cut,
	// every app streaming an SSE heartbeat slower than the default loses the
	// connection, and the adapter has to own the value rather than inherit it.
	// Every gap here is far from its timeout on purpose. An earlier version of
	// this probe compared a 2.2s gap against 1s and 2s timeouts and produced a
	// non-monotonic result that reproduced three times, then reversed when
	// unrelated code around it changed: at that margin it measures timer
	// granularity, not a contract. Near-boundary cases do not belong in a facts
	// report.
	await streamCase('DEFAULT (unset), stream idle 12s', undefined, 12_000);
	await streamCase('DEFAULT (unset), stream idle 2s', undefined, 2_000);
	await streamCase('idleTimeout=30s, stream idle 12s', 30, 12_000);
	await streamCase('idleTimeout=0, stream idle 12s', 0, 12_000);

	// The accepted range, so a configured value cannot fail at boot.
	for (const value of [0, 255, 256]) {
		try {
			const server = Bun.serve({ hostname: HOST, port: 0, idleTimeout: value, fetch: () => new Response('ok') });
			server.stop(true);
			record(section, `Bun.serve accepts idleTimeout=${value}`, 'accepted');
		} catch (err) {
			record(section, `Bun.serve accepts idleTimeout=${value}`, `THREW: ${String(err.message).slice(0, 120)}`);
		}
	}
}

async function probeMaxPayloadEnforcement() {
	const section = 'max-payload';
	const { server } = serveWs({ maxPayloadLength: 1024 });
	try {
		const client = await openClient(server);
		const closed = closeEvent(client);
		client.send(new Uint8Array(4096));
		const evt = await closed.catch((e) => ({ timeout: e.message }));
		record(section, 'client close event after sending 4KiB with maxPayloadLength=1024', JSON.stringify(evt));
	} finally {
		server.stop(true);
	}
}

async function probeMessageBufferLifetime() {
	const section = 'message-buffer-lifetime';
	let captured = null;
	let copy = null;
	let typeName = '';
	const { server } = serveWs({
		message(ws, message) {
			if (captured === null && typeof message !== 'string') {
				typeName = message?.constructor?.name ?? typeof message;
				captured = message;
				const view = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer ?? message, message.byteOffset ?? 0, message.byteLength);
				copy = view.slice();
			}
		}
	});
	try {
		const client = await openClient(server);
		const payload = new Uint8Array(256);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		client.send(payload);
		await sleep(100);
		record(section, 'binary message arrives as', typeName || 'no binary message captured');
		// Send more traffic so a transient/recycled buffer would be overwritten.
		for (let i = 0; i < 8; i++) client.send(new Uint8Array(256).fill(0xaa));
		await sleep(150);
		if (captured && copy) {
			const view = captured instanceof ArrayBuffer ? new Uint8Array(captured) : new Uint8Array(captured.buffer ?? captured, captured.byteOffset ?? 0, captured.byteLength);
			let mutated = view.length !== copy.length;
			if (!mutated) for (let i = 0; i < copy.length; i++) if (view[i] !== copy[i]) { mutated = true; break; }
			record(section, 'first buffer mutated after 8 subsequent messages (non-mutation is NOT proof of safety)', mutated);
		}
	} finally {
		server.stop(true);
	}
}

async function probeUpgradeFlow() {
	const section = 'upgrade-flow';
	const server = Bun.serve({
		hostname: HOST, port: 0,
		async fetch(req, srv) {
			await sleep(25); // deliberate await BEFORE upgrade
			const ok = srv.upgrade(req, {
				data: { late: true },
				headers: { 'x-probe-upgrade': 'yes' }
			});
			if (ok) return undefined;
			return new Response('upgrade refused', { status: 400 });
		},
		websocket: { message() {}, open(ws) { server.__ws = ws; } }
	});
	try {
		// Raw TCP client so the 101 response headers are inspectable.
		const headers = await withTimeout(new Promise((resolve, reject) => {
			let buffer = '';
			Bun.connect({
				hostname: HOST, port: server.port,
				socket: {
					open(socket) {
						socket.write(
							`GET / HTTP/1.1\r\nHost: ${HOST}:${server.port}\r\n` +
							'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
							'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
							'Sec-WebSocket-Version: 13\r\n\r\n'
						);
					},
					data(socket, chunk) {
						buffer += Buffer.from(chunk).toString('latin1');
						const end = buffer.indexOf('\r\n\r\n');
						if (end !== -1) { socket.end(); resolve(buffer.slice(0, end)); }
					},
					error(_, err) { reject(err); }
				}
			}).catch(reject);
		}), 4000, 'raw 101 response');
		record(section, 'await before server.upgrade() still upgrades', headers.startsWith('HTTP/1.1 101'));
		record(section, 'custom upgrade header present on the 101 response', /x-probe-upgrade:\s*yes/i.test(headers));
		record(section, 'raw 101 status line + headers', headers.split('\r\n').join(' | ').slice(0, 400));
	} finally {
		server.stop(true);
	}
}

async function probeUpgradeAbort() {
	const section = 'upgrade-abort';
	const seen = {};
	const server = Bun.serve({
		hostname: HOST, port: 0,
		async fetch(req, srv) {
			seen.isAbortSignal = req.signal instanceof AbortSignal;
			seen.abortedAtEntry = req.signal.aborted;
			const started = Bun.nanoseconds();
			let firedAfterMs = null;
			req.signal.addEventListener('abort', () => {
				firedAfterMs = Math.round((Bun.nanoseconds() - started) / 1e6);
			}, { once: true });
			// Stands in for an application upgrade hook, which may await freely.
			// The client hangs up partway through it.
			await sleep(300);
			seen.firedAfterMs = firedAfterMs;
			seen.abortedAfterHook = req.signal.aborted;
			seen.upgradeReturned = srv.upgrade(req, { data: {} });
			if (seen.upgradeReturned) return undefined;
			return new Response('not upgraded', { status: 400 });
		},
		websocket: { message() {}, open() { seen.openFired = true; } }
	});
	try {
		const socket = await Bun.connect({
			hostname: HOST, port: server.port,
			socket: {
				open(s) {
					s.write(
						`GET / HTTP/1.1\r\nHost: ${HOST}:${server.port}\r\n` +
						'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
						'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
						'Sec-WebSocket-Version: 13\r\n\r\n'
					);
				},
				data() {},
				error() {}
			}
		});
		await sleep(60);
		socket.end();
		await sleep(400);
		record(section, 'request.signal on an upgrade request is an AbortSignal', seen.isAbortSignal);
		record(section, 'and is not already aborted when fetch() is entered', seen.abortedAtEntry === false);
		record(
			section,
			'client hangs up 60ms into a 300ms hook: signal.aborted afterwards',
			seen.abortedAfterHook
		);
		// A bucket rather than the reading, because the raw number differs on
		// every run and this file is committed so that a CHANGE in behavior shows
		// up as a diff. What the adapter depends on is that the event arrives
		// promptly rather than at the end of the hook, so that is what is
		// recorded: a delay that grew to the hook's own length would move it.
		const delay = seen.firedAfterMs === null ? null : seen.firedAfterMs - 60;
		record(
			section,
			'delay from the hang-up to the abort event, bucketed',
			delay === null
				? 'never fired'
				: delay < 50 ? 'under 50ms' : delay < 200 ? 'under 200ms' : `${delay}ms`
		);
		record(
			section,
			'server.upgrade() on a request whose client already left',
			`returned ${describeValue(seen.upgradeReturned)}, open handler fired: ${seen.openFired === true}`
		);
	} finally {
		server.stop(true);
	}
}

async function probeUpgradeDispatchOrder() {
	const section = 'upgrade-dispatch-order';
	// WHEN the socket callbacks run relative to the upgrade call. The adapter's
	// permit accounting depends on this and on nothing else: whether `open` is
	// dispatched inside `server.upgrade()` decides whether a handshake may still
	// be holding the connection permit when a socket closes and releases it.
	const order = [];
	const seen = {};
	const server = Bun.serve({
		hostname: HOST, port: 0,
		fetch(req, srv) {
			req.signal.addEventListener('abort', () => { order.push('abort'); }, { once: true });
			order.push('before upgrade');
			try {
				seen.returned = srv.upgrade(req, { data: { probe: true } });
			} catch (err) {
				seen.threw = String(err).slice(0, 60);
			}
			order.push(`upgrade returned ${describeValue(seen.returned)}`);
			if (seen.returned) return undefined;
			return new Response('no', { status: 400 });
		},
		websocket: {
			open(ws) {
				order.push('open enters');
				// The app hook that turns a socket away: an unauthenticated
				// session, one socket per user, a full room.
				ws.close(4001, 'refused in open');
				order.push('open exits');
			},
			message() {},
			close(ws) {
				order.push('close');
				// Whether userData survives into the close callback, which is
				// where the adapter reads the marker saying who owns the permit.
				try {
					seen.dataReadableInClose = ws.data && ws.data.probe === true;
				} catch {
					seen.dataReadableInClose = 'threw';
				}
			}
		}
	});
	try {
		const client = new WebSocket(`ws://${HOST}:${server.port}/`);
		await withTimeout(new Promise((resolve) => {
			client.addEventListener('close', resolve);
			client.addEventListener('error', resolve);
		}), 4000, 'close-in-open client').catch(() => undefined);
		await sleep(100);
		record(section, 'order of events around server.upgrade() when `open` closes its socket', order.join(' -> '));
		record(section, 'server.upgrade() return value when the socket closed inside `open`', describeValue(seen.returned));
		record(section, 'userData still readable in the close callback', describeValue(seen.dataReadableInClose));
	} finally {
		server.stop(true);
	}

	// An `open` that THROWS, which is the other way an adapter's post-upgrade
	// bookkeeping can be reached by a callback it did not expect to have run.
	const thrown = { returned: null, closeFired: false, escaped: false };
	const server2 = Bun.serve({
		hostname: HOST, port: 0,
		fetch(req, srv) {
			try {
				thrown.returned = srv.upgrade(req, { data: {} });
			} catch {
				thrown.escaped = true;
			}
			if (thrown.returned) return undefined;
			return new Response('no', { status: 400 });
		},
		websocket: {
			open() { throw new Error('the open hook threw'); },
			message() {},
			close() { thrown.closeFired = true; }
		}
	});
	try {
		const client = new WebSocket(`ws://${HOST}:${server2.port}/`);
		await withTimeout(new Promise((resolve) => {
			client.addEventListener('close', resolve);
			client.addEventListener('error', resolve);
		}), 4000, 'throwing-open client').catch(() => undefined);
		await sleep(100);
		record(
			section,
			'an `open` handler that throws: does it escape server.upgrade()',
			`escaped: ${thrown.escaped}, upgrade returned ${describeValue(thrown.returned)}, ` +
			`close handler fired: ${thrown.closeFired}`
		);
	} finally {
		server2.stop(true);
	}
}

async function probeUpgradeHeaderValues() {
	const section = 'header-values';
	// Where the runtime draws its own line on a 101 header value, which decides
	// what the adapter's validator has to catch itself rather than what it can
	// leave to a throw. Each case gets its own server: a throw here is the
	// observation, and a shared server would carry one case's socket into the
	// next.
	for (const [label, value] of [
		['printable ASCII', 'plain'],
		['accented Latin-1 (an ordinary name)', 'José'],
		['above Latin-1 (an emoji)', '\u{1F600}'],
		['CR LF (the response-splitting set)', 'a\r\nx-injected: 1'],
		['NUL', 'a b']
	]) {
		const seen = { threw: false, returned: null, open: false };
		const server = Bun.serve({
			hostname: HOST, port: 0,
			fetch(req, srv) {
				try {
					seen.returned = srv.upgrade(req, { data: {}, headers: { 'x-probe': value } });
				} catch {
					seen.threw = true;
					return new Response('threw', { status: 500 });
				}
				if (seen.returned) return undefined;
				return new Response('no', { status: 400 });
			},
			websocket: { open() { seen.open = true; }, message() {}, close() {} }
		});
		try {
			const client = new WebSocket(`ws://${HOST}:${server.port}/`);
			await withTimeout(new Promise((resolve) => {
				client.addEventListener('open', () => { client.close(); });
				client.addEventListener('close', resolve);
				client.addEventListener('error', resolve);
			}), 3000, `header value: ${label}`).catch(() => undefined);
			await sleep(50);
			record(
				section,
				`server.upgrade() with a header value containing ${label}`,
				seen.threw ? 'throws' : `upgrades (returned ${describeValue(seen.returned)})`
			);
		} finally {
			server.stop(true);
		}
	}
}

async function probeSubprotocolSelection() {
	const section = 'subprotocol';
	const server = Bun.serve({
		hostname: HOST, port: 0,
		fetch(req, srv) {
			const offered = req.headers.get('sec-websocket-protocol') || '';
			record(section, 'sec-websocket-protocol header as seen in fetch()', offered || '(absent)');
			const ok = srv.upgrade(req, { headers: { 'sec-websocket-protocol': 'alpha' } });
			if (ok) return undefined;
			return new Response('no', { status: 400 });
		},
		websocket: { message() {} }
	});
	try {
		const client = await openClient(server, { protocols: ['alpha', 'beta'] });
		record(section, 'client.protocol after server selected "alpha" via upgrade headers', JSON.stringify(client.protocol));
		client.close();
	} catch (err) {
		record(section, 'subprotocol selection via upgrade headers', `FAILED: ${err.message}`);
	} finally {
		server.stop(true);
	}
}

async function probeRoutesOption() {
	const section = 'routes-option';
	try {
		const server = Bun.serve({
			hostname: HOST, port: 0,
			routes: { '/ping': new Response('pong') },
			fetch() { return new Response('fallback'); }
		});
		try {
			const body = await withTimeout(fetch(`http://${HOST}:${server.port}/ping`).then((r) => r.text()), 3000, 'routes fetch');
			record(section, 'static routes entry served /ping', JSON.stringify(body));
			const fallback = await withTimeout(fetch(`http://${HOST}:${server.port}/other`).then((r) => r.text()), 3000, 'fallback fetch');
			record(section, 'fetch() fallback still serves unrouted paths', JSON.stringify(fallback));
		} finally {
			server.stop(true);
		}
	} catch (err) {
		record(section, 'Bun.serve accepts a routes option', `THREW: ${String(err.message).slice(0, 120)}`);
	}
}

async function probeStopDrain() {
	const section = 'stop-drain';
	{
		const server = Bun.serve({
			hostname: HOST, port: 0,
			async fetch(req, srv) {
				if (new URL(req.url).pathname === '/slow') { await sleep(300); return new Response('slow-done'); }
				if (srv.upgrade(req)) return undefined;
				return new Response('ok');
			},
			// Echo server, so functional liveness after stop() is measurable as a
			// round-trip rather than inferred from the absence of a close event.
			websocket: { message(ws, m) { ws.send(m); } }
		});
		try {
			const client = await openClient(server);
			const clientClosed = closeEvent(client).catch((e) => ({ timeout: e.message }));
			const inflight = fetch(`http://${HOST}:${server.port}/slow`).then((r) => r.text()).catch((e) => `REJECTED: ${e.message}`);
			await sleep(50);
			server.stop(); // graceful
			record(section, 'in-flight request outcome across graceful stop()', JSON.stringify(await withTimeout(inflight, 4000, 'inflight')));
			const echo = withTimeout(new Promise((resolve) => {
				client.addEventListener('message', (e) => resolve(String(e.data)), { once: true });
			}), 1500, 'post-stop echo').catch((e) => `NO ECHO: ${e.message}`);
			client.send('rt-probe');
			record(section, 'echo round-trip over the open WebSocket AFTER graceful stop()', JSON.stringify(await echo));
			const evt = await clientClosed;
			record(section, 'open WebSocket close event across graceful stop() (waited up to 4s)', JSON.stringify(evt));
		} finally {
			server.stop(true);
		}
	}
	{
		const server = Bun.serve({
			hostname: HOST, port: 0,
			fetch(req, srv) { if (srv.upgrade(req)) return undefined; return new Response('ok'); },
			websocket: { message() {} }
		});
		const client = await openClient(server);
		const clientClosed = closeEvent(client).catch((e) => ({ timeout: e.message }));
		server.stop(true); // hard
		record(section, 'open WebSocket outcome across stop(true)', JSON.stringify(await clientClosed));
	}
}

async function probeServeOptionAcceptance() {
	const section = 'serve-options';
	for (const [label, options] of [
		['reusePort: true', { reusePort: true }],
		['websocket.perMessageDeflate: true', { websocket: { message() {}, perMessageDeflate: true } }],
		['websocket.perMessageDeflate: { compress: true, decompress: true }', { websocket: { message() {}, perMessageDeflate: { compress: true, decompress: true } } }],
		['websocket.sendPings: false', { websocket: { message() {}, sendPings: false } }],
		['websocket.publishToSelf: true', { websocket: { message() {}, publishToSelf: true } }],
		['maxRequestBodySize: 1048576', { maxRequestBodySize: 1048576 }]
	]) {
		try {
			const server = Bun.serve({
				hostname: HOST, port: 0,
				fetch() { return new Response('ok'); },
				websocket: { message() {} },
				...options
			});
			server.stop(true);
			record(section, `Bun.serve accepts ${label}`, 'accepted');
		} catch (err) {
			record(section, `Bun.serve accepts ${label}`, `THREW: ${String(err.message).slice(0, 120)}`);
		}
	}
	record(section, 'TLS surface (SNI, multiple certs, passphrase)', 'MANUAL - needs real certificates; probe before claiming TLS parity');
}

async function probeCloseUnderBackpressure() {
	// The close-vs-terminate section above closes a HEALTHY socket. This one
	// asks the question the adapter actually depends on: does a close code
	// survive a socket that is past its backpressure limit? The resume lane
	// closes with a specific code exactly when a control frame was refused,
	// and a refusal means saturation - so if the code does not survive that
	// state, the code is not what the client classifies on and no
	// documentation may promise that it is.
	const section = 'close-under-backpressure';
	const CODE = 1013;
	const FRAME = new Uint8Array(1024 * 1024);

	/**
	 * Close one socket with CODE, optionally after filling it, and report what
	 * the client's close event carried.
	 *
	 * @param {boolean} saturate
	 */
	const closeCase = (saturate) => new Promise((resolve) => {
		/** @type {any} */
		let observed = {};
		const server = Bun.serve({
			hostname: HOST, port: 0,
			fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no')),
			websocket: {
				maxBackpressure: 64 * 1024,
				open(ws) {
					/** @type {number[]} */
					const codes = [];
					// Bounded: a socket that will not saturate must end the probe
					// rather than push until something else gives.
					for (let i = 0; saturate && i < 64; i++) {
						const r = ws.send(FRAME, true);
						if (!codes.includes(r)) codes.push(r);
						if (codes.includes(0) && codes.includes(-1)) break;
					}
					observed.sendResults = codes;
					observed.buffered = ws.getBufferedAmount();
					ws.close(CODE, 'probe-close');
				},
				message() {}
			}
		});
		const ws = new WebSocket(`ws://${HOST}:${server.port}/`);
		ws.binaryType = 'arraybuffer';
		ws.addEventListener('close', (e) => {
			const label = saturate
				? `client close event after ws.close(${CODE}) on a socket past its backpressure limit`
				: `client close event after ws.close(${CODE}) on a healthy socket`;
			const detail = saturate
				? `, send() returned ${JSON.stringify(observed.sendResults)}, ${observed.buffered} bytes buffered`
				: '';
			record(section, label,
				`{"code":${e.code},"reason":${JSON.stringify(e.reason)},"wasClean":${e.wasClean}}${detail}`);
			server.stop(true);
			resolve();
		});
	});

	await closeCase(false);
	await closeCase(true);
}

async function probeConnectionClose() {
	// Whether Bun honours a request's `Connection: close`. A live suite drives
	// the server over a raw socket precisely because fetch() cannot construct
	// the header shapes it needs, and such a suite has to know when the
	// response is over. Reading until the peer hangs up is the obvious answer
	// and the wrong one if this does not hold, so the adapter's test lanes need
	// the measured behaviour rather than the RFC's requirement.
	const section = 'connection-close';

	// Short enough that a connection Bun declines to close still ends inside
	// this probe, which is what tells "never closed" apart from "closed late".
	const IDLE = 3;
	const WINDOW_MS = IDLE * 1000 + 2000;

	/**
	 * Send one `Connection: close` request and report when the socket ended.
	 */
	const closeCase = async (label, fetchFn) => {
		const server = Bun.serve({ hostname: HOST, port: 0, idleTimeout: IDLE, fetch: fetchFn });
		try {
			const observed = await new Promise((resolve) => {
				const t0 = performance.now();
				const socket = connect(server.port, HOST);
				const at = () => Math.round(performance.now() - t0);
				// Prompt means "when the response ended"; anything slower is the
				// idle sweep collecting a connection the server chose to keep.
				const verdict = () => (at() < 250 ? `closed after ${at()}ms` : `HELD past the response, closed after ${at()}ms (idleTimeout ${IDLE}s)`);
				const timer = setTimeout(() => { socket.destroy(); resolve(`still open after ${at()}ms`); }, WINDOW_MS);
				socket.on('data', () => {});
				socket.on('error', (err) => { clearTimeout(timer); resolve(`socket error ${err.code}`); });
				socket.on('close', () => { clearTimeout(timer); resolve(verdict()); });
				socket.on('connect', () => socket.write(
					`GET / HTTP/1.1\r\nHost: ${HOST}:${server.port}\r\nConnection: close\r\n\r\n`
				));
			});
			record(section, label, observed);
		} finally {
			server.stop(true);
		}
	};

	await closeCase('handler returns a Response synchronously', () => new Response('body'));
	await closeCase('handler is async but settles without yielding', async () => new Response('body'));
	// THE ONE THAT DECIDES IT: every SSR response goes through at least one
	// macrotask before it is returned, so if this differs from the two above,
	// it is the case that describes the adapter's own traffic.
	await closeCase('handler awaits a macrotask first', async () => {
		await sleep(1);
		return new Response('body');
	});
	await closeCase('handler awaits a macrotask, response body is bytes', async () => {
		await sleep(1);
		return new Response(new TextEncoder().encode('body'), {
			headers: new Headers({ 'content-type': 'text/plain' })
		});
	});
}

async function probeBodyReadScheduling() {
	const section = 'body-read-scheduling';

	// The HTTP half (collectImmediate, in src/runtime/handler/ssr.js) tells a
	// complete response body apart from a streaming one by reading it against
	// a single setTimeout(..., 0) deadline for the whole body. That is only a
	// valid test while an already-available read settles as a MICROTASK: if
	// reads ever resolve on the macrotask queue, every response is classified
	// as streaming and the adapter silently loses SSR compression and request
	// deduplication - a throughput cliff with no error to notice. Pin it here
	// so a Bun upgrade that changes stream scheduling shows up as a diff.
	//
	// The loop below deliberately mirrors collectImmediate's shape (one shared
	// deadline, not one per read). The duplication is unavoidable - the runtime
	// module carries build-time placeholders and cannot be imported here - so
	// if you change one, change the other.
	const STILL_PENDING = Symbol('pending');

	async function classify(body) {
		const reader = body.getReader();
		let timer;
		const deadline = new Promise((resolve) => {
			timer = setTimeout(() => resolve(STILL_PENDING), 0);
		});
		try {
			for (;;) {
				const result = await Promise.race([reader.read(), deadline]);
				if (result === STILL_PENDING) return 'streaming';
				if (result.done) return 'complete';
			}
		} finally {
			clearTimeout(timer);
		}
	}

	record(section, 'in-memory string body classified as', await classify(new Response('x'.repeat(64 * 1024)).body));
	record(section, 'in-memory bytes body classified as', await classify(new Response(new Uint8Array(64 * 1024)).body));
	// A large in-memory body: if Bun ever paced big bodies across macrotasks,
	// large pages would stop compressing while the small cases stayed green.
	record(section, 'large (4 MiB) in-memory body classified as', await classify(new Response(new Uint8Array(4 * 1024 * 1024)).body));

	const multi = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			for (let i = 0; i < 8; i++) controller.enqueue(enc.encode('chunk'.repeat(256)));
			controller.close();
		}
	});
	record(section, 'multi-chunk already-enqueued body classified as', await classify(multi));

	const deferred = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			controller.enqueue(enc.encode('shell'));
			await sleep(50);
			controller.enqueue(enc.encode('tail'));
			controller.close();
		}
	});
	record(section, 'shell-then-await body classified as', await classify(deferred));
}

// ---------------------------------------------------------------------------
// Raw HTTP helpers for the request-line, Host and header probes below. fetch()
// normalizes exactly the shapes those questions are about, so they go over a
// raw socket and read the bytes that come back.

/**
 * Write raw request bytes and collect what comes back until the peer closes
 * or the answer goes quiet.
 *
 * @param {number} port
 * @param {string | Buffer} bytes a string is written as latin1: one char, one byte
 */
function rawExchange(port, bytes, { quietMs = 250, maxMs = 3000, onSocket } = {}) {
	return new Promise((resolve) => {
		const socket = connect(port, HOST);
		let buf = Buffer.alloc(0);
		let quiet;
		let settled = false;
		const done = (why) => {
			if (settled) return;
			settled = true;
			clearTimeout(quiet);
			clearTimeout(hard);
			socket.destroy();
			resolve({ text: buf.toString('latin1'), why });
		};
		const hard = setTimeout(() => done(`nothing more after ${maxMs}ms`), maxMs);
		socket.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			clearTimeout(quiet);
			quiet = setTimeout(() => done('quiet'), quietMs);
		});
		socket.on('error', (err) => done(`error ${err.code}`));
		socket.on('close', () => done('closed'));
		socket.on('connect', () => {
			socket.write(typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes);
			onSocket?.(socket);
		});
	});
}

/**
 * Every status line in a raw answer, in order. Matched anywhere rather than at
 * line starts: a pipelined response follows the previous body with no break.
 */
function statusLines(text) {
	return [...text.matchAll(/HTTP\/1\.[01] \d{3}[^\r\n]*/g)].map((m) => m[0]);
}

/** The head of the first response in a raw answer, as name -> value. */
function firstHead(text) {
	const end = text.indexOf('\r\n\r\n');
	const head = {};
	for (const line of text.slice(0, end < 0 ? text.length : end).split('\r\n').slice(1)) {
		const at = line.indexOf(':');
		if (at > 0) head[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
	}
	return head;
}

/** The parsed JSON body of the first response, or its raw text. */
function firstJson(text) {
	const at = text.indexOf('\r\n\r\n');
	const body = at < 0 ? '' : text.slice(at + 4);
	const open = body.indexOf('{');
	const close = body.indexOf('}\r\n') >= 0 ? body.indexOf('}\r\n') : body.lastIndexOf('}');
	try {
		return JSON.parse(body.slice(open, close + 1));
	} catch {
		return body.slice(0, 200);
	}
}

/**
 * A server whose fetch answers with how Bun handed it the request: req.url,
 * what new URL() makes of it, and Headers.get() for each named header.
 *
 * @param {string[]} [names]
 */
function echoServer(names = []) {
	return Bun.serve({
		hostname: HOST,
		port: 0,
		fetch(req) {
			let pathname;
			let search;
			try {
				const url = new URL(req.url);
				pathname = url.pathname;
				search = url.search;
			} catch (err) {
				pathname = `new URL threw ${err.constructor?.name}`;
			}
			const got = Object.fromEntries(names.map((name) => [name, req.headers.get(name)]));
			return Response.json({ url: req.url, pathname, search, got });
		}
	});
}

const latin1 = (...codes) => String.fromCharCode(...codes);

/**
 * Open a WebSocket over a raw socket and report the first close frame the
 * server writes: its code and reason bytes as they are on the wire.
 *
 * @param {number} port
 * @returns {Promise<{ code?: number | null, reasonHex?: string, payloadLength?: number, error?: string }>}
 */
function rawWsClose(port) {
	return new Promise((resolve) => {
		const socket = connect(port, HOST);
		let buf = Buffer.alloc(0);
		let upgraded = false;
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => done({ error: 'no close frame within 3000ms' }), 3000);
		socket.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			if (!upgraded) {
				const end = buf.indexOf('\r\n\r\n');
				if (end < 0) return;
				upgraded = true;
				buf = buf.subarray(end + 4);
			}
			while (buf.length >= 2) {
				const opcode = buf[0] & 0x0f;
				let len = buf[1] & 0x7f;
				let at = 2;
				if (len === 126) {
					if (buf.length < 4) return;
					len = buf.readUInt16BE(2);
					at = 4;
				} else if (len === 127) {
					if (buf.length < 10) return;
					len = Number(buf.readBigUInt64BE(2));
					at = 10;
				}
				if (buf.length < at + len) return;
				const payload = buf.subarray(at, at + len);
				buf = buf.subarray(at + len);
				if (opcode === 0x8) {
					done({ code: payload.length >= 2 ? payload.readUInt16BE(0) : null, reasonHex: payload.subarray(2).toString('hex'), payloadLength: payload.length });
					return;
				}
			}
		});
		socket.on('close', () => done({ error: 'socket closed with no close frame' }));
		socket.on('error', (err) => done({ error: err.code }));
		socket.on('connect', () => socket.write(
			`GET / HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
		));
	});
}

async function probeRequestUrlFromHost() {
	// Whether req.url is built from the Host header, so every lane that routes
	// on new URL(req.url) routes on what a client writes there - normalized by
	// the URL parser where the result parses, passed on raw where it does not.
	const section = 'request-url-host';
	const server = echoServer(['host']);
	try {
		const ask = async (label, head) => {
			const { text, why } = await rawExchange(server.port, `${head}\r\n\r\n`);
			const status = statusLines(text)[0] ?? `(no response: ${why})`;
			const body = firstJson(text);
			record(section, label, status.includes(' 200 ')
				? `${status} url=${JSON.stringify(body.url)} pathname=${JSON.stringify(body.pathname)} get(host)=${JSON.stringify(body.got?.host)}`
				: status);
		};
		await ask('Host: example.test:8080', 'GET /p?q=1 HTTP/1.1\r\nHost: example.test:8080');
		await ask('no Host line, HTTP/1.1', 'GET /p HTTP/1.1');
		await ask('no Host line, HTTP/1.0', 'GET /p HTTP/1.0');
		await ask('empty Host value', 'GET /p HTTP/1.1\r\nHost: ');
		await ask('Host carrying a path and a ?: a/healthz?', 'GET /p HTTP/1.1\r\nHost: a/healthz?');
		await ask('Host carrying a #: a#b', 'GET /p HTTP/1.1\r\nHost: a#b');
		await ask('Host carrying userinfo: u@h', 'GET /p HTTP/1.1\r\nHost: u@h');
		await ask('Host with the default port: h:80', 'GET /p HTTP/1.1\r\nHost: h:80');
		await ask('Host with a port past 65535: h:99999', 'GET /p HTTP/1.1\r\nHost: h:99999');
		await ask('Host with an empty port: h:', 'GET /p HTTP/1.1\r\nHost: h:');
		await ask('Host with raw UTF-8 bytes (caf + 0xc3 0xa9)', `GET /p HTTP/1.1\r\nHost: caf${latin1(0xc3, 0xa9)}`);
		await ask('Host with a backslash: a\\b', 'GET /p HTTP/1.1\r\nHost: a\\b');
		await ask('Host with a space: a b', 'GET /p HTTP/1.1\r\nHost: a b');
		await ask('Host with two ports: a:80:80', 'GET /p HTTP/1.1\r\nHost: a:80:80');
		await ask('Host with a malformed punycode label: xn--zz', 'GET /p HTTP/1.1\r\nHost: xn--zz');
		await ask('Host with upper case and a trailing dot: EXAMPLE.com.', 'GET /p HTTP/1.1\r\nHost: EXAMPLE.com.');
		await ask('Host as a bracketed IPv6 literal: [::1]:8080', 'GET /p HTTP/1.1\r\nHost: [::1]:8080');
		await ask('two Host lines', 'GET /p HTTP/1.1\r\nHost: one.test\r\nHost: two.test');
		await ask('absolute-form target with a different Host', 'GET http://other.test/abs HTTP/1.1\r\nHost: h.test');
	} finally {
		server.stop(true);
	}
}

async function probeRequestTargetBytes() {
	// What reaches fetch() for a request target RFC 9112 does not allow - a
	// byte outside visible ASCII, a fragment - and for the spellings that
	// resolve onto another path: whether Bun refuses before fetch, passes the
	// bytes on, or normalizes them into req.url.
	const section = 'request-target';
	const server = echoServer();
	try {
		const ask = async (label, target) => {
			const { text, why } = await rawExchange(server.port, `GET ${target} HTTP/1.1\r\nHost: h.test\r\n\r\n`);
			const status = statusLines(text)[0] ?? `(no response: ${why})`;
			const body = firstJson(text);
			record(section, label, status.includes(' 200 ')
				? `${status} url=${JSON.stringify(body.url)} pathname=${JSON.stringify(body.pathname)} search=${JSON.stringify(body.search)}`
				: status);
		};
		await ask('plain /p', '/p');
		await ask('raw 0xc3 0xa9 in the path', `/caf${latin1(0xc3, 0xa9)}`);
		await ask('raw 0xc3 0xa9 in the query', `/p?x=${latin1(0xc3, 0xa9)}`);
		await ask('raw 0x80 in the path', `/a${latin1(0x80)}b`);
		await ask('tab in the path', `/a${latin1(0x09)}b`);
		await ask('0x01 in the path', `/a${latin1(0x01)}b`);
		await ask('0x7f in the path', `/a${latin1(0x7f)}b`);
		await ask('0x01 in the query', `/p?a${latin1(0x01)}b`);
		await ask('NUL in the path', `/a${latin1(0x00)}b`);
		await ask('0x1f in the path', `/a${latin1(0x1f)}b`);
		await ask('CR in the path', `/a${latin1(0x0d)}b`);
		await ask('raw 0xff in the path', `/a${latin1(0xff)}b`);
		await ask('raw 0xe9 alone (Latin-1 e-acute) in the path', `/caf${latin1(0xe9)}`);
		await ask('raw 0xe9 alone in the query', `/p?x=${latin1(0xe9)}`);
		await ask('a space inside the target', '/a b');
		await ask('# in the path', '/a#b');
		await ask('# in the query', '/p?x=1#y');
		await ask('an empty fragment: /p#', '/p#');
		await ask('/x/../healthz', '/x/../healthz');
		await ask('/./healthz', '/./healthz');
		await ask('/x/%2E%2E/healthz', '/x/%2E%2E/healthz');
		await ask('/x/..%2Fhealthz', '/x/..%2Fhealthz');
		await ask('backslashes: /x\\..\\healthz', '/x\\..\\healthz');
		await ask('/%68ealthz', '/%68ealthz');
		await ask('//double', '//double');
		await ask('/healthz/__data.json', '/healthz/__data.json');
		await ask('/ma%C3%9F.txt', '/ma%C3%9F.txt');
		await ask('/My%20Report.pdf', '/My%20Report.pdf');
	} finally {
		server.stop(true);
	}
}

async function probePathnameEncoding() {
	// Which visible ASCII characters arrive changed, in req.url and in
	// new URL(req.url).pathname: the static lookup keys on one of them.
	const section = 'pathname-encoding';
	const server = echoServer();
	try {
		const inUrl = [];
		const inPathname = [];
		for (let code = 0x21; code <= 0x7e; code++) {
			const c = latin1(code);
			if (c === '/' || c === '?' || c === '#' || c === '%') continue;
			const { text } = await rawExchange(server.port, `GET /a${c}b HTTP/1.1\r\nHost: h.test\r\n\r\n`, { quietMs: 60 });
			const body = firstJson(text);
			if (typeof body !== 'object') { inUrl.push(`${c}(no 200)`); continue; }
			const target = String(body.url).replace(/^https?:\/\/[^/]+/, '');
			if (target !== `/a${c}b`) inUrl.push(`${c} -> ${target}`);
			if (body.pathname !== `/a${c}b`) inPathname.push(`${c} -> ${body.pathname}`);
		}
		record(section, 'visible ASCII characters changed in req.url', inUrl.length ? inUrl.join('  ') : 'none');
		record(section, 'visible ASCII characters changed in new URL(req.url).pathname', inPathname.length ? inPathname.join('  ') : 'none');
	} finally {
		server.stop(true);
	}
}

async function probeRepeatedHeaders() {
	// What Headers.get() returns for a header sent on two lines - joined, and
	// with which separator, or one of the lines - since a repeated handshake
	// line or proxy header is something the adapter must judge.
	const section = 'repeated-headers';
	const NAMES = ['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'X-Forwarded-Proto', 'X-Forwarded-Host', 'X-Forwarded-For', 'Forwarded', 'X-Custom', 'Cookie',
		'Accept', 'Origin', 'Authorization', 'Proxy-Authorization', 'Content-Type'];
	const server = echoServer(NAMES);
	try {
		for (const name of NAMES) {
			const { text, why } = await rawExchange(server.port, `GET /p HTTP/1.1\r\nHost: h.test\r\n${name}: first\r\n${name}: second\r\n\r\n`);
			const body = firstJson(text);
			const status = statusLines(text)[0] ?? `(no response: ${why})`;
			record(section, `Headers.get('${name}') for "first" then "second"`,
				typeof body === 'object' ? JSON.stringify(body.got[name]) : status);
		}
		const { text } = await rawExchange(server.port, 'GET /p HTTP/1.1\r\nHost: h.test\r\nSec-WebSocket-Version: 13, 8\r\n\r\n');
		const body = firstJson(text);
		record(section, 'Headers.get for one line "Sec-WebSocket-Version: 13, 8"', typeof body === 'object' ? JSON.stringify(body.got['Sec-WebSocket-Version']) : 'no 200');
		// An empty line is still a line: whether it survives the join, which is
		// what lets a repeated version line with one side empty read as two.
		for (const [label, lines] of [
			['"13" then an empty line', 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Version:'],
			['an empty line then "13"', 'Sec-WebSocket-Version:\r\nSec-WebSocket-Version: 13'],
			['one empty line', 'Sec-WebSocket-Version:']
		]) {
			const { text: t } = await rawExchange(server.port, `GET /p HTTP/1.1\r\nHost: h.test\r\n${lines}\r\n\r\n`);
			const b = firstJson(t);
			record(section, `Headers.get('Sec-WebSocket-Version') for ${label}`, typeof b === 'object' ? JSON.stringify(b.got['Sec-WebSocket-Version']) : 'no 200');
		}
		// A header value's bytes, as the handler reads them: the char codes of
		// what Headers.get returns for raw UTF-8 (carried back as the echo's UTF-8
		// JSON, read here as latin1, so decoded first), and whether a vertical tab
		// reaches the handler at all.
		const { text: utf8 } = await rawExchange(server.port, `GET /p HTTP/1.1\r\nHost: h.test\r\nUpgrade: websoc${latin1(0xe2, 0x84, 0xaa)}et\r\n\r\n`);
		const u = firstJson(utf8);
		record(section, 'char codes of Headers.get(\'Upgrade\') for "websoc" + the UTF-8 bytes of U+212A + "et"',
			typeof u === 'object' ? [...Buffer.from(u.got.Upgrade, 'latin1').toString('utf8')].map((c) => c.charCodeAt(0).toString(16)).join(' ') : 'no 200');
		const { text: vt, why: vtWhy } = await rawExchange(server.port, `GET /p HTTP/1.1\r\nHost: h.test\r\nConnection: keep-alive,${latin1(0x0b)}upgrade\r\n\r\n`);
		record(section, 'a vertical tab inside a Connection value', statusLines(vt)[0] ?? `(no response: ${vtWhy})`);
	} finally {
		server.stop(true);
	}
}

async function probeHandshakeCases() {
	// What server.upgrade() does with each handshake the family's rule judges,
	// before any check of the adapter's own: accept, decline, or throw - and
	// what a fetch() Response returned instead of upgrading puts on the wire.
	const section = 'handshake-cases';
	const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
	const NORMAL = [['Connection', 'keep-alive, UpGrAdE'], ['Upgrade', 'WebSocket'], ['Sec-WebSocket-Version', '13'], ['Sec-WebSocket-Key', KEY]];
	const without = (name) => NORMAL.filter(([k]) => k !== name);
	const replaced = (name, value) => NORMAL.map(([k, v]) => [k, k === name ? value : v]);
	const repeated = (name) => [...NORMAL, NORMAL.find(([k]) => k === name)];
	const CASES = [
		['a complete handshake', NORMAL],
		['no Upgrade', without('Upgrade')],
		['no Connection', without('Connection')],
		['no key', without('Sec-WebSocket-Key')],
		['an Upgrade naming another protocol', replaced('Upgrade', 'not-websocket')],
		['a Connection without upgrade', replaced('Connection', 'keep-alive')],
		['a 24-character key that is not base64', replaced('Sec-WebSocket-Key', '!'.repeat(24))],
		['a short key', replaced('Sec-WebSocket-Key', 'a')],
		['a key with its unused bits set', replaced('Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZR==')],
		['Upgrade twice', repeated('Upgrade')],
		['the key twice (the same value)', repeated('Sec-WebSocket-Key')],
		['two different keys, the reference key first', [...NORMAL, ['Sec-WebSocket-Key', 'AAAAAAAAAAAAAAAAAAAAAA==']]],
		['the version twice', repeated('Sec-WebSocket-Version')],
		['version 12', replaced('Sec-WebSocket-Version', '12')],
		['version 8', replaced('Sec-WebSocket-Version', '8')],
		['a version that is not a number', replaced('Sec-WebSocket-Version', '13a')],
		['upgrade listed on a second Connection line', [...without('Connection'), ['Connection', 'keep-alive'], ['Connection', 'Upgrade']]],
		['no version', without('Sec-WebSocket-Version')],
		['a websocket Upgrade with no key', [['Connection', 'Upgrade'], ['Upgrade', 'websocket']]],
		['a complete handshake sent as POST', NORMAL, 'POST']
	];
	let verdict = '';
	const server = Bun.serve({
		hostname: HOST,
		port: 0,
		fetch(req, srv) {
			try {
				verdict = srv.upgrade(req) ? 'upgrade() true' : 'upgrade() false';
			} catch (err) {
				verdict = `upgrade() THREW ${err.constructor?.name}: ${String(err.message).slice(0, 80)}`;
			}
			if (verdict === 'upgrade() true') return undefined;
			return new Response('declined', { status: 418 });
		},
		websocket: { open(ws) { ws.close(1000); }, message() {} }
	});
	try {
		for (const [label, headers, method = 'GET'] of CASES) {
			verdict = 'fetch() never ran';
			const { text, why } = await rawExchange(server.port,
				`${method} /ws HTTP/1.1\r\nHost: h.test\r\n` + headers.map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
			const status = statusLines(text)[0] ?? `(no response: ${why})`;
			const accept = firstHead(text)['sec-websocket-accept'];
			record(section, label, `${verdict}; wire: ${status}${accept ? `; accept ${accept}` : ''}`);
		}
	} finally {
		server.stop(true);
	}
	// Two different keys: which one the accept hash was computed over.
	const hash = async (key) => Buffer.from(await crypto.subtle.digest('SHA-1',
		new TextEncoder().encode(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))).toString('base64');
	record(section, 'reference accepts for the two-key case',
		`first (reference) key ${await hash(KEY)}; second key ${await hash('AAAAAAAAAAAAAAAAAAAAAA==')}`);
	// A non-101 Response on an upgrade request, returned instead of upgrading.
	const refuser = Bun.serve({
		hostname: HOST,
		port: 0,
		fetch() {
			return new Response('Upgrade Required', { status: 426, headers: { 'sec-websocket-version': '13' } });
		},
		websocket: { open() {}, message() {} }
	});
	try {
		const { text } = await rawExchange(refuser.port,
			`GET /ws HTTP/1.1\r\nHost: h.test\r\n` + NORMAL.map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
		record(section, 'fetch() returns 426 with sec-websocket-version: 13 on a complete handshake',
			`${statusLines(text)[0]}; sec-websocket-version ${JSON.stringify(firstHead(text)['sec-websocket-version'])}`);
	} finally {
		refuser.stop(true);
	}
}

async function probeCloseCodes() {
	// The close codes and reasons each end sees for the close shapes the
	// family close rule decides, measured rather than assumed.
	// Read off a raw socket: a WebSocket client object normalizes exactly the
	// part in question - Bun's reports 1002 for a 999 it received, 1000 for an
	// empty close frame, and a reason the server never sent for a dropped one.
	const section = 'close-codes';
	const closeCase = async (label, act, wsOptions = {}) => {
		const { server, firstWs, state } = serveWs(wsOptions);
		try {
			const wire = rawWsClose(server.port);
			const ws = await firstWs();
			const acted = callAndDescribe(() => act(ws));
			const frame = await wire;
			await sleep(50);
			record(section, label, `${acted}; on the wire ${JSON.stringify(frame)}; server close handler ${JSON.stringify(state.closes.map((c) => c.code))}`);
		} finally {
			server.stop(true);
		}
	};
	await closeCase('ws.close() with no arguments', (ws) => ws.close());
	await closeCase('ws.close(1000, a lone surrogate)', (ws) => ws.close(1000, 'a' + String.fromCharCode(0xd800) + 'b'));
	await closeCase('ws.close(1000, a Uint8Array reason)', (ws) => ws.close(1000, new Uint8Array([0x6f, 0x6b])));
	await closeCase('ws.close(1000, a reason that is not UTF-8 bytes)', (ws) => ws.close(1000, new Uint8Array([0xff, 0xfe])));
	await closeCase('ws.close(999)', (ws) => ws.close(999));
	await closeCase('ws.close(1005)', (ws) => ws.close(1005));
	await closeCase('ws.close(1000.5)', (ws) => ws.close(1000.5));
	await closeCase('ws.terminate()', (ws) => ws.terminate());
	// Inside open: the code the peer reads and whether the close handler runs
	// synchronously inside the call.
	{
		const order = [];
		const { server, state } = serveWs({
			open(ws) {
				order.push('open');
				ws.close(1011, 'Open handler error');
				order.push('after close()');
			},
			close(ws, code) { order.push(`close ${code}`); state.closes.push({ code }); }
		});
		try {
			const frame = await rawWsClose(server.port);
			await sleep(50);
			record(section, 'ws.close(1011, "Open handler error") inside open', `on the wire ${JSON.stringify(frame)}; server order ${JSON.stringify(order)}`);
		} finally {
			server.stop(true);
		}
	}
}

async function probeRequestSignal() {
	// When Bun aborts req.signal, and with what reason: the family contract
	// aborts on a client gone before its body arrived and at shutdown, and
	// never after the body arrived or the response completed.
	const section = 'request-signal';
	const describeAbort = (signal, t0) => new Promise((resolve) => {
		if (signal.aborted) { resolve(`already aborted: ${signal.reason?.name} ${signal.reason?.message}`); return; }
		const timer = setTimeout(() => resolve('not aborted within 1500ms'), 1500);
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			resolve(`aborted after ${Math.round(performance.now() - t0)}ms: ${signal.reason?.constructor?.name} name=${signal.reason?.name} message=${JSON.stringify(String(signal.reason?.message).slice(0, 80))}`);
		});
	});
	const signalCase = async (label, { request, handler, client, stop, wireTail }) => {
		let observation;
		const server = Bun.serve({
			hostname: HOST,
			port: 0,
			async fetch(req) {
				const t0 = performance.now();
				observation = describeAbort(req.signal, t0);
				return handler(req);
			}
		});
		try {
			const exchange = rawExchange(server.port, request, { maxMs: 2500, onSocket: client });
			if (stop) { await sleep(100); server.stop(true); }
			const { text } = await exchange;
			const seen = await (observation ?? Promise.resolve('fetch() never ran'));
			record(section, label, wireTail ? `${seen}; last bytes on the wire ${JSON.stringify(text.slice(-24))}` : seen);
		} finally {
			server.stop(true);
		}
	};
	const held = async () => { await sleep(1000); return new Response('late'); };
	await signalCase('GET, client disconnects while the handler holds', {
		request: 'GET /p HTTP/1.1\r\nHost: h.test\r\n\r\n',
		handler: held,
		client: (socket) => setTimeout(() => socket.destroy(), 100)
	});
	await signalCase('POST with its whole body sent, client disconnects while the handler holds', {
		request: 'POST /p HTTP/1.1\r\nHost: h.test\r\nContent-Length: 5\r\n\r\nhello',
		handler: async (req) => { await req.text(); return held(); },
		client: (socket) => setTimeout(() => socket.destroy(), 100)
	});
	{
		let bodyRead = 'no read';
		await signalCase('POST mid-body (5 of 100 bytes), client disconnects', {
			request: 'POST /p HTTP/1.1\r\nHost: h.test\r\nContent-Length: 100\r\n\r\nhello',
			handler: async (req) => {
				bodyRead = await req.text().then((t) => `body read resolved with ${t.length} chars`, (err) => `body read rejected: ${err.constructor?.name} ${JSON.stringify(String(err.message).slice(0, 80))}`);
				return new Response('done');
			},
			client: (socket) => setTimeout(() => socket.destroy(), 100)
		});
		await sleep(200);
		record(section, 'the mid-body read itself', bodyRead);
	}
	await signalCase('response completed, then the client disconnects', {
		request: 'GET /p HTTP/1.1\r\nHost: h.test\r\n\r\n',
		handler: () => new Response('done'),
		client: (socket) => setTimeout(() => socket.destroy(), 300)
	});
	await signalCase('streaming response, client disconnects mid-stream', {
		request: 'GET /p HTTP/1.1\r\nHost: h.test\r\n\r\n',
		handler: () => new Response(new ReadableStream({
			async pull(controller) { await sleep(50); controller.enqueue(new TextEncoder().encode('chunk\n')); }
		})),
		client: (socket) => setTimeout(() => socket.destroy(), 200)
	});
	await signalCase('streaming response that the server errors mid-stream', {
		request: 'GET /p HTTP/1.1\r\nHost: h.test\r\n\r\n',
		wireTail: true,
		handler: () => {
			let n = 0;
			return new Response(new ReadableStream({
				async pull(controller) {
					await sleep(50);
					if (++n === 3) controller.error(new Error('stream broke'));
					else controller.enqueue(new TextEncoder().encode('chunk\n'));
				}
			}));
		}
	});
	await signalCase('server.stop(true) while the handler holds', {
		request: 'GET /p HTTP/1.1\r\nHost: h.test\r\n\r\n',
		handler: held,
		stop: true
	});
	// Whether a Request built over Bun's follows its signal.
	{
		let followed;
		const server = Bun.serve({
			hostname: HOST,
			port: 0,
			async fetch(req) {
				const wrapped = new Request(req.url, req);
				followed = describeAbort(wrapped.signal, performance.now());
				return held();
			}
		});
		try {
			await rawExchange(server.port, 'GET /p HTTP/1.1\r\nHost: h.test\r\n\r\n', { maxMs: 2000, onSocket: (socket) => setTimeout(() => socket.destroy(), 100) });
			record(section, 'new Request(req.url, req).signal when the client disconnects', await followed);
		} finally {
			server.stop(true);
		}
	}
}

async function probePipelining() {
	// Two requests in one packet: both answered, in order, and whether a slow
	// first one holds the second back.
	const section = 'pipelining';
	const server = Bun.serve({
		hostname: HOST,
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === '/slow') await sleep(300);
			if (path === '/bad') return new Response('refused', { status: 400 });
			return new Response(path);
		}
	});
	try {
		const two = await rawExchange(server.port, 'GET /a HTTP/1.1\r\nHost: h\r\n\r\nGET /b HTTP/1.1\r\nHost: h\r\n\r\n');
		const order = (text, first, second) => {
			const a = text.indexOf(first);
			const b = text.indexOf(second);
			return a < 0 || b < 0 ? 'not both answered' : a < b ? `${first} first` : `${second} first`;
		};
		record(section, 'GET /a and GET /b in one write', `${JSON.stringify(statusLines(two.text))} ${order(two.text, '/a', '/b')} (${two.why})`);
		const t0 = performance.now();
		const slow = await rawExchange(server.port, 'GET /slow HTTP/1.1\r\nHost: h\r\n\r\nGET /healthz HTTP/1.1\r\nHost: h\r\n\r\n', { quietMs: 400 });
		record(section, 'GET /slow then GET /healthz in one write', `${JSON.stringify(statusLines(slow.text))} ${order(slow.text, '/slow', '/healthz')} total ${Math.round(performance.now() - t0)}ms (${slow.why})`);
		// The same pair with the second request written while the first is
		// being handled, so nothing about a single write can explain the answer.
		const t1 = performance.now();
		const later = await rawExchange(server.port, 'GET /slow HTTP/1.1\r\nHost: h\r\n\r\n', {
			quietMs: 400,
			onSocket: (socket) => setTimeout(() => socket.write('GET /healthz HTTP/1.1\r\nHost: h\r\n\r\n'), 50)
		});
		record(section, 'GET /slow, then GET /healthz written 50ms later on the same connection', `${JSON.stringify(statusLines(later.text))} ${order(later.text, '/slow', '/healthz')} total ${Math.round(performance.now() - t1)}ms (${later.why})`);
		const unread = await rawExchange(server.port, 'POST /bad HTTP/1.1\r\nHost: h\r\nContent-Length: 10\r\n\r\n0123456789GET /after HTTP/1.1\r\nHost: h\r\n\r\n');
		record(section, 'a 400 that leaves a 10-byte body unread, then GET /after', `${JSON.stringify(statusLines(unread.text))} after-answered=${unread.text.includes('/after')} (${unread.why})`);
	} finally {
		server.stop(true);
	}
}

async function probeUpgradeDataIdentity() {
	// Whether the data object passed to server.upgrade() arrives as ws.data by
	// identity, Symbol keys and accessors included.
	const section = 'upgrade-data';
	const sym = Symbol('carry');
	const data = { plain: 1, [sym]: 'symbol value' };
	let observed = 'open never ran';
	const server = Bun.serve({
		hostname: HOST,
		port: 0,
		fetch(req, srv) {
			return srv.upgrade(req, { data }) ? undefined : new Response('no', { status: 400 });
		},
		websocket: {
			open(ws) {
				observed = `same object ${ws.data === data}; symbol key ${JSON.stringify(ws.data?.[sym])}; plain ${ws.data?.plain}`;
				ws.close();
			},
			message() {}
		}
	});
	try {
		const client = new WebSocket(`ws://${HOST}:${server.port}/`);
		await closeEvent(client).catch(() => {});
		record(section, 'server.upgrade(req, { data }) then ws.data in open', observed);
	} finally {
		server.stop(true);
	}
}

// ---------------------------------------------------------------------------

const probes = [
	probeSendReturnCodes,
	probeBackpressureLimitAndDrain,
	probePublish,
	probePublishBackpressure,
	probeWireTransport,
	probeCloseVsTerminate,
	probeClosedSocketBehavior,
	probePrototypePatch,
	probeIdleTimeoutCap,
	probeHttpIdleTimeout,
	probeCloseUnderBackpressure,
	probeConnectionClose,
	probeMaxPayloadEnforcement,
	probeMessageBufferLifetime,
	probeUpgradeFlow,
	probeUpgradeAbort,
	probeUpgradeDispatchOrder,
	probeUpgradeHeaderValues,
	probeSubprotocolSelection,
	probeRoutesOption,
	probeStopDrain,
	probeServeOptionAcceptance,
	probeBodyReadScheduling,
	probeRequestUrlFromHost,
	probeRequestTargetBytes,
	probePathnameEncoding,
	probeRepeatedHeaders,
	probeHandshakeCases,
	probeCloseCodes,
	probeRequestSignal,
	probePipelining,
	probeUpgradeDataIdentity
];

console.log(`Bun ${Bun.version} on ${process.platform}/${process.arch}\n`);
for (const probe of probes) {
	try {
		await probe();
	} catch (err) {
		record(probe.name, 'probe crashed', `${err.constructor?.name}: ${err.message}`);
	}
}

const generated = new Date().toISOString();
const bySection = new Map();
for (const f of findings) {
	if (!bySection.has(f.section)) bySection.set(f.section, []);
	bySection.get(f.section).push(f);
}
let md = `# Bun server API facts\n\nGenerated ${generated} by \`probe/bun-api-facts.mjs\`.\n\n`;
md += `- Bun version: **${Bun.version}** (revision ${Bun.revision ?? 'n/a'})\n`;
md += `- Platform: ${process.platform}/${process.arch}\n\n`;
md += 'Observed behavior only; interpretation lives in the adapter design docs.\n';
md += 'Re-run after every Bun upgrade; review any diff before trusting the upgrade.\n\n';
for (const [section, rows] of bySection) {
	md += `## ${section}\n\n`;
	for (const row of rows) md += `- ${row.question}\n  - ${row.observed}\n`;
	md += '\n';
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'bun-api-facts.report.md');
writeFileSync(out, md);
console.log(`\nreport written: ${out}`);

// Observed on the first real run: something in the torn-down servers keeps
// Bun's event loop alive after the last probe (all servers are stopped with
// stop(true), yet the process idles forever). The report is on disk by this
// line, so exit explicitly rather than fight the runtime's liveness
// accounting.
process.exit(0);
