import { setTimer, clearTimer } from '../runtime.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { WS_PLATFORM } from './ws-symbols.js';

// Recipient delivery authorization: an opt-in, worker-wide policy that every
// adapter-built application frame passes on its way to one socket.
//
// A frame the policy admits synchronously goes straight to the transport. A
// frame whose decision is still pending, or that meets bytes the transport has
// not flushed yet, waits in a per-socket FIFO, and every later frame for that
// socket - control frames included - queues behind it, so nothing overtakes a
// held frame. Held frames reach the transport only while its own buffer is
// empty: an application frame is decided as late as possible, and a frame
// handed to an empty buffer is never dropped by it.
//
// Without a policy every entry point is one branch in front of the native call.
//
// Binary frames are adapter-built and never mutated once handed to a sender,
// so a held frame is retained by reference, never copied.

/** A delivery the policy refused. A retry-class close: admission decides again. */
export const DELIVERY_REFUSED_CLOSE_CODE = 1013;

/** A policy that threw, answered with a non-boolean, or exceeded its time bound. */
export const DELIVERY_FAILED_CLOSE_CODE = 1011;

/** Policy time bound per pending decision, in milliseconds, unless configured. */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 5000;

/** Pending-byte bound per socket when the surface supplies no transport bound. */
export const DEFAULT_DELIVERY_PENDING_BYTES = 1048576;

// The longest delay a timer honors; Node clamps a longer one to 1 ms.
const MAX_TIMEOUT_MS = 2147483647;
// Charged per held frame on top of its payload: the entry object and its queue
// slot, about 100 bytes on 64-bit Node, rounded up.
const ENTRY_OVERHEAD_BYTES = 128;
// A delivered prefix longer than this is cut from the queue array.
const COMPACT_AFTER = 1024;
const REPLAY_PREFIX = '__replay:';
const OPTION_KEYS = new Set(['maxPendingBytes', 'timeoutMs']);

const APPLICATION = 0;
const CONTROL = 1;

const CLOSE_REASONS = Object.freeze({
	denied: 'Delivery not authorized',
	'invalid-result': 'Delivery authorization failed',
	error: 'Delivery authorization failed',
	unattributed: 'Delivery authorization failed',
	reset: 'Delivery authorization failed',
	timeout: 'Delivery authorization timed out'
});

function refusal(reason, error) {
	return { reason, error };
}

// A decision abandoned because its connection closed: nothing to report.
const CLOSED = Object.freeze(refusal('closed'));

function isThenable(value) {
	return value !== null && (typeof value === 'object' || typeof value === 'function') &&
		typeof value.then === 'function';
}

function requestIdOf(ws) {
	try { return ws.getUserData()?.[WS_PLATFORM]?.requestId ?? null; } catch { return null; }
}

function reportDenied(ws, closeCode) {
	emitOperationalEvent({
		source: 'svelte-adapter-bunserve',
		component: 'runtime.delivery-authorization',
		event: 'delivery-authorization.denied',
		severity: 'warn',
		dataClass: 'pseudonymous',
		message: 'The delivery policy refused a frame and its connection is closed; closeCode is 1013, or null when it was already closed.',
		attributes: { requestId: requestIdOf(ws), reason: 'denied', closeCode }
	});
}

// A frame that cannot be described failed to parse, and a parser error quotes
// the text it read: only the error class is reported for it.
function failureDetail(reason, error) {
	if (error === undefined) return null;
	if (reason !== 'error') return { name: typeof error?.name === 'string' ? error.name : 'Error' };
	return diagnosticError(error);
}

// Kept apart from reportDenied: each emission block is read on its own.
function reportFailed(ws, reason, error, closeCode) {
	emitOperationalEvent({
		source: 'svelte-adapter-bunserve',
		component: 'runtime.delivery-authorization',
		event: 'delivery-authorization.failed',
		severity: 'error',
		dataClass: 'pseudonymous',
		message: 'The delivery policy could not decide a frame and its connection is closed; closeCode is 1011, or null when it was already closed.',
		attributes: {
			requestId: requestIdOf(ws),
			reason,
			closeCode,
			error: failureDetail(reason, error)
		}
	});
}

// One logical message as the policy sees it, frozen: the same object is shown
// to every recipient's check. A replay-channel frame is shown under the topic
// it replays.
function message(topic, event, data, binary) {
	if (topic.charCodeAt(0) === 95 && topic.startsWith(REPLAY_PREFIX)) {
		return Object.freeze({ topic: topic.substring(REPLAY_PREFIX.length), event, data, binary, kind: 'replay' });
	}
	return Object.freeze({ topic, event, data, binary, kind: 'message' });
}

// The logical messages one frame carries. A batch carries several and is
// admitted only when every one of them is.
function describe(payload, binary, topic) {
	if (binary) {
		if (typeof topic !== 'string') throw new TypeError('Unattributed binary delivery');
		return Object.freeze([message(topic, null, undefined, true)]);
	}
	const value = JSON.parse(payload);
	if (value === null || typeof value !== 'object') throw new TypeError('Unattributed delivery');
	if (value.type === 'batch') {
		const events = value.events;
		if (!Array.isArray(events) || events.length === 0) throw new TypeError('Invalid delivery batch');
		const messages = new Array(events.length);
		for (let i = 0; i < events.length; i++) {
			const item = events[i];
			if (item === null || typeof item !== 'object' || typeof item.topic !== 'string') {
				throw new TypeError('Unattributed batch delivery');
			}
			messages[i] = message(item.topic, item.event ?? null, item.data, false);
		}
		return Object.freeze(messages);
	}
	if (value.type === 'request') {
		return Object.freeze([Object.freeze({ topic: null, event: value.event ?? null, data: value.data, binary: false, kind: 'request' })]);
	}
	if (typeof value.topic !== 'string') throw new TypeError('Unattributed delivery');
	return Object.freeze([message(value.topic, value.event ?? null, value.data, false)]);
}

/**
 * Create one delivery authorization boundary. Each surface (production worker,
 * test server, dev server) owns one and routes every adapter-built frame
 * through it.
 *
 * @param {{
 *   maxPendingBytes?: number,
 *   closeOnOverflow?: boolean,
 *   onIdle?: (ws: any) => void,
 *   onDrop?: (ws: any, bytes: number) => void
 * }} [surface] the surface's transport bound (its maxBackpressure), whether
 *   that bound closes a connection, a callback for a socket whose held frames
 *   drained, and one for a frame dropped past the bound
 */
export function createDeliveryAuthorization(surface = {}) {
	const defaultMaxPendingBytes = Number.isSafeInteger(surface.maxPendingBytes) && surface.maxPendingBytes > 0
		? surface.maxPendingBytes
		: DEFAULT_DELIVERY_PENDING_BYTES;
	const closeOnOverflow = surface.closeOnOverflow === true;
	const onDrop = typeof surface.onDrop === 'function' ? surface.onDrop : null;
	let onIdle = typeof surface.onIdle === 'function' ? surface.onIdle : null;
	let authorize = null;
	let maxPendingBytes = defaultMaxPendingBytes;
	let timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS;
	// Only sockets holding frames (or refused and awaiting their close) are here.
	/** @type {Map<object, any>} */
	const backlogs = new Map();
	// Sockets whose close event arrived: they answer like a closed native socket.
	const released = new WeakSet();
	// Gate operations in progress (a send, a publish walk, a drain, or an adapter
	// fan-out between begin and finish), and policy calls running inside them.
	// Every operation a policy issues while deciding is queued here and run, in
	// the order the policy issued them, once the outermost operation finished
	// and no decision is in progress.
	let depth = 0;
	let inPolicy = 0;
	let policySocket = null;
	let queued = null;
	let endings = 0;
	let endWaiters = [];

	function enter() {
		depth++;
	}

	// A decision resumed after an await runs outside any operation; a fan-out
	// the policy opens there must not run the queue while the policy still
	// decides. The operation waiting for that decision runs it afterwards.
	function leave() {
		if (depth > 1 || inPolicy > 0) { depth--; return; }
		try {
			while (queued !== null) {
				const jobs = queued;
				queued = null;
				for (const job of jobs) {
					// A deferred operation on a socket that closed meanwhile throws
					// as the native send would; nobody is left to tell.
					try { job(); } catch {}
				}
			}
		} finally {
			depth--;
		}
	}

	function defer(job) {
		(queued ??= []).push(job);
	}

	function alive(ws) {
		const backlog = backlogs.get(ws);
		return backlog !== undefined && !backlog.closed;
	}

	// true, a refusal, or a promise of one. Messages are checked in order and
	// the first refusal ends the walk.
	function decide(ws, messages, from) {
		for (let i = from; i < messages.length; i++) {
			let verdict;
			inPolicy++;
			const priorSocket = policySocket;
			policySocket = ws;
			try {
				verdict = authorize(ws, messages[i]);
				if (verdict === true) continue;
				if (verdict === false) return refusal('denied');
				if (isThenable(verdict)) return settle(ws, messages, i + 1, verdict);
			} catch (error) {
				return refusal('error', error);
			} finally {
				inPolicy--;
				policySocket = priorSocket;
			}
			return refusal('invalid-result');
		}
		return true;
	}

	async function settle(ws, messages, from, pending) {
		let verdict;
		try { verdict = await pending; }
		catch (error) { return refusal('error', error); }
		if (verdict === false) return refusal('denied');
		if (verdict !== true) return refusal('invalid-result');
		// A socket that closed meanwhile is not asked about again.
		if (from < messages.length && !alive(ws)) return CLOSED;
		return decide(ws, messages, from);
	}

	// One parse per frame: a caller sending the same payload to many sockets
	// passes one cache, and a held frame keeps its cache for its decision.
	function messagesOf(payload, binary, topic, cache) {
		if (binary || cache == null) return describe(payload, binary, topic);
		if (cache.messages !== null && cache.payload === payload) return cache.messages;
		const messages = describe(payload, false, topic);
		cache.payload = payload;
		cache.messages = messages;
		return messages;
	}

	function decideFrame(ws, payload, binary, topic, cache) {
		let messages;
		try {
			messages = messagesOf(payload, binary, topic, cache);
		} catch (error) {
			return refusal('unattributed', error);
		}
		return decide(ws, messages, 0);
	}

	// `bytes` is what the bound counts, `held` the payload bytes the socket
	// holds: what bufferedAmount reports.
	function open(ws) {
		const backlog = {
			queue: [], head: 0, bytes: 0, held: 0, waiting: false, pumping: false, closed: false, failed: false,
			timer: null, ending: null, endTimer: null
		};
		backlogs.set(ws, backlog);
		return backlog;
	}

	function settleEnding() {
		endings--;
		if (endings === 0 && endWaiters.length > 0) {
			const waiters = endWaiters;
			endWaiters = [];
			for (const resolve of waiters) resolve();
		}
	}

	function release(backlog) {
		backlog.closed = true;
		if (backlog.ending !== null) {
			backlog.ending = null;
			settleEnding();
		}
		if (backlog.timer !== null) { clearTimer(backlog.timer); backlog.timer = null; }
		if (backlog.endTimer !== null) { clearTimer(backlog.endTimer); backlog.endTimer = null; }
		backlog.queue.length = 0;
		backlog.head = 0;
		backlog.bytes = 0;
		backlog.held = 0;
	}

	// The one report rule: every refusal the policy returns is reported once. If
	// the connection was already closed when the decision landed - by the
	// policy, the application or the client - its closeCode is null.
	function report(ws, outcome, closeCode) {
		if (outcome === CLOSED) return;
		try {
			if (outcome.reason === 'denied') reportDenied(ws, closeCode);
			else reportFailed(ws, outcome.reason, outcome.error, closeCode);
		} catch {}
	}

	function forget(ws, backlog) {
		if (backlogs.get(ws) === backlog) backlogs.delete(ws);
	}

	function fail(ws, backlog, outcome) {
		if (backlog.failed) return;
		backlog.failed = true;
		const gone = backlog.closed || released.has(ws);
		release(backlog);
		const code = gone ? null : outcome.reason === 'denied' ? DELIVERY_REFUSED_CLOSE_CODE : DELIVERY_FAILED_CLOSE_CODE;
		report(ws, outcome, code);
		if (code === null) { forget(ws, backlog); return; }
		// Inside an operation the connection is ended once that operation
		// finished, so whatever its close hook issues follows the fan-out
		// being decided. The released backlog refuses its frames meanwhile.
		if (depth > 0) defer(() => endRefused(ws, backlog, code, outcome.reason));
		else endRefused(ws, backlog, code, outcome.reason);
	}

	function endRefused(ws, backlog, code, reason) {
		try { ws.end(code, CLOSE_REASONS[reason]); }
		catch {
			forget(ws, backlog);
			released.add(ws);
		}
	}

	// A decision still pending when its connection closed: no timer, and a
	// report only if it later refuses.
	function settleClosed(ws, pending) {
		pending.then((verdict) => {
			enter();
			try { if (verdict !== true) report(ws, verdict, null); }
			finally { leave(); }
		});
	}

	function entryOf(kind, payload, binary, compress, topic, cache, receipt) {
		// An application text frame retains its parse, so it is charged twice;
		// a control or binary frame once. Every held frame adds its entry.
		const parsed = !binary && kind === APPLICATION;
		const size = binary ? payload.byteLength : Buffer.byteLength(payload);
		const bytes = (parsed ? 2 : 1) * size + ENTRY_OVERHEAD_BYTES;
		const kept = parsed ? cache ?? { payload: undefined, messages: null } : null;
		return { kind, payload, binary, compress, topic, size, bytes, verdict: undefined, cache: kept, receipt };
	}

	function hold(backlog, entry) {
		backlog.queue.push(entry);
		backlog.bytes += entry.bytes;
		backlog.held += entry.size;
		if (entry.receipt !== null) entry.receipt.held = true;
	}

	// A receipt is the caller's record of one frame: `held` while the gate keeps
	// the frame back, then the transport's status once it was handed over. A
	// frame refused or dropped while held is never handed over.
	function transmit(ws, payload, binary, compress, receipt) {
		const status = ws.send(payload, binary, compress);
		if (receipt !== null) { receipt.held = false; receipt.status = status; }
		return status;
	}

	function wait(ws, backlog, entry, pending) {
		backlog.waiting = true;
		backlog.timer = setTimer(() => {
			backlog.timer = null;
			fail(ws, backlog, refusal('timeout'));
		}, timeoutMs);
		pending.then((verdict) => {
			enter();
			try {
				// Closed meanwhile: release already cleared the timer.
				if (backlog.closed) {
					if (verdict !== true && !backlog.failed) report(ws, verdict, null);
					return;
				}
				clearTimer(backlog.timer);
				backlog.timer = null;
				backlog.waiting = false;
				if (verdict !== true) { fail(ws, backlog, verdict); return; }
				entry.verdict = true;
				pump(ws, backlog);
			} finally {
				leave();
			}
		});
	}

	function idle(ws) {
		if (onIdle === null || released.has(ws) || backlogs.has(ws)) return;
		try { onIdle(ws); } catch {}
	}

	function retire(ws, backlog) {
		backlogs.delete(ws);
		const ending = backlog.ending;
		release(backlog);
		if (ending !== null) {
			try { ws.end(ending.code, ending.reason); } catch {}
		} else if (onIdle !== null) {
			// The surface's own flush reports its failures; none may escape into
			// the transport callback that drained this socket.
			try { onIdle(ws); } catch {}
		}
	}

	// true once every held frame reached the transport.
	function drainQueue(ws, backlog) {
		const queue = backlog.queue;
		while (backlog.head < queue.length) {
			const entry = queue[backlog.head];
			if (ws.getBufferedAmount() > 0) {
				// A decision taken before the transport filled is not reused:
				// the frame is decided again once the buffer drains.
				entry.verdict = undefined;
				return false;
			}
			if (entry.kind === APPLICATION) {
				let verdict = entry.verdict;
				entry.verdict = undefined;
				if (verdict === undefined) verdict = decideFrame(ws, entry.payload, entry.binary, entry.topic, entry.cache);
				if (backlog.closed) {
					// The policy closed the connection itself while deciding.
					if (isThenable(verdict)) settleClosed(ws, verdict);
					else if (verdict !== true) fail(ws, backlog, verdict);
					return false;
				}
				if (verdict !== true) {
					if (isThenable(verdict)) wait(ws, backlog, entry, verdict);
					else fail(ws, backlog, verdict);
					return false;
				}
			}
			queue[backlog.head++] = undefined;
			backlog.bytes -= entry.bytes;
			backlog.held -= entry.size;
			if (backlog.head > COMPACT_AFTER) {
				queue.splice(0, backlog.head);
				backlog.head = 0;
			}
			const status = transmit(ws, entry.payload, entry.binary, entry.compress, entry.receipt);
			if (backlog.closed) return false;
			// An empty transport buffer never drops a frame, so a refusal here
			// means the connection is going away and its close event releases
			// what is still held. With nothing left held no drain follows, so
			// the backlog is released now.
			if (status === 2) return backlog.head === queue.length;
		}
		return true;
	}

	function pump(ws, backlog) {
		if (backlog.pumping || backlog.waiting || backlog.closed) return;
		backlog.pumping = true;
		let drained = false;
		try {
			// Corked, so the frames handed on in one pass leave in one write.
			if (typeof ws.cork === 'function') ws.cork(() => { drained = drainQueue(ws, backlog); });
			else drained = drainQueue(ws, backlog);
		} catch {
			// The socket closed under the pump; nothing held can be delivered.
			forget(ws, backlog);
			release(backlog);
		} finally {
			backlog.pumping = false;
		}
		if (drained) retire(ws, backlog);
	}

	function admit(ws, kind, payload, binary, compress, topic, cache, receipt) {
		// A queued operation that runs after the policy was removed, or for a
		// socket whose close event arrived, is the native send.
		if (authorize === null || released.has(ws)) return transmit(ws, payload, binary, compress, receipt);
		let backlog = backlogs.get(ws);
		if (backlog === undefined) {
			if (kind === CONTROL) return ws.send(payload, binary, compress);
			if (ws.getBufferedAmount() === 0) {
				// A parse that may be held with the frame is kept for its re-decision.
				if (cache == null && !binary && kind === APPLICATION) cache = { payload: undefined, messages: null };
				const verdict = decideFrame(ws, payload, binary, topic, cache);
				if (released.has(ws)) {
					// The policy closed the connection itself while deciding: report
					// the decision under the one rule, then answer as the closed
					// native socket does.
					if (isThenable(verdict)) settleClosed(ws, verdict);
					else if (verdict !== true) report(ws, verdict, null);
					return transmit(ws, payload, binary, compress, receipt);
				}
				if (verdict === true) return transmit(ws, payload, binary, compress, receipt);
				backlog = open(ws);
				if (isThenable(verdict)) {
					const entry = entryOf(kind, payload, binary, compress, topic, cache, receipt);
					hold(backlog, entry);
					wait(ws, backlog, entry, verdict);
					return 0;
				}
				fail(ws, backlog, verdict);
				return 2;
			}
			backlog = open(ws);
		} else if (backlog.closed || backlog.ending !== null) {
			return 2;
		}
		// Bounded like the transport's own buffer: a frame is refused once what
		// is already held, counted with the unflushed transport bytes, exceeds it.
		if (ws.getBufferedAmount() + backlog.bytes > maxPendingBytes) {
			if (backlog.head === backlog.queue.length) backlogs.delete(ws);
			if (onDrop !== null) {
				try { onDrop(ws, binary ? payload.byteLength : Buffer.byteLength(payload)); } catch {}
			}
			// Closed once the operation in progress finished, as the transport
			// shuts the socket down after its own drop rather than inside it.
			if (closeOnOverflow) defer(() => { try { ws.close(); } catch {} });
			return 2;
		}
		hold(backlog, entryOf(kind, payload, binary, compress, topic, cache, receipt));
		return 0;
	}

	// Each local subscriber admitted separately, corked, sharing one parse. Like
	// the native publish, the answer is whether the topic had a subscriber,
	// whatever each send returned.
	function walk(connections, topic, payload, binary, compress, logicalTopic) {
		const cache = { payload: undefined, messages: null };
		const deliver = (ws) => admit(ws, APPLICATION, payload, binary, compress, logicalTopic, cache, null);
		let accepted = false;
		for (const socket of connections) {
			try {
				// A closed socket throws here, as it would from the native publish walk.
				if (!socket.isSubscribed(topic)) continue;
				if (typeof socket.cork === 'function') socket.cork(() => { deliver(socket); });
				else deliver(socket);
				accepted = true;
			} catch {}
		}
		return accepted;
	}

	function endNow(ws, code, reason) {
		const backlog = backlogs.get(ws);
		if (backlog === undefined) return ws.end(code, reason);
		if (backlog.closed || backlog.ending !== null) return;
		backlog.ending = { code, reason };
		endings++;
		backlog.endTimer = setTimer(() => {
			backlog.endTimer = null;
			const ending = backlog.ending;
			forget(ws, backlog);
			release(backlog);
			try { ws.end(ending.code, ending.reason); } catch {}
		}, timeoutMs);
	}

	return Object.freeze({
		/** Whether an application policy is currently issuing nested operations. */
		get deciding() { return inPolicy > 0; },

		/** Run a policy-issued operation after the enclosing adapter operation. */
		deferOperation(operation) {
			const owner = policySocket;
			defer(() => {
				try { operation(); }
				catch (error) {
					// An encode/serialization failure belongs to the policy that
					// issued the operation, just as a synchronous policy throw does.
					if (owner !== null) fail(owner, backlogs.get(owner) ?? open(owner), refusal('error', error));
				}
			});
		},

		/** Whether a policy is installed. */
		get armed() { return authorize !== null; },

		/** Sockets currently holding frames or awaiting their close. */
		get holding() { return backlogs.size; },

		/**
		 * Install the worker's policy. Deliveries admitted before installation
		 * were not checked; install it during initialization.
		 *
		 * @param {(ws: any, delivery: { topic: string | null, event: string | null, data: unknown, binary: boolean, kind: 'message' | 'replay' | 'request' }) => boolean | PromiseLike<boolean>} callback
		 * @param {{ maxPendingBytes?: number, timeoutMs?: number }} [options]
		 */
		configure(callback, options) {
			if (authorize !== null) throw new Error('Delivery authorization is already configured');
			if (typeof callback !== 'function') throw new TypeError('authorizeDelivery requires a function');
			if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
				throw new TypeError('authorizeDelivery options must be an object');
			}
			const values = options ?? {};
			for (const key of Object.keys(values)) {
				if (!OPTION_KEYS.has(key)) throw new TypeError('Unknown authorizeDelivery option ' + key);
			}
			const bytes = values.maxPendingBytes ?? defaultMaxPendingBytes;
			const timeout = values.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
			if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new TypeError('Invalid authorizeDelivery maxPendingBytes');
			if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
				throw new TypeError('Invalid authorizeDelivery timeoutMs');
			}
			maxPendingBytes = bytes;
			timeoutMs = timeout;
			authorize = callback;
		},

		/**
		 * Remove an installed policy so a failed initialization can run again.
		 * A socket still holding frames is closed as a failed decision: without
		 * a policy its held frames could neither be decided nor kept in order.
		 */
		reset() {
			for (const [socket, backlog] of backlogs) fail(socket, backlog, refusal('reset'));
			authorize = null;
			maxPendingBytes = defaultMaxPendingBytes;
			timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS;
		},

		/** Called when a socket's held frames have all reached the transport. */
		setIdleHandler(handler) {
			onIdle = typeof handler === 'function' ? handler : null;
		},

		/**
		 * A parse cache for one payload sent to many sockets, or null without a
		 * policy. Pass the same cache with every send of that payload.
		 */
		cache() {
			return authorize === null ? null : { payload: undefined, messages: null };
		},

		/**
		 * Open an adapter fan-out: operations a policy issues while any send
		 * inside it is decided run after `finish`, in the order issued. Returns
		 * false, and costs one branch, without a policy.
		 */
		begin() {
			if (authorize === null) return false;
			enter();
			return true;
		},

		/** Close the fan-out `begin` opened. */
		finish(opened) {
			if (opened === true) leave();
		},

		/**
		 * Send one application frame. Returns the transport status, 0 when the
		 * frame is held (delivered in order unless refused), or 2 when it is
		 * dropped. A binary frame names its logical topic. A closed socket
		 * answers as the native one does. A `receipt` object is marked `held`
		 * while the frame is kept back and given the transport's `status` once
		 * the frame is handed over; without a policy the caller has the status.
		 */
		send(ws, payload, binary = false, compress = false, topic = null, cache = null, receipt = null) {
			if (authorize === null) return ws.send(payload, binary, compress);
			if (released.has(ws)) return ws.send(payload, binary, compress);
			if (inPolicy > 0) {
				if (receipt !== null) receipt.held = true;
				defer(() => admit(ws, APPLICATION, payload, binary, compress, topic, cache, receipt));
				return 0;
			}
			enter();
			try { return admit(ws, APPLICATION, payload, binary, compress, topic, cache, receipt); }
			finally { leave(); }
		},

		/**
		 * Send one latest-value frame: refused with 2 while the socket holds
		 * frames or a decision is in progress, so the caller keeps only the
		 * newest value until the idle handler runs.
		 */
		sendReplaceable(ws, payload, compress = false) {
			if (authorize === null) return ws.send(payload, false, compress);
			if (released.has(ws)) return ws.send(payload, false, compress);
			// Refused while a decision runs too, so the caller keeps only its
			// newest value; the idle handler hands it on once the operation
			// finished, unless frames are held by then (their drain does).
			if (inPolicy > 0) {
				defer(() => idle(ws));
				return 2;
			}
			if (backlogs.has(ws)) return 2;
			enter();
			try { return admit(ws, APPLICATION, payload, false, compress, null, null, null); }
			finally { leave(); }
		},

		/**
		 * Send one protocol control frame or payload-free adapter marker. It is
		 * never checked, only ordered behind held frames.
		 */
		control(ws, payload, compress = false) {
			if (authorize === null) return ws.send(payload, false, compress);
			if (released.has(ws)) return ws.send(payload, false, compress);
			if (inPolicy > 0) {
				defer(() => admit(ws, CONTROL, payload, false, compress, null, null, null));
				return 0;
			}
			enter();
			try { return admit(ws, CONTROL, payload, false, compress, null, null, null); }
			finally { leave(); }
		},

		/**
		 * Publish one frame to a native topic. With a policy each local
		 * subscriber is admitted separately, corked, sharing one parse;
		 * `logicalTopic` names a binary frame's application topic when the
		 * native topic is internal. A publish a policy issues runs after the
		 * operation being decided.
		 */
		publish(app, connections, topic, payload, binary = false, compress = false, logicalTopic = topic) {
			if (authorize === null) return app.publish(topic, payload, binary, compress);
			if (app.numSubscribers(topic) === 0) return false;
			if (inPolicy > 0) {
				defer(() => walk(connections, topic, payload, binary, compress, logicalTopic));
				return true;
			}
			enter();
			try { return walk(connections, topic, payload, binary, compress, logicalTopic); }
			finally { leave(); }
		},

		/**
		 * End a connection after its held frames, bounded by the policy time
		 * bound. Without held frames this is `ws.end(code, reason)`.
		 */
		end(ws, code, reason) {
			if (authorize === null || released.has(ws)) return ws.end(code, reason);
			if (inPolicy > 0) {
				defer(() => endNow(ws, code, reason));
				return;
			}
			enter();
			try { endNow(ws, code, reason); }
			finally { leave(); }
		},

		/**
		 * A promise that settles once every `end` still waiting for held frames
		 * has ended its connection (each within timeoutMs), or null when none is.
		 */
		ended() {
			if (endings === 0) return null;
			return new Promise((resolve) => { endWaiters.push(resolve); });
		},

		/**
		 * Payload bytes held for this socket and not yet handed to the
		 * transport. The pending-byte bound counts more: each held frame's
		 * entry overhead, and application text a second time for its parse.
		 */
		pendingBytes(ws) {
			if (authorize === null) return 0;
			const backlog = backlogs.get(ws);
			return backlog === undefined || backlog.closed ? 0 : backlog.held;
		},

		/**
		 * The transport drained: hand held frames on. Returns false when the
		 * connection closed meanwhile, so the caller runs no drain work for it.
		 */
		drain(ws) {
			if (authorize === null) return true;
			const backlog = backlogs.get(ws);
			if (backlog === undefined) return !released.has(ws);
			enter();
			try { pump(ws, backlog); }
			finally { leave(); }
			return !released.has(ws);
		},

		/** The connection closed: discard what it still held; it answers as closed. */
		closed(ws) {
			if (ws === undefined || ws === null) return;
			// Without a policy nothing is held, and a socket closed before one is
			// installed throws natively on every later send.
			if (authorize === null && backlogs.size === 0) return;
			released.add(ws);
			const backlog = backlogs.get(ws);
			if (backlog === undefined) return;
			backlogs.delete(ws);
			release(backlog);
		}
	});
}
