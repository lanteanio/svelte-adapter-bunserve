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
}

/**
 * Runs before the handshake. Whatever object this returns becomes the
 * connection's userData; returning a Response rejects the upgrade with exactly
 * that response.
 */
export function upgrade(request) {
	const url = new URL(request.url);
	if (url.searchParams.get('deny') === '1') {
		return new Response('nope', { status: 401 });
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

/** Fires whether or not the connection actually held the subscription. */
export function unsubscribe(ws, topic, { platform }) {
	platform.send(ws, '__fixture', 'unsubscribe-hook', { topic });
}

export function close(ws, ctx) {
	console.log(
		`[fixture] close code=${ctx.code} subs=${ctx.subscriptions.size} in=${ctx.messagesIn} out=${ctx.messagesOut}`
	);
}
