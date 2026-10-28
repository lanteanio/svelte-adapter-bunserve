export async function connectRealClient(wsUrl, { headers } = {}) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl, headers ? { headers } : undefined);
	/** @type {string[]} */
	const frames = [];
	ws.on('message', (data) => { frames.push(data.toString()); });
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});

	return {
		ws,
		frames,
		/** @param {unknown} msg */
		send(msg) { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
		/**
		 * Resolve with the first received frame matching `predicate`, or null on
		 * timeout. Returning null rather than throwing lets a test assert that
		 * something was NOT delivered, which is the shape most access-control
		 * assertions need.
		 *
		 * SCANS THE WHOLE FRAME HISTORY, deliberately (the negative-assertion
		 * shape above needs it). The cost: two waits with the same predicate on
		 * one connection BOTH resolve with the first matching frame - a probe
		 * repeated to observe a change reads its own earlier answer back and the
		 * assertion goes vacuous. Any request/response probe a test issues more
		 * than once per connection must carry a correlator the server echoes (a
		 * nonce) and match on it.
		 * @param {(parsed: any, raw: string) => boolean} predicate
		 * @param {number} [ms]
		 */
		async waitFor(predicate, ms = 500) {
			const deadline = Date.now() + ms;
			for (;;) {
				for (const raw of frames) {
					let parsed = null;
					try { parsed = JSON.parse(raw); } catch { /* non-JSON frame */ }
					if (predicate(parsed, raw)) return { parsed, raw };
				}
				if (Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		},
		close() {
			try { ws.terminate(); } catch { /* already gone */ }
		}
	};
}
