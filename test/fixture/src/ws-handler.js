// Fixture WebSocket handler. Exercises every hook the adapter delegates to,
// and refuses one topic so the authorization gate is covered by the live smoke
// test rather than only by unit tests.

/**
 * A DELIBERATE leak, armed only by the leak harness's self-check.
 *
 * A gate that has never been seen to fail is a gate nobody can trust. This
 * retains `LEAK_INJECT` bytes per connection and never releases them, which is
 * the plainest leak an app can have, so the harness can prove its verdict
 * fires on one. Unset - which is every other run, and every real build - the
 * array is never touched.
 *
 * Refused rather than coerced, because the failure is so misleading: a value
 * like `64k` becomes NaN, `NaN > 0` is false, nothing is injected, and the lane
 * then reports that its memory gates could not catch a leak. That accuses the
 * gates of the bug when the typo was in the arming.
 */
const LEAK_INJECT = readInjectBytes();

function readInjectBytes() {
	const raw = process.env.LEAK_INJECT?.trim();
	if (raw === undefined || raw === '') return 0;
	const bytes = Number(raw);
	if (!Number.isFinite(bytes) || bytes < 0) {
		throw new Error(`LEAK_INJECT=${JSON.stringify(raw)} is not a byte count`);
	}
	return bytes;
}
/** @type {Uint8Array[]} */
const leaked = [];

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
	platform.registerWireCodec(xyWire);
	platform.registerWireCodec(snapWire);
	// An APP instrument on the adapter's registry, so the live lane can prove
	// the app's own metrics land in the same document as the adapter's - which
	// is the thing a registry the app imported for itself could not do.
	fixtureOpens = platform.metrics.counter('fixture_opens_total', 'sockets opened, counted by the app');
	console.log(`[fixture] init connections=${platform.connections}`);
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
 * @type {Map<string, { report: number, publish: number[] }>}
 */
const resumeScripts = new Map();

/**
 * Gap-fill for a recover offset or a standalone resume frame. Awaits a real
 * timer so the live suite exercises the barrier window the runtime bridges,
 * sends one identifiable replay frame per topic, and reports the offset as
 * the covered watermark - anything the runtime buffered past it must then
 * arrive after these frames and before the ack.
 */
export async function resume(ws, { sessionId, lastSeenSeqs, platform }) {
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
			platform.publish(topic, 'said', { inWindow: seq }, { seq });
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
export function shutdown({ platform }) {
	console.log(`[fixture] shutdown connections=${platform.connections}`);
	// Armed per spawn: a hook that never settles, so the live suite can prove
	// the shutdown deadline cuts a misbehaving hook instead of letting it hold
	// the process open.
	if (process.env.FIXTURE_HANG_SHUTDOWN === '1') return new Promise(() => {});
}

/**
 * Runs before the handshake. Whatever object this returns becomes the
 * connection's userData; returning a Response rejects the upgrade with exactly
 * that response.
 *
 * Async behind a real timer on purpose: the adapter promises the hook may
 * await freely, and only an actually-awaited hook makes the live suite prove
 * the handshake survives it. The subprotocol selection goes through the
 * context headers channel for the same reason - the client can read the
 * negotiated protocol off its own socket, so the 101 carrying what this hook
 * set is observable end to end.
 */
export async function upgrade(request, { headers }) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	const url = new URL(request.url);
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
		return new Response('nope', { status: 401 });
	}
	const offered = request.headers.get('sec-websocket-protocol');
	if (offered) {
		headers['sec-websocket-protocol'] = offered.split(',')[0].trim();
	}
	return { user: url.searchParams.get('user') || 'anon' };
}

/**
 * The auth preflight, exercised by test/live/auth-endpoint-check.mjs.
 *
 * Every branch a real hook has: refresh a cookie and answer implicitly, refuse,
 * answer with a Response of its own, or throw. Which one it takes is chosen by
 * the query string, so one build covers all of them.
 */
export async function authenticate(request, { cookies, platform, getClientAddress }) {
	const url = new URL(request.url);
	const mode = url.searchParams.get('mode') || 'ok';
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
			headers: { 'content-type': 'application/json' }
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
	// Retained on purpose and never released; see LEAK_INJECT. Filled so the
	// bytes are unambiguously touched on any allocator that maps lazily. On Bun
	// it made no measurable difference across four isolated trials - the filled
	// and unfilled readings agreed in rss, heapUsed and external - so this is
	// belt and braces for a runtime that behaves otherwise, not a load-bearing
	// detail. The gate itself runs on Linux in CI, where it was not measured.
	if (LEAK_INJECT > 0) leaked.push(new Uint8Array(LEAK_INJECT).fill(1));
	// Echo the connection count back so the smoke test can assert the registry
	// tracks opens.
	platform.send(ws, '__fixture', 'opened', {
		user: ws.getUserData().user,
		connections: platform.connections
	});
}

export function message(ws, { data, isBinary, msg, platform }) {
	if (isBinary) {
		ws.send(data, true, false);
		return;
	}
	// A control-shaped frame the adapter did not consume arrives pre-parsed.
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
		resumeScripts.set(msg.topic, { report: msg.report, publish: msg.publish });
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
export async function subscribe(ws, topic) {
	if (topic === 'forbidden') return 'FORBIDDEN';
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
	platform.send(ws, '__fixture', 'unsubscribe-hook', { topic });
	if (topic.startsWith('hang:')) return new Promise(() => {});
}

export async function close(ws, ctx) {
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
