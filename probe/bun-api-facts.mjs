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

const probes = [
	probeSendReturnCodes,
	probeBackpressureLimitAndDrain,
	probePublish,
	probePublishBackpressure,
	probeCloseVsTerminate,
	probeClosedSocketBehavior,
	probePrototypePatch,
	probeIdleTimeoutCap,
	probeMaxPayloadEnforcement,
	probeMessageBufferLifetime,
	probeUpgradeFlow,
	probeSubprotocolSelection,
	probeRoutesOption,
	probeStopDrain,
	probeServeOptionAcceptance,
	probeBodyReadScheduling
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
