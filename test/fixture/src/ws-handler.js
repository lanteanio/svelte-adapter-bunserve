// Fixture WebSocket handler. Exercises every hook the adapter delegates to,
// and refuses one topic so the authorization gate is covered by the live smoke
// test rather than only by unit tests.

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
	console.log(`[fixture] init connections=${platform.connections}`);
}

/**
 * Per-topic scripts for the honest-watermark lane, armed by `fixture-resume-plan`.
 *
 * The default hook below reports the offset the CLIENT presented, which is the
 * natural hook shape but is useless for testing the dedup boundary: the runtime
 * trusts a reported watermark only up to what it has actually stamped, so an
 * echoed client offset on a topic with no explicit mark is always refused and
 * the boundary is never exercised. A planned topic instead publishes known
 * explicit seqs INSIDE the barrier window, DELIVERS the ones at or below
 * `report` to the resuming socket itself, and reports `report` as covered.
 *
 * The delivery is what makes the report TRUE, and it is not a formality: the
 * hook's contract is the highest seq it actually delivered, and the flush drops
 * everything at or below what it returns. A plan that published 21, 22 and 23
 * into the topic and reported 22 without sending anything would leave the
 * client short of 21 and 22 for good - a seq the server stamped is not a seq
 * the client received.
 *
 * @type {Map<string, { report: number, publish: number[] }>}
 */
const resumePlans = new Map();

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
		const plan = resumePlans.get(topic);
		if (plan === undefined) {
			covered[topic] = typeof since === 'number' ? since : 0;
			continue;
		}
		// Published from inside the hook, so these land in the barrier window
		// the resuming connection has open - the case the flush's dedup floor
		// exists for. Deterministic by construction: no second connection has
		// to race the 30 ms above.
		for (const seq of plan.publish) {
			platform.publish(topic, 'said', { inWindow: seq }, { seq });
		}
		// Now DELIVER everything the report is about to claim. Derived from
		// `report` rather than listed separately on the plan so the fixture
		// cannot arm a watermark it did not honour: the frames the flush will
		// drop are exactly the frames sent here.
		for (const seq of plan.publish) {
			if (seq <= plan.report) {
				platform.send(ws, topic, 'said', { inWindow: seq, viaHook: true });
			}
		}
		covered[topic] = plan.report;
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
	if (url.searchParams.get('deny') === '1') {
		return new Response('nope', { status: 401 });
	}
	const offered = request.headers.get('sec-websocket-protocol');
	if (offered) {
		headers['sec-websocket-protocol'] = offered.split(',')[0].trim();
	}
	return { user: url.searchParams.get('user') || 'anon' };
}

export function open(ws, { platform }) {
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
	// The EXPLICIT (cluster) seq lane. The `{ seq: true }` drivers above draw
	// from this process's counter, which never marks a topic as explicitly
	// stamped - so nothing they publish can exercise the reported-watermark
	// path at all.
	if (msg && msg.type === 'fixture-publish-seq') {
		platform.publish(msg.topic, 'said', msg.data, { seq: msg.seq });
		return;
	}
	if (msg && msg.type === 'fixture-resume-plan') {
		resumePlans.set(msg.topic, { report: msg.report, publish: msg.publish });
		platform.send(ws, '__fixture', 'resume-planned', { topic: msg.topic });
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
