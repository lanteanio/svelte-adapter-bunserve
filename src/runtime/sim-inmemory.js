// In-memory doubles of the Bun.serve surface that the REAL handler dispatch
// drives under the simulator: the server object (publish/subscriberCount/
// upgrade) and the raw ServerWebSocket shape the facade wraps. Swapping the
// real server for these lets the exact production handler modules run under
// the virtual clock + seeded fault engine: no real sockets, no real timers,
// every frame routed through one fault-gated channel.
//
// Simulation infrastructure, not framework runtime. The uws sibling's double
// models a uWS App; this one models what bunserve actually consumes - `ws.data`
// for userData, byte-count send results, server-level publish - so the facade
// and handlers behave exactly as they do over real Bun.

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * The one fixed origin the whole sim agrees on: sim.js pins process.env.ORIGIN
 * to this before config.js loads, and every simulated client's Host/Origin
 * headers and request url derive from it. One constant, because the two sides
 * drifting apart would turn every upgrade cross-origin and refuse it.
 */
export const SIM_ORIGIN = 'http://sim.invalid';
const SIM_HOST = new URL(SIM_ORIGIN).host;

/**
 * Build the in-memory Bun app double. The returned object carries the server
 * double (`_server`, handed to setServer and to tryUpgrade), the live
 * connection set the invariant snapshot reads, and the sim-only `connect()`
 * entry the runner drives clients through.
 *
 * @param {{
 *   scheduler: any,
 *   faultEngine: { plan: (p: string | Uint8Array) => Array<{ delayMs: number, payload: string | Uint8Array }> },
 *   dispatch: {
 *     websocketHandlers: { open: Function, message: Function, close: Function, drain?: Function },
 *     tryUpgrade: (req: Request, srv: any, pathname: string) => null | Promise<Response | undefined>,
 *     wsPath: string
 *   }
 * }} opts
 */
export function createInMemoryApp(opts) {
	const scheduler = opts.scheduler;
	const faults = opts.faultEngine;
	const { websocketHandlers, tryUpgrade, wsPath } = opts.dispatch;

	/** @type {Set<any>} live raw server-side ws doubles */
	const connections = new Set();
	let connSeq = 0;

	/**
	 * Schedule a one-way channel delivery through the fault engine + virtual
	 * clock. A dropped frame schedules nothing; delayed/duplicated frames land
	 * in a later timers phase, so reorder emerges from per-frame sampled delays.
	 * @param {string | Uint8Array} payload
	 * @param {(payload: string | Uint8Array) => void} sink
	 */
	function channelSend(payload, sink) {
		const plan = faults.plan(payload);
		for (const d of plan) {
			scheduler._scheduleTimer(() => sink(d.payload), d.delayMs, [], false);
		}
	}

	/** @param {string | Uint8Array} payload */
	function payloadBytes(payload) {
		return typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
	}

	// - The raw Bun ServerWebSocket double -------------------------------------

	/**
	 * @param {any} data - the userData object srv.upgrade was handed
	 * @param {{ deliver: Function, onServerClose: Function }} clientSide
	 */
	function makeRawWs(data, clientSide) {
		/** @type {Set<string>} native membership (the stand-in for Bun's topic tree) */
		const topics = new Set();
		const id = connSeq++;
		const raw = {
			_simId: id,
			_topics: topics,
			data,
			readyState: 1,
			remoteAddress: '127.0.0.1',
			/**
			 * Bun shape: returns the byte count accepted; the facade maps it to
			 * the uWS tri-state. A closed socket returns 0 without throwing -
			 * exactly the probed Bun behavior the facade exists to guard.
			 */
			send(payload, _compress) {
				if (raw.readyState !== 1) return 0;
				channelSend(payload, (p) => clientSide.deliver(p, typeof payload !== 'string', undefined));
				return payloadBytes(payload);
			},
			subscribe(topic) {
				if (raw.readyState !== 1) return true; // probed: Bun lies on closed sockets
				topics.add(topic);
				return true;
			},
			unsubscribe(topic) {
				if (raw.readyState !== 1) return true;
				return topics.delete(topic);
			},
			isSubscribed(topic) {
				if (raw.readyState !== 1) return false;
				return topics.has(topic);
			},
			getBufferedAmount() {
				return 0;
			},
			/** Connection-level publish: every subscriber EXCEPT self (probed default). */
			publish(topic, payload, _compress) {
				if (raw.readyState !== 1) return 0;
				let delivered = false;
				for (const ws of connections) {
					if (ws !== raw && ws._topics.has(topic)) {
						ws._deliver(payload, topic);
						delivered = true;
					}
				}
				return delivered ? payloadBytes(payload) : 0;
			},
			/** Bun's graceful close: fires the close handler, like a real socket teardown. */
			close(code = 1000, reason = '') {
				if (raw.readyState !== 1) return;
				raw.readyState = 3;
				connections.delete(raw);
				websocketHandlers.close(raw, code, String(reason));
				clientSide.onServerClose(code, String(reason));
			},
			/** Bun's hard cut: the client sees 1006. */
			terminate() {
				raw.close(1006, '');
			},
			/**
			 * Sim-only: deliver server->client through the fault-gated channel.
			 * The routing topic rides OUTSIDE the (corruptible) payload so the
			 * steady-state misdelivery and starvation checks correlate against
			 * the uncorrupted key, exactly as the sibling sim does.
			 */
			_deliver(payload, routingTopic) {
				channelSend(payload, (p) => clientSide.deliver(p, typeof payload !== 'string', routingTopic));
			}
		};
		return raw;
	}

	// - Upgrade correlation -----------------------------------------------------

	/**
	 * tryUpgrade is async (the app's upgrade hook may await), so several
	 * connects can be in flight at once; the Request object is the correlation
	 * key between connect() and the srv.upgrade() call the dispatch makes.
	 * @type {WeakMap<Request, { clientSide: any, onUpgraded: (raw: any) => void }>}
	 */
	const pendingUpgrades = new WeakMap();

	// - The Bun server double ----------------------------------------------------

	const server = {
		/**
		 * Native fan-out: every subscriber including the publisher's own
		 * connection (server-level publish has no self to exclude). Returns the
		 * byte count on delivery and 0 when the topic has no subscribers - the
		 * probed Bun.serve semantics the platform's return mapping reads.
		 */
		publish(topic, payload, _compress) {
			let delivered = false;
			for (const ws of connections) {
				if (ws._topics.has(topic)) {
					ws._deliver(payload, topic);
					delivered = true;
				}
			}
			return delivered ? payloadBytes(payload) : 0;
		},
		subscriberCount(topic) {
			let n = 0;
			for (const ws of connections) if (ws._topics.has(topic)) n++;
			return n;
		},
		/**
		 * The dispatch's upgrade call. Synchronously creates the connection and
		 * fires the real open handler, the same shape as Bun accepting the
		 * socket; returns true so runUpgrade reports success.
		 */
		upgrade(req, opts2) {
			const pending = pendingUpgrades.get(req);
			if (!pending) return false;
			pendingUpgrades.delete(req);
			const data = opts2 && opts2.data && typeof opts2.data === 'object' ? opts2.data : {};
			const raw = makeRawWs(data, pending.clientSide);
			connections.add(raw);
			websocketHandlers.open(raw);
			pending.onUpgraded(raw);
			return true;
		},
		requestIP() {
			return { address: '127.0.0.1' };
		},
		stop() { /* the sim tears down through close(), never through Bun.serve */ }
	};

	// - The client facade ---------------------------------------------------------

	/**
	 * Open a client connection through the REAL upgrade lane: build the
	 * Request, run tryUpgrade (which may await the app's upgrade hook), and on
	 * srv.upgrade() the raw ws exists and the real open handler has run. An
	 * async upgrade settles during scheduler.run().
	 *
	 * @param {{ headers?: Record<string, string>, query?: string }} [connectOpts]
	 */
	function connect(connectOpts = {}) {
		/** @type {Array<{ payload: string | Uint8Array, isBinary: boolean }>} */
		const received = [];
		/** @type {Array<Function>} */
		const messageHandlers = [];
		let serverWs = null;
		let openState = 'connecting'; // 'connecting' | 'open' | 'rejected' | 'closed'
		let rejection = null;
		let closeInfo = null;

		const clientSide = {
			deliver(payload, isBinary, routingTopic) {
				const frame = { payload, isBinary, routingTopic };
				received.push(frame);
				for (const h of messageHandlers) h(frame);
			},
			onServerClose(code, reason) {
				if (openState === 'closed') return;
				openState = 'closed';
				closeInfo = { code, reason };
			}
		};

		const headers = {
			upgrade: 'websocket',
			connection: 'Upgrade',
			host: SIM_HOST,
			origin: SIM_ORIGIN,
			...(connectOpts.headers || {})
		};
		const url = SIM_ORIGIN + wsPath + (connectOpts.query ? '?' + connectOpts.query : '');
		// Carries a signal so a scenario can model the client that LEAVES
		// mid-handshake. Without one, `req.signal` never aborts and the
		// hang-up half of the upgrade path - the admission slots coming back
		// while the app's hook is still awaiting - is unreachable from here,
		// which is to say unreachable from the one tool built to explore
		// orderings.
		const client = new AbortController();
		const req = new Request(url, { headers, signal: client.signal });
		pendingUpgrades.set(req, {
			clientSide,
			onUpgraded(raw) {
				serverWs = raw;
				// NOT unconditional. `websocketHandlers.open(raw)` runs before
				// this, inside the upgrade call, exactly as the runtime
				// dispatches it - so an app hook that closes its socket in
				// `open` has already driven `onServerClose` by now. Writing
				// 'open' over that would un-close the connection: the client
				// would report itself connected while carrying the close code
				// it was refused with, and every later assertion would be
				// reasoning about a socket that does not exist. That ordering
				// is one this simulator exists to explore, not an edge of it.
				if (openState === 'closed') return;
				openState = 'open';
			}
		});

		const outcome = tryUpgrade(req, server, wsPath);
		if (outcome === null) {
			openState = 'rejected';
			rejection = { status: 'not-ws-path', body: '' };
		} else {
			Promise.resolve(outcome).then(
				(resp) => {
					// undefined = upgraded (srv.upgrade already fired open); a
					// Response is a refusal with its own status.
					if (resp && openState === 'connecting') {
						openState = 'rejected';
						rejection = { status: String(resp.status), body: '' };
					}
				},
				(err) => {
					if (openState === 'connecting') {
						openState = 'rejected';
						rejection = { status: '500', body: String((err && err.message) || err) };
					}
				}
			);
		}

		const facade = {
			get state() { return openState; },
			get rejection() { return rejection; },
			get closeInfo() { return closeInfo; },
			/** Raw frames as received, in delivery order. */
			frames: () => received.slice(),
			/** Frames decoded to UTF-8 text. */
			texts: () => received.map((f) => (typeof f.payload === 'string' ? f.payload : dec.decode(f.payload))),
			/** Frames parsed as JSON envelopes; non-JSON (binary) frames become null. */
			json: () => received.map((f) => {
				try { return JSON.parse(typeof f.payload === 'string' ? f.payload : dec.decode(f.payload)); } catch { return null; }
			}),
			onMessage: (cb) => { messageHandlers.push(cb); },
			/** Send a raw frame client -> server through the fault-gated channel. */
			sendRaw(payload, isBinary = false) {
				if (!serverWs || openState !== 'open') return false;
				channelSend(payload, (p) => {
					// Bun's message handler receives a STRING for text frames and
					// bytes for binary ones; the demux branches on exactly that.
					const msg = isBinary
						? (typeof p === 'string' ? Buffer.from(enc.encode(p)) : Buffer.from(p))
						: (typeof p === 'string' ? p : dec.decode(p));
					websocketHandlers.message(serverWs, msg);
				});
				return true;
			},
			/** Send a JSON control/envelope frame. */
			send(obj) { return facade.sendRaw(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
			subscribe(topic, ref) { return facade.send({ type: 'subscribe', topic, ref: ref ?? topic }); },
			unsubscribe(topic) { return facade.send({ type: 'unsubscribe', topic }); },
			/** Client-initiated close. */
			close(code = 1000, reason = '') {
				if (serverWs && openState === 'open') serverWs.close(code, reason);
				openState = 'closed';
			},
			/**
			 * The client goes away mid-handshake, before there is a socket to
			 * close: the TCP-level hang-up, which the server learns about
			 * through the request's abort signal rather than through a close
			 * frame. This is what a connect-then-drop storm is made of, and the
			 * only way to reach the upgrade path's hang-up branches from a
			 * scenario.
			 */
			hangUp() {
				if (openState !== 'connecting') return false;
				client.abort();
				return true;
			},
			get serverWs() { return serverWs; }
		};
		return facade;
	}

	return {
		connect,
		_server: server,
		_connections: connections
	};
}
