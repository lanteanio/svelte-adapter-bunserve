import { identityResponseHeaders } from './identity-headers.js';
import { nextCounter } from '$lib/server/shared-counter.js';
// Fixture WebSocket handler. Exercises every hook the adapter delegates to,
// and refuses one topic so the authorization gate is covered by the live smoke
// test rather than only by unit tests.

// By package name, as a plugin in another package imports it: this resolves
// to the adapter's source through node_modules, a separate module instance
// from the runtime the build copied, which is the case the entry exists for.
import { trackedSubscribe, trackedUnsubscribe } from 'svelte-adapter-bunserve/subscriptions';
import { assertPlatformContract, PLATFORM_CONTRACT } from 'svelte-adapter-bunserve/platform-contract';
import * as releaseProbe from './subscription-release.js';
import { registerIngress } from '../../../src/runtime/handler/ingress.js';

// Read by the extra server entries vite.config.js adds, which record whether
// this module had loaded when they ran (test/live/extra-entries-check.mjs).
/** @type {any} */ (globalThis).__fixtureWsHandlerLoaded = true;

/**
 * A STATEFUL wire codec: the payload's first byte is this connection's own
 * frame counter, so the live suite can prove each connection was encoded
 * against its own state. The rest is x/y as big-endian float32. Batch events
 * are declined, driving the per-entry fallback end to end.
 */
const xyWire = {
	capability: 'fixture.xy:1',
	schemaVersion: 1,
	encode(event, data, state) {
		if (event.endsWith('-batch')) return null;
		if (!state || typeof data?.x !== 'number' || typeof data?.y !== 'number') return null;
		const bytes = new Uint8Array(9);
		bytes[0] = ++state.frames & 0xff;
		const view = new DataView(bytes.buffer);
		view.setFloat32(1, data.x, false);
		view.setFloat32(5, data.y, false);
		return bytes;
	},
	state: {
		onAttach: () => ({ frames: 0 }),
		onDetach: () => {}
	}
};

/**
 * A STATELESS shared codec: byte-identical frames for every binary
 * subscriber, fanned out through the cohort topics.
 */
const snapWire = {
	capability: 'fixture.snap:1',
	schemaVersion: 1,
	shared: true,
	encode: (event, data) => new TextEncoder().encode(JSON.stringify(data ?? null))
};

/** Once at boot, after the listener is up. The family's arming point. */
export function init({ platform }) {
	assertPlatformContract(platform, PLATFORM_CONTRACT, { context: 'worker' });
	registerIngress('fixture.input:1', {
		decode: (payload, schemaVersion, seq) => ({ bytes: [...payload], schemaVersion, seq }),
		route: (ws, target, value, ingressPlatform) => ingressPlatform.send(ws, '__fixture', 'ingress', { target, value })
	});
	platform.registerWireCodec(releaseProbe.wire);
	platform.registerWireCodec(xyWire);
	platform.registerWireCodec(snapWire);
	// Application instruments stay in the configured registry, outside snapshots.
	fixtureOpens = platform.metrics?.counter('fixture_opens_total', 'sockets opened, counted by the app') ?? null;
	console.log(`[fixture] init connections=${platform.connections}`);
	if (process.env.FIXTURE_HANG_INIT === '1') {
		console.log('[shutdown-probe] init held');
		return new Promise(() => {});
	}
}

/** @type {{ inc: (labels?: any, value?: number) => void } | null} */
let fixtureOpens = null;

/**
 * Per-topic scripts for the honest-watermark lane, armed by `fixture-resume-script`.
 *
 * The default hook below reports the offset the CLIENT presented, which is the
 * natural hook shape but is useless for testing the dedup boundary: the runtime
 * trusts a reported watermark only up to what it has actually stamped, so an
 * echoed client offset on a topic with no explicit mark is always refused and
 * the boundary is never exercised. A scripted topic instead publishes known
 * explicit seqs INSIDE the barrier window, DELIVERS the ones at or below
 * `report` to the resuming socket itself, and reports `report` as covered.
 *
 * The delivery is what makes the report TRUE, and it is not a formality: the
 * hook's contract is the highest seq it actually delivered, and the flush drops
 * everything at or below what it returns. A script that published 21, 22 and 23
 * into the topic and reported 22 without sending anything would leave the
 * client short of 21 and 22 for good - a seq the server stamped is not a seq
 * the client received.
 *
 * A script arms ONE window and is consumed by it, so a later resume of the same
 * topic falls back to the default hook.
 *
 * @type {Map<string, { report: number, publish: number[], pad: number }>}
 */
const resumeScripts = new Map();

/**
 * Gap-fill for a recover offset or a standalone resume frame. Awaits a real
 * timer so the live suite exercises the barrier window the runtime bridges,
 * sends one identifiable replay frame per topic, and reports the offset as
 * the covered watermark - anything the runtime buffered past it must then
 * arrive after these frames and before the ack.
 */
export async function resume(ws, { sessionId, lastSeenSeqs, lastSeenEpochs, platform }) {
	if (ws.getUserData().user === 'control-contract') {
		platform.send(ws, '__fixture', 'raw-resume', { sessionId, lastSeenSeqs, lastSeenEpochs });
		if (sessionId === 'fixture:throw') throw new Error('fixture resume failure');
		return;
	}
	await new Promise((resolve) => setTimeout(resolve, 30));
	const covered = {};
	for (const [topic, since] of Object.entries(lastSeenSeqs)) {
		platform.send(ws, topic, 'replayed', { sessionId, since });
		const script = resumeScripts.get(topic);
		if (script === undefined) {
			covered[topic] = typeof since === 'number' ? since : 0;
			continue;
		}
		// Spent on use. A standing script would replay itself into every later
		// resume window on the topic - windows that asked for none of it - so a
		// check reading those frames would be reading the fixture's memory
		// rather than what the runtime did.
		resumeScripts.delete(topic);
		// Published from inside the hook, so these land in the barrier window
		// the resuming connection has open - the case the flush's dedup floor
		// exists for. Deterministic by construction: no second connection has
		// to race the 30 ms above.
		for (const seq of script.publish) {
			// `pad` exists for the backpressure lane: the flush can only be made
			// to refuse a frame by giving it frames big enough to fill a socket,
			// and the payload is the only dial the fixture has. Zero for every
			// other caller, so their frames stay small enough to read in a log.
			const data = script.pad > 0
				? { inWindow: seq, pad: 'x'.repeat(script.pad) }
				: { inWindow: seq };
			platform.publish(topic, 'said', data, { seq });
		}
		// Now DELIVER everything the report is about to claim. Derived from
		// `report` rather than listed separately on the script so the fixture
		// cannot arm a watermark it did not honour: the frames the flush will
		// drop are exactly the frames sent here.
		for (const seq of script.publish) {
			if (seq <= script.report) {
				platform.send(ws, topic, 'said', { inWindow: seq, viaHook: true });
			}
		}
		covered[topic] = script.report;
	}
	return covered;
}

/** Once at graceful shutdown, BEFORE the sockets are drained. */
export async function shutdown({ platform, reason, signal, deadline }) {
	console.log(`[fixture] shutdown connections=${platform.connections}`);
	if (process.env.FIXTURE_SHUTDOWN_DRIVER) {
		globalThis.__shutdownHookContext = { reason, signal, deadline };
		console.log('[shutdown-probe] hook ' + JSON.stringify({ reason, signal: signal === null ? null : 'AbortSignal', deadline }));
		await new Promise(resolve => setTimeout(resolve, process.env.FIXTURE_SHUTDOWN_DRIVER === 'shared' ? 600 : 40));
		console.log('[shutdown-probe] hook done');
	}
	// Armed per spawn: a hook that never settles, so the live suite can prove
	// the shutdown deadline cuts a misbehaving hook instead of letting it hold
	// the process open.
	if (process.env.FIXTURE_HANG_SHUTDOWN === '1') return new Promise(() => {});
}

/**
 * Runs before the handshake. Whatever object this returns becomes the
 * connection's userData; returning false rejects the upgrade with 401.
 *
 * Async behind a real timer on purpose: the adapter promises the hook may
 * await freely, and only an actually-awaited hook makes the live suite prove
 * the handshake survives it. Custom headers travel on the handshake and can be read over a raw socket.
 */
export async function upgrade({ url: target, headers: requestHeaders }) {
	const headers = {};
	await new Promise((resolve) => setTimeout(resolve, 5));
	const url = new URL(target, 'http://localhost');
	// A handshake the caller can hold open for as long as it asks for. The
	// window while this hook awaits is the one where the server is carrying
	// admission counters on behalf of a client that may already have gone, and
	// it is unreachable from a browser client - which either completes the
	// handshake or errors out. Bounded, so a stray value cannot park a fixture
	// connection for the length of a run.
	const hold = Math.min(5_000, Number(url.searchParams.get('hold')) || 0);
	if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
	// An app that turns a socket away from inside `open` - an unauthenticated
	// session, one socket per user, a full room. The close runs synchronously
	// inside the runtime's own upgrade call, which is where the adapter's permit
	// accounting has to already have handed the permit over.
	if (url.searchParams.get('closeOnOpen') === '1') {
		return { closeOnOpen: true };
	}
	if (url.searchParams.get('deny') === '1') {
		return false;
	}
	if (url.searchParams.get('returnResponse') === '1') {
		return new Response('not a refusal', { status: 403, headers: { 'x-refusal': 'must-not-send' } });
	}
	if (url.searchParams.has('identityHeaders')) Object.assign(headers, identityResponseHeaders(requestHeaders));
	if (requestHeaders['x-probe-url'] === '1') headers['x-hook-url'] = target;
	if (url.searchParams.get('responseHeaders') === '1') {
		headers['set-cookie'] = ['first=1', 'second=2'];
		headers['x-upgrade-value'] = 'tab\tvalue';
		headers['x-utf8'] = 'caf\u00e9';
		headers['x-values'] = ['first', 'second'];
		headers['x-duplicate'] = 'one';
		headers['X-Duplicate'] = 'two';
		headers['x-spaces'] = ' \ttrimmed\t ';
		headers['x-hook-url'] = target;
	}
	return { __upgradeResponse: true, userData: { user: url.searchParams.get('user') || 'anon' }, headers };
}

/**
 * The auth preflight, exercised by test/live/auth-endpoint-check.mjs.
 *
 * Every branch a real hook has: refresh a cookie and answer implicitly, refuse,
 * answer with a Response of its own, or throw. Which one it takes is chosen by
 * the query string, so one build covers all of them.
 */
export async function authenticate({ url: target, headers, request, cookies, platform, getClientAddress }) {
	const url = new URL(target, 'http://localhost');
	const mode = url.searchParams.get('mode') || 'ok';
	if (headers['x-auth-echo'] === '1') return Response.json({ requestUrl: request.url });
	if (mode === 'identity-headers') return new Response('ok', { headers: identityResponseHeaders(headers) });
	if (mode === 'shared-counter') return Response.json({ value: nextCounter() });
	if (mode === 'throw') throw new Error('the app hook exploded');
	if (mode === 'deny') {
		// A refusal that still clears the stale session, which is what a real one
		// does and what the adapter has to let through on a 401.
		cookies.delete('fixture_session', { path: '/' });
		return false;
	}
	if (mode === 'response') {
		cookies.set('fixture_session', 'from-jar', { path: '/' });
		return new Response(JSON.stringify({ requestId: platform.requestId, address: getClientAddress() }), {
			status: 200,
			headers: { 'content-type': 'application/json', ...(url.searchParams.has('te') ? { 'transfer-encoding': 'chunked' } : {}) }
		});
	}
	// The ordinary path: a refreshed session cookie on an ordinary HTTP
	// response, which is the entire reason this endpoint exists.
	cookies.set('fixture_session', 'refreshed', { path: '/', maxAge: 600 });
	return undefined;
}

export function open(ws, { platform }) {
	// Turned away here, synchronously, before anything else happens on this
	// connection. This is the shape the adapter's permit hand-over has to
	// survive: the close callback runs inside the runtime's upgrade call, so a
	// handshake still holding the permit at that moment releases it twice.
	if (ws.getUserData().closeOnOpen) {
		ws.end(4003, 'refused by the app');
		return;
	}
	fixtureOpens?.inc();
	// Echo the connection count back so the smoke test can assert the registry
	// tracks opens.
	platform.send(ws, '__fixture', 'opened', {
		user: ws.getUserData().user,
		connections: platform.connections
	});
}

// Held authorization is released by an ordered message, independent of CI timing.
const heldSubscribes = new WeakMap();
const platformForwarders = new WeakMap();

export function message(ws, { data, isBinary, msg, platform }) {
	if (msg?.type === 'fixture-platform-contract') {
		const memberSet = new Set();
		for (let current = platform; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
			for (const name of Object.getOwnPropertyNames(current)) memberSet.add(name);
		}
		const members = [...memberSet];
		let contract = 'ok';
		try { assertPlatformContract(platform, PLATFORM_CONTRACT, { context: 'connection' }); } catch (error) { contract = error.message; }
		let forwarded = platformForwarders.get(ws.getUserData());
		if (!forwarded) {
			forwarded = {};
			for (const name of members) {
				Object.defineProperty(forwarded, name, {
					enumerable: true,
					get() {
						const value = platform[name];
						return typeof value === 'function' ? value.bind(platform) : value;
					}
				});
			}
			platformForwarders.set(ws.getUserData(), forwarded);
		}
		forwarded.send(ws, '__fixture', 'platform-contract', {
			ref: msg.ref, contract, members: members.sort(), forwardedMembers: Object.keys(forwarded).sort(),
			requestId: forwarded.requestId, contextualRequestId: Object.hasOwn(platform, 'requestId'),
			connections: forwarded.connections,
			hasLiveConnectionGetter: typeof Object.getOwnPropertyDescriptor(forwarded, 'connections').get === 'function'
		});
		return;
	}
	if (msg?.type === 'fixture-release') return releaseProbe.message(ws, msg, platform);
	// The client probe sends JSON commands as text and as application binary.
	// Decode that application's binary form before replying with a topic event.
	let clientProbe = msg;
	if (isBinary) {
		try { clientProbe = JSON.parse(new TextDecoder().decode(data)); } catch {}
	}
	if (clientProbe?.type === 'fixture-client-echo') {
		platform.send(ws, '__client-test', 'echo', clientProbe.payload);
		return;
	}
	if (msg?.type === 'fixture-release-subscribes') {
		const pending = heldSubscribes.get(ws.getUserData()) || [];
		heldSubscribes.delete(ws.getUserData());
		platform.send(ws, '__fixture', 'subscribe-gates-released', { count: pending.length });
		for (const release of pending) release();
		return;
	}
	if (isBinary) {
		ws.send(data, true, false);
		return;
	}
	// A control-shaped frame the adapter did not consume arrives pre-parsed.
	if (msg && msg.type === 'broadcast') {
		// `inflate` synthesizes a large payload server-side, past the inbound
		// frame cap a client could send.
		const payload = typeof msg.inflate === 'number'
			? { ...msg.payload, big: 'x'.repeat(msg.inflate) }
			: msg.payload;
		platform.publish(msg.topic || 'test-topic', msg.event || 'broadcast', payload, msg.options ?? { seq: false });
		return;
	}
	// Server-side revocation, the shape a kick, ban or lease expiry uses.
	if (msg && msg.type === 'revoke-topic') {
		const removed = platform.unsubscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'revoked', { topic: msg.topic, removed });
		return;
	}
	if (msg && msg.type === 'fixture-publish') {
		platform.publish(msg.topic, 'said', msg.data, { seq: true });
		return;
	}
	// The BARE call: three arguments, no options object at all. Every other
	// driver here passes one, so without this lane the default the adapter
	// applies - the per-topic counter - is never executed over a real socket,
	// and a client keying on `seq` could stop receiving one with the whole
	// suite still green.
	if (msg && msg.type === 'fixture-publish-bare') {
		platform.publish(msg.topic, 'said', msg.data);
		return;
	}
	// The opt-out, same lane: the only spelling that puts no seq on the wire.
	if (msg && msg.type === 'fixture-publish-noseq') {
		platform.publish(msg.topic, 'said', msg.data, { seq: false });
		return;
	}
	// The EXPLICIT (cluster) seq lane. The counter drivers above never mark a
	// topic as explicitly stamped - so nothing they publish can exercise the
	// reported-watermark path at all.
	if (msg && msg.type === 'fixture-publish-seq') {
		platform.publish(msg.topic, 'said', msg.data, { seq: msg.seq });
		return;
	}
	if (msg && msg.type === 'fixture-resume-script') {
		resumeScripts.set(msg.topic, {
			report: msg.report,
			publish: msg.publish,
			pad: typeof msg.pad === 'number' ? msg.pad : 0
		});
		platform.send(ws, '__fixture', 'resume-scripted', { topic: msg.topic });
		return;
	}
	// Wire-tier drivers, one per platform member the wire suite asserts.
	if (msg && msg.type === 'fixture-wire') {
		platform.publishWire(msg.topic, 'moved', msg.data, xyWire, { seq: true });
		return;
	}
	if (msg && msg.type === 'fixture-wire-batch') {
		platform.publishWireBatch(msg.topic, 'moved', msg.entries, xyWire, { seq: true });
		return;
	}
	if (msg && msg.type === 'fixture-sendwire') {
		platform.sendWire(ws, msg.topic, 'snapshot', msg.data, xyWire);
		return;
	}
	if (msg && msg.type === 'fixture-wire-shared') {
		platform.publishWire(msg.topic, 'tick', msg.data, snapWire, { seq: true });
		return;
	}
	if (msg && msg.type === 'fixture-pressure') {
		// The pressure surface as an app actually reads it: the live snapshot
		// plus the posture. Reported over the wire so the live lane can prove
		// the sampler runs in a real Bun process, which no unit test can.
		const p = platform.pressure;
		// The raw heap reading beside the snapshot: this runtime's
		// heapUsed/heapTotal is what the memory signal is computed from, and
		// the live suite pins how it actually behaves here.
		const mem = process.memoryUsage();
		platform.send(ws, '__fixture', 'pressure', {
			heapRatio: mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0,
			protection: platform.protection,
			active: p.active,
			reason: p.reason,
			value: p.value,
			publishRate: p.publishRate,
			subscriberRatio: p.subscriberRatio,
			memoryMB: p.memoryMB,
			maxBufferedBytes: p.maxBufferedBytes,
			backpressuredConnections: p.backpressuredConnections,
			topPublishers: p.topPublishers,
			psiNull: p.psi === null,
			cpuThrottleNull: p.cpuThrottle === null,
			// WHICH shape landed in each slot, so the live suite can catch the
			// two readings being assigned to each other's field.
			psiShape: p.psi === null
				? null
				: ('cpuSome10' in p.psi ? 'psi' : 'throttle'),
			cpuThrottleShape: p.cpuThrottle === null
				? null
				: ('throttledRatio' in p.cpuThrottle ? 'throttle' : 'psi'),
			hasOnPressure: typeof platform.onPressure === 'function',
			hasOnPublishRate: typeof platform.onPublishRate === 'function'
		});
		return;
	}
	if (msg && msg.type === 'fixture-end') {
		// The close rule, driven from a client: end(code, reason) as given, a
		// reason sent as UTF-8 bytes when asked, or the hard close().
		const reason = msg.reasonBytes !== undefined ? new TextEncoder().encode(msg.reasonBytes) : msg.reason;
		try {
			if (msg.hard) ws.close(msg.code, reason);
			else ws.end(msg.code, reason);
		} catch (err) {
			platform.send(ws, '__fixture', 'end-refused', { name: err?.name ?? null });
		}
		return;
	}
	// Membership changed by the app, outside the wire protocol - the way a
	// plugin joins a connection to a topic. `tracked` and `tracked-leave` use
	// the ./subscriptions entry; `raw` and `raw-leave` write the connection's
	// registry by hand next to a bare ws.subscribe, the shape the entry
	// replaces, so the live suite can show what that leaves behind. Answered
	// once the operation has run, so the suite waits on the answer.
	if (msg && msg.type === 'fixture-membership') {
		const registry = ws.getUserData()[Symbol.for('adapter-uws.ws.subscriptions')];
		let ok = null;
		if (msg.mode === 'tracked') ok = trackedSubscribe(ws, msg.topic);
		else if (msg.mode === 'tracked-leave') ok = trackedUnsubscribe(ws, msg.topic);
		else if (msg.mode === 'raw') {
			ws.subscribe(msg.topic);
			registry.add(msg.topic);
			ok = true;
		} else if (msg.mode === 'raw-leave') {
			registry.delete(msg.topic);
			ws.unsubscribe(msg.topic);
			ok = true;
		}
		platform.send(ws, '__fixture', 'membership', { nonce: msg.nonce, ok });
		return;
	}
	if (msg && msg.type === 'fixture-request-id') {
		platform.send(ws, '__fixture', 'request-id', { requestId: platform.requestId ?? null });
		return;
	}
	if (msg && msg.type === 'fixture-stats') {
		platform.send(ws, '__fixture', 'stats', {
			connections: platform.connections,
			subscribers: platform.subscribers(msg.topic),
			maxPayloadLength: platform.maxPayloadLength,
			closedWsAborts: platform.closedWsAborts,
			buffered: platform.bufferedAmount(ws)
		});
		return;
	}
	// Everything else is echoed verbatim.
	ws.send(typeof data === 'string' ? data : String(data), false, false);
}

/**
 * Denies one topic so the smoke test can prove the gate runs.
 *
 * Async for `slow:` topics, and that is the point rather than a detail: Bun does
 * not await the message handler, so an app gate that actually awaits (a session
 * lookup, a DB read - the shape this whole slice is designed around) lets a
 * client pipeline subscribe frames that are ALL in the gate at once. That is the
 * path the per-connection cap has to bound, and it cannot be reached with a
 * synchronous hook: microtask-only awaits still serialize.
 */
export async function subscribe(ws, topic, context) {
	if (releaseProbe.handles(topic)) return releaseProbe.subscribe(ws, topic, context);
	if (topic === 'forbidden') return 'FORBIDDEN';
	if (topic.startsWith('held:')) {
		const data = ws.getUserData();
		let pending = heldSubscribes.get(data);
		if (!pending) heldSubscribes.set(data, pending = []);
		await new Promise(resolve => pending.push(resolve));
	}
	if (topic.startsWith('slow:')) {
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	return null;
}

/**
 * Fires whether or not the connection actually held the subscription.
 *
 * A `hang:` topic never settles, which is how the live suite reaches the case
 * where a connection dies with a release still in flight. The release itself
 * has already happened by then - the topic is out of the subscription set - so
 * the only thing that can still tear down the app's per-topic state is the
 * close hook being told about it.
 */
export function unsubscribe(ws, topic, { platform }) {
	if (releaseProbe.handles(topic)) return releaseProbe.unsubscribe(ws);
	platform.send(ws, '__fixture', 'unsubscribe-hook', { topic });
	if (topic.startsWith('hang:')) return new Promise(() => {});
}

export async function close(ws, ctx) {
	releaseProbe.close(ws);
	const topics = [...ctx.subscriptions].sort().join(',');
	console.log(
		`[fixture] close code=${ctx.code} subs=${ctx.subscriptions.size} topics=${topics} in=${ctx.messagesIn} out=${ctx.messagesOut}`
	);
	// Deferred teardown behind a real timer, not a microtask: an exit that cuts
	// async close work short is visible as a missing completion line, which is
	// exactly what the shutdown suite asserts against.
	await new Promise((resolve) => setTimeout(resolve, 150));
	console.log(`[fixture] close-async done code=${ctx.code}`);
}
