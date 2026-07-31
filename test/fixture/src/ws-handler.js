// Fixture WebSocket handler. Exercises every hook the adapter delegates to,
// and refuses one topic so the authorization gate is covered by the live smoke
// test rather than only by unit tests.

/** Once at boot, after the listener is up. The family's arming point. */
export function init({ platform }) {
	console.log(`[fixture] init connections=${platform.connections}`);
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
