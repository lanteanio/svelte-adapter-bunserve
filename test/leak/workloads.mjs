/** Connect with a bounded handshake, rejecting an early close. */
async function connect(url) {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error('WebSocket handshake timed out')), 5000);
		const finish = (error) => {
			clearTimeout(timer);
			ws.onopen = ws.onerror = ws.onclose = null;
			if (error) { ws.close(); reject(error); } else resolve();
		};
		ws.onopen = () => finish();
		ws.onerror = () => finish(new Error('WebSocket handshake failed'));
		ws.onclose = () => finish(new Error('WebSocket closed before opening'));
	});
	return ws;
}

/** Wait for the acknowledgement belonging to this operation. */
function exchange(ws, frame, expected) {
	return new Promise((resolve, reject) => {
		const finish = (error) => {
			clearTimeout(timer);
			ws.removeEventListener('message', message);
			ws.removeEventListener('close', closed);
			ws.removeEventListener('error', closed);
			error ? reject(error) : resolve();
		};
		const closed = () => finish(new Error('WebSocket closed during an operation'));
		const message = ({ data }) => {
			let msg;
			try { msg = JSON.parse(data); } catch { return; }
			if (!msg || msg.ref !== frame.ref || msg.topic !== frame.topic) return;
			if (msg.type === expected) finish();
			else if (msg.type === 'subscribe-denied') finish(new Error('subscription denied'));
		};
		const timer = setTimeout(() => finish(new Error('WebSocket operation timed out')), 5000);
		ws.addEventListener('message', message);
		ws.addEventListener('close', closed);
		ws.addEventListener('error', closed);
		try { ws.send(JSON.stringify(frame)); } catch (error) { finish(error); }
	});
}

/** A fresh connection exercises subscribe and close teardown. */
export async function churnConnection(url, topic) {
	const ws = await connect(url);
	try {
		await exchange(ws, { type: 'subscribe', topic, ref: 1 }, 'subscribed');
	} finally {
		ws.close();
	}
}

/**
 * Held sockets exercise bounded topic registries without handshake churn: each
 * unit subscribes, has the server publish to the topic and revoke it, without
 * waiting for any reply. The connections do not move, so anything that grows
 * grows per topic rather than per socket.
 */
export async function topicWorkload(url, count = 4) {
	const sockets = [];
	let cursor = 0;
	try {
		for (let i = 0; i < count; i++) sockets.push(await connect(url));
	} catch (error) {
		for (const ws of sockets) ws.close();
		throw error;
	}
	return {
		async unit() {
			const ref = ++cursor;
			const ws = sockets[ref % sockets.length];
			const topic = `leak-lane-${ref % 512}`;
			ws.send(JSON.stringify({ type: 'subscribe', topic, ref }));
			ws.send(JSON.stringify({ type: 'broadcast', topic, payload: { i: ref } }));
			ws.send(JSON.stringify({ type: 'revoke-topic', topic }));
			if (ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket closed during an operation');
		},
		close() {
			for (const ws of sockets) ws.close();
		}
	};
}
