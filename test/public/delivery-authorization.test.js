import { afterEach, describe, expect, it } from 'vitest';
import {
	createDeliveryAuthorization,
	DELIVERY_REFUSED_CLOSE_CODE,
	DELIVERY_FAILED_CLOSE_CODE
} from '../../src/runtime/utils/delivery-authorization.js';
import { foldConnectionBackpressure } from '../../src/runtime/utils/backpressure.js';
import { buildBinaryFrame } from '../../src/runtime/wire.js';
import { setOperationalEventSink } from '../../src/runtime/diagnostic.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../../src/runtime/runtime.js';
import { WS_PLATFORM } from '../../src/runtime/utils/ws-symbols.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const envelope = (data, topic = 'scan') => JSON.stringify({ topic, event: 'row', data });

let events = [];
let disposeSink = null;
afterEach(() => {
	disposeSink?.();
	disposeSink = null;
	events = [];
	resetRuntimeEnv();
});

/** Timers the test fires by hand, so no assertion depends on wall time. */
function virtualTimers() {
	const pending = new Map();
	let next = 0;
	setRuntimeEnv({
		timers: {
			set: (fn, ms) => { const id = ++next; pending.set(id, { fn, ms }); return id; },
			clear: (id) => { pending.delete(id); }
		}
	});
	return {
		pending,
		fireAll() {
			for (const [id, timer] of [...pending]) {
				pending.delete(id);
				timer.fn();
			}
		}
	};
}
function captureDiagnostics() {
	disposeSink = setOperationalEventSink((record) => { events.push(record); });
}

/** Count JSON.parse calls made while `fn` runs. */
async function countParses(fn) {
	const parse = JSON.parse;
	let count = 0;
	JSON.parse = function (...args) { count++; return parse.apply(this, args); };
	try { await fn(); } finally { JSON.parse = parse; }
	return count;
}

/**
 * A uWS-shaped socket. `sent` records what reached the transport, `ended`
 * the graceful close, and `buffer(n)` sets the transport's unflushed bytes.
 */
function socket(id = 'scanner', topics = ['scan']) {
	let buffered = 0;
	const ws = {
		id,
		// Raw frames as the transport took them; `sent` parses them on read so
		// the socket itself never adds a JSON.parse to a counted window.
		raw: [],
		get sent() { return this.raw.map((p) => (typeof p === 'string' ? JSON.parse(p) : p)); },
		ended: null,
		closedAbruptly: false,
		send(payload) {
			if (this.ended !== null || this.closedAbruptly) throw new Error('Invalid access of closed uWS.WebSocket');
			this.raw.push(payload);
			return 1;
		},
		getBufferedAmount() {
			if (this.ended !== null || this.closedAbruptly) throw new Error('Invalid access of closed uWS.WebSocket');
			return buffered;
		},
		getUserData() { return { id }; },
		end(code, reason) {
			this.ended = { code, reason };
			this.onClose?.();
		},
		close() { this.closedAbruptly = true; this.onClose?.(); },
		isSubscribed(topic) { return topics.includes(topic); },
		buffer(amount) { buffered = amount; }
	};
	return ws;
}

function setup(authorize, options, surface) {
	const gate = createDeliveryAuthorization(surface);
	if (authorize) gate.configure(authorize, options);
	const attach = (ws) => { ws.onClose = () => gate.closed(ws); return ws; };
	return { gate, ws: attach(socket()), attach };
}

describe('recipient delivery authorization', () => {
	it('keeps every entry point a direct native call without a policy', () => {
		const gate = createDeliveryAuthorization();
		const ws = socket();
		const published = [];
		const app = { publish: (...args) => { published.push(args); return true; }, numSubscribers() { throw new Error('walked'); } };
		expect(gate.send(ws, envelope(1))).toBe(1);
		expect(gate.control(ws, '{"type":"welcome"}')).toBe(1);
		expect(gate.sendReplaceable(ws, envelope(2))).toBe(1);
		expect(gate.publish(app, new Set([ws]), 'scan', envelope(3))).toBe(true);
		expect(gate.pendingBytes(ws)).toBe(0);
		expect(gate.cache()).toBeNull();
		expect(gate.ended()).toBeNull();
		gate.end(ws, 4000, 'bye');
		expect(ws.sent.map((f) => f.data ?? f.type)).toEqual([1, 'welcome', 2]);
		expect(published).toHaveLength(1);
		expect(ws.ended).toEqual({ code: 4000, reason: 'bye' });
	});

	it('runs a whole policy-issued operation after the complete enclosing scope', () => {
		const seen = [];
		let inner;
		inner = setup((_ws, delivery) => {
			if (delivery.data === 'outer') {
				expect(inner.gate.deciding).toBe(true);
				inner.gate.deferOperation(() => { seen.push('encode'); inner.gate.send(inner.ws, envelope('nested')); });
			}
			return true;
		});
		const opened = inner.gate.begin();
		try { inner.gate.send(inner.ws, envelope('outer')); seen.push('relay'); }
		finally { inner.gate.finish(opened); }
		expect(seen).toEqual(['relay', 'encode']);
		expect(inner.ws.sent.map(frame => frame.data)).toEqual(['outer', 'nested']);
		expect(inner.gate.deciding).toBe(false);
	});

	it('contains a deferred codec failure and closes the policy recipient once', () => {
		captureDiagnostics();
		let inner;
		inner = setup(() => {
			inner.gate.deferOperation(() => { throw new TypeError('codec failed'); });
			return true;
		});
		expect(() => inner.gate.send(inner.ws, envelope('outer'))).not.toThrow();
		expect(inner.ws.ended?.code).toBe(DELIVERY_FAILED_CLOSE_CODE);
		expect(events.filter(event => event.event === 'delivery-authorization.failed')).toHaveLength(1);
		expect(events[0].attributes.reason).toBe('error');
	});

	it('is frozen, so a consumer trusting it by name cannot be redirected', () => {
		const gate = createDeliveryAuthorization();
		expect(Object.isFrozen(gate)).toBe(true);
		expect(() => { gate.send = () => 1; }).toThrow(TypeError);
		const idle = [];
		gate.setIdleHandler((ws) => idle.push(ws));
		gate.configure(() => true);
		const ws = socket();
		ws.buffer(1);
		gate.send(ws, envelope(1));
		ws.buffer(0);
		gate.drain(ws);
		expect(idle).toEqual([ws]);
	});

	it('delivers a synchronous burst far past any message count inline', () => {
		let calls = 0;
		const { gate, ws } = setup(() => { calls++; return true; });
		for (let i = 0; i < 1000; i++) expect(gate.send(ws, envelope(i))).toBe(1);
		expect(calls).toBe(1000);
		expect(ws.sent.map((f) => f.data)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
		expect(ws.ended).toBeNull();
		expect(gate.pendingBytes(ws)).toBe(0);
	});

	it('delivers an asynchronous burst in order without closing a healthy socket', async () => {
		const { gate, ws } = setup(async () => true);
		for (let i = 0; i < 300; i++) expect(gate.send(ws, envelope(i))).toBe(0);
		expect(ws.sent).toEqual([]);
		await sleep(5);
		expect(ws.sent.map((f) => f.data)).toEqual(Array.from({ length: 300 }, (_, i) => i));
		expect(ws.ended).toBeNull();
		expect(gate.pendingBytes(ws)).toBe(0);
	});

	it('admits one frame larger than the pending bound when nothing is held', async () => {
		const big = envelope('x'.repeat(4096));
		const sync = setup(() => true, { maxPendingBytes: 1024 });
		expect(sync.gate.send(sync.ws, big)).toBe(1);
		const slow = setup(async () => true, { maxPendingBytes: 1024 });
		expect(slow.gate.send(slow.ws, big)).toBe(0);
		await flush();
		expect(slow.ws.sent).toHaveLength(1);
		expect(slow.ws.ended).toBeNull();
	});

	it('never lets a later frame overtake one whose decision is still pending', async () => {
		let release;
		const { gate, ws } = setup((_ws, delivery) => {
			if (delivery.data === 'slow') return new Promise((resolve) => { release = resolve; });
			return true;
		});
		expect(gate.send(ws, envelope('slow'))).toBe(0);
		expect(gate.send(ws, envelope('fast'))).toBe(0);
		expect(gate.control(ws, '{"type":"subscribed","topic":"scan","ref":1}')).toBe(0);
		expect(ws.sent).toEqual([]);
		release(true);
		await flush();
		expect(ws.sent.map((f) => f.data ?? f.type)).toEqual(['slow', 'fast', 'subscribed']);
	});

	it('keeps a frame sent from inside its own decision behind that frame', async () => {
		for (const asynchronous of [false, true]) {
			let gate;
			let reentered = false;
			({ gate } = setup(null));
			const ws = socket();
			ws.onClose = () => gate.closed(ws);
			gate.configure((socketRef, delivery) => {
				if (delivery.data === 'A' && !reentered) {
					reentered = true;
					gate.send(socketRef, envelope('B'));
					gate.control(socketRef, '{"type":"note"}');
				}
				return asynchronous ? Promise.resolve(true) : true;
			});
			gate.send(ws, envelope('A'));
			await flush();
			expect(ws.sent.map((f) => f.data ?? f.type)).toEqual(['A', 'B', 'note']);
		}
	});

	it('sends a control frame directly when nothing is held and never asks the policy', () => {
		let calls = 0;
		const { gate, ws } = setup(() => { calls++; return false; });
		ws.buffer(10);
		expect(gate.control(ws, '{"type":"resumed"}')).toBe(1);
		expect(calls).toBe(0);
		expect(ws.sent).toEqual([{ type: 'resumed' }]);
	});

	it('checks each held message against authorization current when it leaves the queue', async () => {
		let allowed = true;
		let release;
		const decided = [];
		const { gate, ws } = setup(async (_ws, delivery) => {
			if (delivery.data === 1) await new Promise((resolve) => { release = resolve; });
			decided.push([delivery.data, allowed]);
			const answer = allowed;
			// Revoked once frame 1 is decided: frame 2, still held, meets it.
			allowed = false;
			return answer;
		});
		gate.send(ws, envelope(1));
		gate.send(ws, envelope(2));
		release();
		await flush();
		expect(decided).toEqual([[1, true], [2, false]]);
		expect(ws.sent.map((f) => f.data)).toEqual([1]);
		expect(ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
	});

	it('holds frames behind transport backpressure and decides them after drain', () => {
		let allowed = true;
		let calls = 0;
		const { gate, ws } = setup(() => { calls++; return allowed; });
		ws.buffer(100);
		expect(gate.send(ws, envelope(1))).toBe(0);
		expect(calls).toBe(0);
		expect(gate.pendingBytes(ws)).toBe(envelope(1).length);
		allowed = false;
		ws.buffer(0);
		gate.drain(ws);
		expect(ws.sent).toEqual([]);
		expect(ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
	});

	it('decides again, rather than reusing an approval, after the transport fills', async () => {
		let allowed = true;
		let release;
		const { gate, ws } = setup(() => (release ? allowed : new Promise((resolve) => { release = resolve; })));
		gate.send(ws, envelope(1));
		ws.buffer(10);
		release(true);
		await flush();
		expect(ws.sent).toEqual([]);
		allowed = false;
		ws.buffer(0);
		gate.drain(ws);
		expect(ws.sent).toEqual([]);
		expect(ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
	});

	it('stops at a transport that filled again and resumes on the next drain', () => {
		const { gate, ws } = setup(() => true);
		ws.buffer(1);
		for (let i = 0; i < 3; i++) gate.send(ws, envelope(i));
		ws.buffer(0);
		ws.send = function (payload) { this.raw.push(payload); this.buffer(50); return 0; };
		gate.drain(ws);
		expect(ws.sent.map((f) => f.data)).toEqual([0]);
		ws.buffer(0);
		gate.drain(ws);
		expect(ws.sent.map((f) => f.data)).toEqual([0, 1]);
		ws.send = function (payload) { this.raw.push(payload); return 2; };
		ws.buffer(0);
		gate.drain(ws);
		expect(ws.sent.map((f) => f.data)).toEqual([0, 1, 2]);
		expect(gate.pendingBytes(ws)).toBe(0);
		// Nothing is left held and no drain follows: the next frame is decided
		// and sent at once rather than held for good.
		expect(gate.holding).toBe(0);
		ws.send = function (payload) { this.raw.push(payload); return 1; };
		expect(gate.send(ws, envelope(3))).toBe(1);
	});

	it('drops a frame once the held bytes exceed the bound, like the transport', () => {
		// A held application text frame is charged twice its bytes plus 128.
		const one = 2 * envelope('a'.repeat(200)).length + 128;
		// Exactly at the bound is still admitted; one byte more is not.
		const { gate, ws } = setup(() => true, { maxPendingBytes: 1 + one });
		ws.buffer(1);
		expect(gate.send(ws, envelope('a'.repeat(200)))).toBe(0);
		expect(gate.send(ws, envelope('b'.repeat(200)))).toBe(0);
		expect(gate.send(ws, envelope('c'))).toBe(2);
		expect(ws.ended).toBeNull();
		expect(ws.closedAbruptly).toBe(false);
		ws.buffer(0);
		gate.drain(ws);
		expect(ws.sent.map((f) => f.data[0])).toEqual(['a', 'b']);
	});

	it('forgets an empty backlog a drop opened, so the next frame goes straight out', () => {
		const drops = [];
		const { gate, ws } = setup(() => true, undefined, { maxPendingBytes: 500, onDrop: (_ws, bytes) => drops.push(bytes) });
		ws.buffer(501);
		expect(gate.send(ws, envelope(1))).toBe(2);
		expect(drops).toEqual([envelope(1).length]);
		ws.buffer(0);
		expect(gate.send(ws, envelope(2))).toBe(1);
	});

	it('counts the transport buffer toward the bound and closes on overflow when configured to', () => {
		const { gate, ws } = setup(() => true, undefined, { maxPendingBytes: 500, closeOnOverflow: true });
		ws.buffer(501);
		expect(gate.send(ws, envelope(1))).toBe(2);
		expect(ws.closedAbruptly).toBe(true);
	});

	it('closes with a retry-class code and reports why the policy refused', async () => {
		captureDiagnostics();
		const cases = [
			[() => false, DELIVERY_REFUSED_CLOSE_CODE, 'delivery-authorization.denied', 'denied'],
			[() => { throw new Error('db unavailable'); }, DELIVERY_FAILED_CLOSE_CODE, 'delivery-authorization.failed', 'error'],
			[() => undefined, DELIVERY_FAILED_CLOSE_CODE, 'delivery-authorization.failed', 'invalid-result'],
			[async () => { throw new Error('db unavailable'); }, DELIVERY_FAILED_CLOSE_CODE, 'delivery-authorization.failed', 'error'],
			[async () => 'yes', DELIVERY_FAILED_CLOSE_CODE, 'delivery-authorization.failed', 'invalid-result']
		];
		for (const [policy, code, event, reason] of cases) {
			events = [];
			const { gate, ws } = setup(policy);
			gate.send(ws, envelope(1));
			await flush();
			expect(ws.sent).toEqual([]);
			expect(ws.ended?.code).toBe(code);
			expect(events.map((e) => e.event)).toEqual([event]);
			expect(events[0].attributes.closeCode).toBe(code);
			expect(events[0].attributes.reason).toBe(reason);
			expect(gate.pendingBytes(ws)).toBe(0);
			// After its close event the socket answers as the native one: it throws.
			expect(() => gate.send(ws, envelope(2))).toThrow('closed');
			expect(gate.holding).toBe(0);
		}
		expect(DELIVERY_REFUSED_CLOSE_CODE).toBe(1013);
	});

	it('reports an unparseable frame by error class only, never its text', () => {
		captureDiagnostics();
		const { gate, ws } = setup(() => true);
		gate.send(ws, '{"topic":"scan","data":"secret-token-123"');
		expect(ws.ended?.code).toBe(DELIVERY_FAILED_CLOSE_CODE);
		expect(events[0].attributes.reason).toBe('unattributed');
		expect(events[0].attributes.error).toEqual({ name: 'SyntaxError' });
		expect(JSON.stringify(events[0])).not.toContain('secret-token-123');
	});

	it('fails a decision that outlives timeoutMs', async () => {
		captureDiagnostics();
		const timers = virtualTimers();
		const { gate, ws } = setup(() => new Promise(() => {}), { timeoutMs: 20 });
		gate.send(ws, envelope(1));
		gate.send(ws, envelope(2));
		expect([...timers.pending.values()].map((t) => t.ms)).toEqual([20]);
		timers.fireAll();
		expect(ws.ended).toEqual({ code: DELIVERY_FAILED_CLOSE_CODE, reason: 'Delivery authorization timed out' });
		expect(events.map((e) => e.attributes.reason)).toEqual(['timeout']);
		expect(gate.holding).toBe(0);
	});

	it('clears the decision timer once a decision lands, however long frames stay held', async () => {
		const timers = virtualTimers();
		let release;
		const { gate, ws } = setup((_ws, delivery) => (delivery.data === 1 && !release
			? new Promise((resolve) => { release = resolve; })
			: true), { timeoutMs: 30 });
		gate.send(ws, envelope(1));
		ws.buffer(5);
		gate.send(ws, envelope(2));
		expect(timers.pending.size).toBe(1);
		release(true);
		await flush();
		// The decision landed: no timer is left to fire however long frame 2 waits.
		expect(timers.pending.size).toBe(0);
		timers.fireAll();
		expect(ws.ended).toBeNull();
		ws.buffer(0);
		gate.drain(ws);
		expect(ws.sent.map((f) => f.data)).toEqual([1, 2]);
	});

	it('asks nothing more about a batch once its socket was refused meanwhile', async () => {
		const asked = [];
		let release;
		const { gate, ws } = setup((_ws, delivery) => {
			asked.push(delivery.topic);
			return delivery.topic === 'a' ? new Promise((resolve) => { release = resolve; }) : true;
		}, { timeoutMs: 10 });
		gate.send(ws, JSON.stringify({ type: 'batch', events: [{ topic: 'a', event: 'e', data: 1 }, { topic: 'b', event: 'e', data: 2 }] }));
		await sleep(30);
		expect(ws.ended?.code).toBe(DELIVERY_FAILED_CLOSE_CODE);
		release(true);
		await flush();
		expect(asked).toEqual(['a']);
	});

	it('refuses a second installation and invalid options', () => {
		const gate = createDeliveryAuthorization();
		expect(() => gate.configure('nope')).toThrow(TypeError);
		for (const options of [null, [], { maxPendingMessages: 1 }, { maxPendingBytes: 0 }, { maxPendingBytes: 1.5 },
			{ timeoutMs: 0 }, { timeoutMs: 2 ** 31 }, { timeoutMs: Infinity }]) {
			expect(() => gate.configure(() => true, options)).toThrow(TypeError);
		}
		expect(gate.armed).toBe(false);
		gate.configure(() => true, { timeoutMs: 2 ** 31 - 1, maxPendingBytes: 1 });
		expect(() => gate.configure(() => true)).toThrow('already configured');
		gate.reset();
		expect(gate.armed).toBe(false);
		gate.configure(() => true);
		expect(gate.armed).toBe(true);
	});

	it('closes sockets still holding frames when the policy is removed', async () => {
		const { gate, ws } = setup(() => new Promise(() => {}));
		gate.send(ws, envelope(1));
		gate.reset();
		expect(ws.ended?.code).toBe(DELIVERY_FAILED_CLOSE_CODE);
		expect(ws.sent).toEqual([]);
	});

	it('applies a policy installed after a connection opened to its later frames', () => {
		const gate = createDeliveryAuthorization();
		const ws = socket();
		ws.onClose = () => gate.closed(ws);
		gate.send(ws, envelope('before'));
		gate.configure(() => false);
		gate.send(ws, envelope('after'));
		expect(ws.sent.map((f) => f.data)).toEqual(['before']);
		expect(ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
	});

	it('refuses a latest-value frame while frames are held and reports the drain', async () => {
		const idle = [];
		const gate = createDeliveryAuthorization({ onIdle: (ws) => idle.push(ws) });
		let release;
		gate.configure(() => (release ? true : new Promise((resolve) => { release = resolve; })));
		const ws = socket();
		expect(gate.sendReplaceable(ws, envelope('first'))).toBe(0);
		expect(gate.sendReplaceable(ws, envelope('second'))).toBe(2);
		release(true);
		await flush();
		expect(ws.sent.map((f) => f.data)).toEqual(['first']);
		expect(idle).toEqual([ws]);
		expect(gate.sendReplaceable(ws, envelope('third'))).toBe(1);
	});

	it('ends a connection only after its held frames, bounded by the time bound', async () => {
		let release;
		const { gate, ws } = setup((_ws, delivery) => delivery.data === 'notice'
			? new Promise((resolve) => { release = resolve; })
			: true, { timeoutMs: 30 });
		gate.send(ws, envelope('notice'));
		gate.end(ws, 4001, 'kicked');
		const ended = gate.ended();
		expect(ended).toBeInstanceOf(Promise);
		expect(gate.send(ws, envelope('late'))).toBe(2);
		expect(ws.ended).toBeNull();
		release(true);
		await ended;
		expect(ws.sent.map((f) => f.data)).toEqual(['notice']);
		expect(ws.ended).toEqual({ code: 4001, reason: 'kicked' });
		expect(gate.ended()).toBeNull();

		const timers = virtualTimers();
		const stuck = setup(() => true, { timeoutMs: 20 });
		stuck.ws.buffer(10);
		stuck.gate.send(stuck.ws, envelope('held'));
		stuck.gate.end(stuck.ws, 4001, 'kicked');
		const stuckEnded = stuck.gate.ended();
		timers.fireAll();
		await stuckEnded;
		expect(stuck.ws.ended).toEqual({ code: 4001, reason: 'kicked' });
		expect(stuck.ws.sent).toEqual([]);
	});

	it('ends once when two closes are asked for, and leaves no end timer behind', async () => {
		const timers = virtualTimers();
		const { gate, ws } = setup(() => true, { timeoutMs: 20 });
		ws.buffer(10);
		gate.send(ws, envelope('held'));
		gate.end(ws, 1001, 'Server draining');
		gate.end(ws, 1001, 'Server shutting down');
		const ended = gate.ended();
		expect(timers.pending.size).toBe(1);
		ws.buffer(0);
		gate.drain(ws);
		await ended;
		expect(ws.ended).toEqual({ code: 1001, reason: 'Server draining' });
		expect(ws.sent.map((f) => f.data)).toEqual(['held']);
		expect(gate.ended()).toBeNull();
		expect(timers.pending.size).toBe(0);
	});

	it('delivers a send followed by a direct end when the policy answers synchronously', () => {
		const { gate, ws } = setup(() => true);
		// Inline (status 1), so the frame is with the transport before end().
		expect(gate.send(ws, envelope('kicked', 'system'))).toBe(1);
		ws.end(4001);
		expect(ws.sent.map((f) => f.topic)).toEqual(['system']);
	});

	it('attributes binary frames to the topic their sender names and never copies them', async () => {
		const seen = [];
		const { gate, ws } = setup(async (_ws, delivery) => { seen.push(delivery); return true; });
		const frame = buildBinaryFrame(1, 7, 0, new Uint8Array([4]));
		gate.send(ws, frame, true, false, 'scan');
		await flush();
		expect(seen).toEqual([{ topic: 'scan', event: null, data: undefined, binary: true, kind: 'message' }]);
		expect(ws.sent[0]).toBe(frame);

		captureDiagnostics();
		const inline = setup(() => true);
		const other = buildBinaryFrame(1, 7, 0, new Uint8Array([5]));
		inline.gate.send(inline.ws, other, true, false, 'scan');
		expect(inline.ws.sent[0]).toBe(other);
		inline.gate.send(inline.ws, other, true, false);
		expect(inline.ws.ended?.code).toBe(DELIVERY_FAILED_CLOSE_CODE);
		expect(events[0].attributes.reason).toBe('unattributed');
	});

	it('admits each subscriber separately and parses a published frame once', async () => {
		const contexts = [];
		const { gate, attach } = setup((ws, delivery) => { contexts.push(delivery); return ws.id !== 'revoked'; });
		const allowed = attach(socket('scanner'));
		const revoked = attach(socket('revoked'));
		const elsewhere = attach(socket('elsewhere', ['other']));
		const held = attach(socket('held'));
		held.buffer(1);
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 3 };
		const parses = await countParses(() => {
			expect(gate.publish(app, new Set([held, allowed, revoked, elsewhere]), 'scan', envelope(1))).toBe(true);
			held.buffer(0);
			gate.drain(held);
		});
		expect(parses).toBe(1);
		expect(allowed.sent).toHaveLength(1);
		expect(held.sent).toHaveLength(1);
		expect(revoked.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
		expect(elsewhere.sent).toEqual([]);
		expect(contexts).toHaveLength(3);
		expect(new Set(contexts).size).toBe(1);
		const empty = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 0 };
		expect(gate.publish(empty, { [Symbol.iterator]() { throw new Error('walked'); } }, 'scan', envelope(2))).toBe(false);
	});

	it('answers a publish to subscribers as the native publish does, whatever each send returned', () => {
		const { gate, attach } = setup(() => false);
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 2 };
		const sockets = new Set([attach(socket('one')), attach(socket('two'))]);
		// Both refused and closed: the topic still had subscribers.
		expect(gate.publish(app, sockets, 'scan', envelope(1))).toBe(true);
		for (const ws of sockets) expect(ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
		// Closed sockets are no subscribers: their walk throws, as the native one skips them.
		expect(gate.publish(app, sockets, 'scan', envelope(2))).toBe(false);
	});

	it('shares one parse across sends of one payload through a cache', async () => {
		const { gate, attach } = setup(() => true);
		const sockets = [attach(socket('a')), attach(socket('b')), attach(socket('c'))];
		sockets[2].buffer(1);
		const payload = envelope('shared');
		const parses = await countParses(() => {
			const cache = gate.cache();
			for (const ws of sockets) gate.send(ws, payload, false, false, null, cache);
			sockets[2].buffer(5);
			sockets[2].buffer(0);
			gate.drain(sockets[2]);
		});
		expect(parses).toBe(1);
		expect(sockets.map((ws) => ws.sent.length)).toEqual([1, 1, 1]);
	});

	it('keeps the parse with a held frame, cache or none, for its second decision', async () => {
		let release;
		let decisions = 0;
		const { gate, ws } = setup(() => {
			decisions++;
			return release ? true : new Promise((resolve) => { release = resolve; });
		});
		const parses = await countParses(async () => {
			expect(gate.send(ws, envelope('again'))).toBe(0);
			ws.buffer(5);
			release(true);
			await flush();
			// The approval met a filled transport and was discarded.
			expect(ws.sent).toEqual([]);
			ws.buffer(0);
			gate.drain(ws);
		});
		expect(decisions).toBe(2);
		expect(parses).toBe(1);
		expect(ws.sent.map((f) => f.data)).toEqual(['again']);
	});

	it('never reuses a cache entry for a different payload', () => {
		const seen = [];
		const { gate, ws } = setup((_ws, delivery) => { seen.push(delivery.data); return true; });
		const cache = gate.cache();
		gate.send(ws, envelope(1), false, false, null, cache);
		gate.send(ws, envelope(2), false, false, null, cache);
		expect(seen).toEqual([1, 2]);
	});

	it('shows every recipient the same frozen message, so a policy cannot rewrite it', () => {
		const seen = [];
		const { gate, attach } = setup((_ws, delivery) => {
			try { delivery.topic = 'rewritten'; } catch {}
			seen.push(delivery.topic);
			return true;
		});
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 2 };
		gate.publish(app, new Set([attach(socket('a')), attach(socket('b'))]), 'scan', envelope(1));
		expect(seen).toEqual(['scan', 'scan']);
	});

	it('delivers a publish issued from inside a policy after the publish being decided', () => {
		const { gate, attach } = setup(null);
		const a = attach(socket('a', ['scan', 'other']));
		const b = attach(socket('b', ['scan', 'other']));
		const sockets = new Set([a, b]);
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 2 };
		let nested = false;
		gate.configure((_ws, delivery) => {
			if (delivery.topic === 'scan' && !nested) {
				nested = true;
				expect(gate.publish(app, sockets, 'other', envelope('second', 'other'))).toBe(true);
			}
			return true;
		});
		expect(gate.publish(app, sockets, 'scan', envelope('first'))).toBe(true);
		expect(a.sent.map((f) => f.data)).toEqual(['first', 'second']);
		expect(b.sent.map((f) => f.data)).toEqual(['first', 'second']);
	});

	it('runs what a policy issues after the fan-out being decided, in the order issued', () => {
		const { gate, attach } = setup(null);
		expect(gate.begin()).toBe(false);
		const a = attach(socket('a', ['scan', 'other']));
		const b = attach(socket('b', ['scan', 'other']));
		const sockets = new Set([a, b]);
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 2 };
		let nested = false;
		gate.configure((_ws, delivery) => {
			if (delivery.topic === 'scan' && !nested) {
				nested = true;
				expect(gate.publish(app, sockets, 'other', envelope('second', 'other'))).toBe(true);
				expect(gate.send(b, envelope('third', 'direct'))).toBe(0);
				gate.end(a, 4000, 'done');
			}
			return true;
		});
		// An adapter fan-out loop outside the boundary, as sendTo runs one.
		const opened = gate.begin();
		try {
			for (const ws of [a, b]) gate.send(ws, envelope('first'));
			expect(b.sent.map((f) => f.data)).toEqual(['first']);
			expect(a.sent.map((f) => f.data)).toEqual(['first']);
		} finally {
			gate.finish(opened);
		}
		expect(a.sent.map((f) => f.data)).toEqual(['first', 'second']);
		expect(b.sent.map((f) => f.data)).toEqual(['first', 'second', 'third']);
		expect(a.ended).toEqual({ code: 4000, reason: 'done' });
	});

	it('reports a refusal once, with no close code, when the policy closed the socket itself', async () => {
		captureDiagnostics();
		const timers = virtualTimers();
		const selfClosing = (asynchronous) => (socketRef) => {
			socketRef.end(4401, 'Session revoked');
			return asynchronous ? Promise.resolve(false) : false;
		};
		for (const asynchronous of [false, true]) {
			// Inline: decided while sending.
			events = [];
			const inline = setup(selfClosing(asynchronous));
			expect(() => inline.gate.send(inline.ws, envelope(1))).toThrow('closed');
			await flush();
			expect(inline.ws.ended).toEqual({ code: 4401, reason: 'Session revoked' });
			expect(inline.gate.holding).toBe(0);
			expect(events.map((e) => [e.event, e.attributes.closeCode])).toEqual([['delivery-authorization.denied', null]]);
			// The message claims no close code the adapter did not send.
			expect(events[0].message).not.toMatch(/closed with 10/);

			// Drain: a held frame decided once the transport empties.
			events = [];
			const held = setup(selfClosing(asynchronous), { timeoutMs: 20 });
			held.ws.buffer(1);
			held.gate.send(held.ws, envelope(1));
			held.ws.buffer(0);
			held.gate.drain(held.ws);
			await flush();
			expect(held.ws.ended?.code).toBe(4401);
			expect(held.gate.holding).toBe(0);
			// No decision timer survives the close, so no timeout is ever reported.
			expect(timers.pending.size).toBe(0);
			timers.fireAll();
			expect(events.map((e) => [e.attributes.reason, e.attributes.closeCode])).toEqual([['denied', null]]);
		}

		// A decision pending when the client closed is reported only once it refuses.
		events = [];
		let refuse;
		const waiting = setup(() => new Promise((resolve) => { refuse = resolve; }));
		waiting.gate.send(waiting.ws, envelope(1));
		waiting.gate.closed(waiting.ws);
		expect(timers.pending.size).toBe(0);
		refuse(false);
		await flush();
		expect(events.map((e) => [e.attributes.reason, e.attributes.closeCode])).toEqual([['denied', null]]);

		// A decision left pending when the policy closed the socket: nothing held,
		// no timer, and no report unless it later refuses.
		events = [];
		const pending = setup((socketRef) => { socketRef.end(4401, 'Session revoked'); return new Promise(() => {}); });
		expect(() => pending.gate.send(pending.ws, envelope(1))).toThrow('closed');
		expect(pending.gate.holding).toBe(0);
		expect(timers.pending.size).toBe(0);
		expect(events).toEqual([]);
	});

	it('answers for a socket whose close event arrived exactly as the closed native socket', () => {
		let calls = 0;
		const { gate, ws } = setup(() => { calls++; return true; });
		ws.end(1000);
		gate.closed(ws);
		expect(() => gate.send(ws, envelope(1))).toThrow('closed');
		expect(() => gate.control(ws, '{"type":"note"}')).toThrow('closed');
		expect(() => gate.sendReplaceable(ws, envelope(2))).toThrow('closed');
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 1 };
		expect(gate.publish(app, new Set([ws]), 'scan', envelope(3))).toBe(false);
		expect(gate.holding).toBe(0);
		expect(calls).toBe(0);
	});

	it('forgets a socket whose end throws because it is already gone', () => {
		const { gate } = setup(() => false);
		const ws = socket();
		const gone = () => { throw new Error('Invalid access of closed uWS.WebSocket'); };
		ws.end = gone;
		expect(gate.send(ws, envelope(1))).toBe(2);
		expect(gate.holding).toBe(0);
		ws.send = gone;
		expect(() => gate.send(ws, envelope(2))).toThrow('closed');
		expect(gate.holding).toBe(0);
	});

	it('shows the policy the logical topic and kind of replay and request frames', () => {
		const seen = [];
		const { gate, ws } = setup((_ws, delivery) => { seen.push(delivery); return delivery.topic !== 'b'; });
		gate.send(ws, JSON.stringify({ type: 'request', ref: 1, event: 'ask', data: { q: 1 } }));
		gate.send(ws, JSON.stringify({ topic: '__replay:feed', event: 'msg', data: { seq: 3 } }));
		gate.send(ws, JSON.stringify({ type: 'batch', events: [{ topic: 'a', event: 'e', data: 1 }, { topic: 'b', event: 'e', data: 2 }] }));
		expect(seen).toEqual([
			{ topic: null, event: 'ask', data: { q: 1 }, binary: false, kind: 'request' },
			{ topic: 'feed', event: 'msg', data: { seq: 3 }, binary: false, kind: 'replay' },
			{ topic: 'a', event: 'e', data: 1, binary: false, kind: 'message' },
			{ topic: 'b', event: 'e', data: 2, binary: false, kind: 'message' }
		]);
		expect(ws.sent).toHaveLength(2);
		expect(ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
	});

	it('checks every event of a batch when the policy answers asynchronously', async () => {
		const asked = [];
		const { gate, ws } = setup(async (_ws, delivery) => { asked.push(delivery.topic); return delivery.topic !== 'b'; });
		gate.send(ws, JSON.stringify({ type: 'batch', events: [{ topic: 'a', event: 'e', data: 1 }, { topic: 'b', event: 'e', data: 2 }] }));
		await flush();
		expect(asked).toEqual(['a', 'b']);
		expect(ws.sent).toEqual([]);
		expect(ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
	});

	it('stops cleanly when the policy itself closes the connection', () => {
		const { gate, ws } = setup((socketRef) => { socketRef.end(4002, 'gone'); return true; });
		ws.buffer(1);
		gate.send(ws, envelope(1));
		gate.send(ws, envelope(2));
		ws.buffer(0);
		gate.drain(ws);
		expect(ws.sent).toEqual([]);
		expect(ws.ended).toEqual({ code: 4002, reason: 'gone' });
		expect(gate.pendingBytes(ws)).toBe(0);
	});

	it('discards held frames when the connection closes', async () => {
		let release;
		const { gate, ws } = setup(() => new Promise((resolve) => { release = resolve; }));
		gate.send(ws, envelope(1));
		expect(gate.pendingBytes(ws)).toBeGreaterThan(0);
		gate.closed(ws);
		expect(gate.pendingBytes(ws)).toBe(0);
		release(true);
		await flush();
		expect(ws.sent).toEqual([]);
	});

	it('adds held bytes to the pressure sampler reading', () => {
		const ws = socket();
		ws.buffer(10);
		const held = () => 70000;
		expect(foldConnectionBackpressure([ws], 10, 65536)).toEqual({ maxBufferedBytes: 10, backpressuredConnections: 0, sampled: 1 });
		expect(foldConnectionBackpressure([ws], 10, 65536, held)).toEqual({ maxBufferedBytes: 70010, backpressuredConnections: 1, sampled: 1 });
	});

	it('bounds the production boundary by the configured maxBackpressure and counts its drops', async () => {
		const globals = { ENV_PREFIX: globalThis.ENV_PREFIX, WS_PATH: globalThis.WS_PATH, WS_OPTIONS: globalThis.WS_OPTIONS };
		globalThis.ENV_PREFIX = '';
		globalThis.WS_PATH = '/ws';
		globalThis.WS_OPTIONS = { maxBackpressure: 400, closeOnBackpressureLimit: false };
		try {
			const { deliveryAuthorization } = await import('../../src/runtime/handler/delivery-authorization.js?bound=' + Date.now());
			const { wsCounters: counters } = await import('../../src/runtime/handler/ws-state.js');
			deliveryAuthorization.configure(() => true);
			const ws = socket();
			ws.buffer(401);
			const before = counters.droppedFramesWindow;
			expect(deliveryAuthorization.send(ws, envelope(1))).toBe(2);
			expect(counters.droppedFramesWindow).toBe(before + 1);
			ws.buffer(399);
			expect(deliveryAuthorization.send(ws, envelope(2))).toBe(0);
		} finally {
			for (const [key, value] of Object.entries(globals)) {
				if (value === undefined) delete globalThis[key];
				else globalThis[key] = value;
			}
		}
	});

	it('charges held application text twice and control and binary frames once, each with its entry', () => {
		const text = envelope('t'.repeat(100));
		const control = '{"type":"note","pad":"' + 'c'.repeat(100) + '"}';
		const frame = buildBinaryFrame(1, 7, 0, new Uint8Array(100));
		const first = 2 * text.length + 128;
		const cases = [
			['text', (gate, ws) => gate.send(ws, text), 2 * text.length + 128, text.length],
			['control', (gate, ws) => gate.control(ws, control), control.length + 128, control.length],
			['binary', (gate, ws) => gate.send(ws, frame, true, false, 'scan'), frame.byteLength + 128, frame.byteLength]
		];
		for (const [label, add, charge, size] of cases) {
			// Exactly at the bound the next frame is still held; one byte under, dropped.
			for (const [bound, status] of [[1 + first + charge, 0], [first + charge, 2]]) {
				const { gate, ws } = setup(() => true, { maxPendingBytes: bound });
				ws.buffer(1);
				expect(gate.send(ws, text), label).toBe(0);
				expect(add(gate, ws), label).toBe(0);
				// bufferedAmount reports what is held, not what the bound counts.
				expect(gate.pendingBytes(ws), label).toBe(text.length + size);
				expect(gate.send(ws, envelope('probe')), label + ' at ' + bound).toBe(status);
			}
		}
	});

	it('counts a dropped frame by its encoded bytes', () => {
		const drops = [];
		const { gate, ws } = setup(() => true, undefined, { maxPendingBytes: 10, onDrop: (_ws, bytes) => drops.push(bytes) });
		ws.buffer(11);
		const text = envelope('\u00e9'.repeat(20));
		const frame = buildBinaryFrame(1, 7, 0, new Uint8Array(30));
		expect(gate.send(ws, text)).toBe(2);
		expect(gate.send(ws, frame, true, false, 'scan')).toBe(2);
		expect(drops).toEqual([Buffer.byteLength(text), frame.byteLength]);
		expect(drops[0]).toBeGreaterThan(text.length);
	});

	it('closes an overflowing socket once the operation in progress finished, as the transport defers its close', () => {
		const order = [];
		const { gate, attach } = setup(() => true, undefined, { maxPendingBytes: 10, closeOnOverflow: true });
		const full = attach(socket('full'));
		const next = attach(socket('next'));
		full.buffer(11);
		const close = full.close.bind(full);
		full.close = () => { order.push('close full'); close(); };
		const send = next.send.bind(next);
		next.send = (payload) => { order.push('send next'); return send(payload); };
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 2 };
		expect(gate.publish(app, new Set([full, next]), 'scan', envelope(1))).toBe(true);
		expect(order).toEqual(['send next', 'close full']);
		expect(full.closedAbruptly).toBe(true);
	});

	it('runs nothing it queued while a policy resumed after an await is still deciding', async () => {
		let active = 0;
		let overlapped = false;
		const { gate, attach } = setup(null);
		const a = attach(socket('a'));
		const b = attach(socket('b'));
		gate.configure((ws, delivery) => {
			active++;
			try {
				if (active > 1) overlapped = true;
				if (delivery.topic === 'first') return Promise.resolve(true);
				if (delivery.topic === 'second' && ws === a) {
					// A fan-out opened while deciding the second event of the batch.
					const opened = gate.begin();
					try { gate.send(b, envelope('nested')); } finally { gate.finish(opened); }
				}
				return true;
			} finally {
				active--;
			}
		});
		gate.send(a, JSON.stringify({ type: 'batch', events: [{ topic: 'first', event: 'e', data: 1 }, { topic: 'second', event: 'e', data: 2 }] }));
		await flush();
		expect(overlapped).toBe(false);
		expect(a.sent).toHaveLength(1);
		expect(b.sent.map((f) => f.data)).toEqual(['nested']);
	});

	it('accepts any thenable as a pending decision', async () => {
		const thenable = (answer) => ({ then(resolve) { queueMicrotask(() => resolve(answer)); } });
		const yes = setup(() => thenable(true));
		expect(yes.gate.send(yes.ws, envelope(1))).toBe(0);
		await flush();
		expect(yes.ws.sent.map((f) => f.data)).toEqual([1]);
		const no = setup(() => thenable(false));
		no.gate.send(no.ws, envelope(1));
		await flush();
		expect(no.ws.sent).toEqual([]);
		expect(no.ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
	});

	it('reports a decision that timed out once, even when it refuses afterwards', async () => {
		captureDiagnostics();
		const timers = virtualTimers();
		let answer;
		const { gate, ws } = setup(() => new Promise((resolve) => { answer = resolve; }), { timeoutMs: 20 });
		gate.send(ws, envelope(1));
		timers.fireAll();
		answer(false);
		await flush();
		expect(events.map((e) => e.attributes.reason)).toEqual(['timeout']);
		expect(ws.ended?.code).toBe(DELIVERY_FAILED_CLOSE_CODE);
	});

	it('bounds a pending decision by 5000 ms unless configured', () => {
		const timers = virtualTimers();
		const { gate, ws } = setup(() => new Promise(() => {}));
		gate.send(ws, envelope(1));
		expect([...timers.pending.values()].map((t) => t.ms)).toEqual([5000]);
	});

	it('reports a policy error with its class and message, the connection and the severity', () => {
		captureDiagnostics();
		const named = (id) => {
			const ws = socket(id);
			ws.getUserData = () => ({ id, [WS_PLATFORM]: { requestId: 'req-' + id } });
			return ws;
		};
		const thrower = createDeliveryAuthorization();
		thrower.configure(() => { throw new Error('db unavailable'); });
		const failing = named('failing');
		failing.onClose = () => thrower.closed(failing);
		thrower.send(failing, envelope(1));
		const refuser = createDeliveryAuthorization();
		refuser.configure(() => false);
		const refused = named('refused');
		refused.onClose = () => refuser.closed(refused);
		refuser.send(refused, envelope(1));
		expect(events.map((e) => [e.event, e.severity, e.attributes.requestId])).toEqual([
			['delivery-authorization.failed', 'error', 'req-failing'],
			['delivery-authorization.denied', 'warn', 'req-refused']
		]);
		expect(events[0].attributes.error).toEqual({ name: 'Error', code: null, message: 'db unavailable' });
		expect(events[1].attributes).not.toHaveProperty('error');
	});

	it('refuses a latest-value frame offered inside a decision and hands the newest on after it', () => {
		let nested = false;
		let latest = null;
		const gate = createDeliveryAuthorization({
			// The surface's coalesced flush: the newest value, sent replaceably.
			onIdle: (socketRef) => {
				if (latest === null) return;
				const value = latest;
				latest = null;
				gate.sendReplaceable(socketRef, envelope(value));
			}
		});
		const ws = socket();
		ws.onClose = () => gate.closed(ws);
		gate.configure((socketRef, delivery) => {
			if (delivery.data === 'A' && !nested) {
				nested = true;
				for (const value of ['B1', 'B2']) {
					latest = value;
					expect(gate.sendReplaceable(socketRef, envelope(value))).toBe(2);
				}
			}
			return true;
		});
		gate.send(ws, envelope('A'));
		// No stale value reaches the client: only the newest, after the frame decided.
		expect(ws.sent.map((f) => f.data)).toEqual(['A', 'B2']);
	});

	it('keeps a failing idle handler out of the drain that ran it', () => {
		const gate = createDeliveryAuthorization({ onIdle: () => { throw new Error('flush failed'); } });
		gate.configure(() => true);
		const ws = socket();
		ws.buffer(1);
		gate.send(ws, envelope(1));
		ws.buffer(0);
		expect(gate.drain(ws)).toBe(true);
		expect(ws.sent).toHaveLength(1);
		expect(gate.holding).toBe(0);
	});

	it('answers a drain that closed the connection with false', () => {
		const { gate, ws } = setup(() => false);
		ws.buffer(1);
		gate.send(ws, envelope(1));
		ws.buffer(0);
		expect(gate.drain(ws)).toBe(false);
		expect(ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
		const open = setup(() => true);
		expect(open.gate.drain(open.ws)).toBe(true);
		expect(createDeliveryAuthorization().drain(socket())).toBe(true);
	});

	it('marks a request frame held until the transport takes it, and never handed over when refused', async () => {
		const request = (event) => JSON.stringify({ type: 'request', ref: 1, event, data: null });
		let release;
		const held = setup((_ws, delivery) => (delivery.event === 'ask' ? new Promise((resolve) => { release = resolve; }) : true));
		const receipt = { status: 2, held: false };
		expect(held.gate.send(held.ws, request('ask'), false, false, null, null, receipt)).toBe(0);
		expect(receipt.held).toBe(true);
		release(true);
		await flush();
		expect(receipt).toEqual({ status: 1, held: false });

		const refused = setup(() => Promise.resolve(false));
		const lost = { status: 2, held: false };
		refused.gate.send(refused.ws, request('ask'), false, false, null, null, lost);
		await flush();
		expect(refused.ws.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
		expect(lost.held).toBe(true);

		// Issued from inside a decision: held until the decided frame is out.
		let nested = null;
		const inner = setup(null);
		inner.gate.configure((socketRef, delivery) => {
			if (delivery.event !== 'ask' && nested === null) {
				nested = { status: 2, held: false };
				inner.gate.send(socketRef, request('ask'), false, false, null, null, nested);
				expect(nested.held).toBe(true);
			}
			return true;
		});
		inner.gate.send(inner.ws, envelope(1));
		expect(nested).toEqual({ status: 1, held: false });
		expect(inner.ws.sent.map((f) => f.data ?? f.event)).toEqual([1, 'ask']);
	});

	it('lets go of frames still queued when their connection closes', async () => {
		const v8 = await import('node:v8');
		const vm = await import('node:vm');
		v8.setFlagsFromString('--expose-gc');
		const gc = vm.runInNewContext('gc');
		let resolve;
		const { gate, ws } = setup((_ws, delivery) => (delivery.binary ? true : new Promise((r) => { resolve = r; })));
		gate.send(ws, envelope('first'));
		let queued = buildBinaryFrame(1, 7, 0, new Uint8Array(4096));
		expect(gate.send(ws, queued, true, false, 'scan')).toBe(0);
		const ref = new WeakRef(queued);
		queued = null;
		gate.closed(ws);
		// The decision is still pending, and its callback still reaches the backlog.
		await new Promise((r) => setTimeout(r, 0));
		gc();
		expect(ref.deref()).toBeUndefined();
		resolve(true);
	});

	it('ends a refused connection once the fan-out finished, so its close hook follows the frame', () => {
		const { gate, attach } = setup((ws) => ws.id !== 'refused');
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 3 };
		const refused = attach(socket('refused'));
		const later = [attach(socket('b')), attach(socket('c'))];
		const sockets = new Set([refused, ...later]);
		// The close hook publishes, as an application's leave notice does.
		refused.onClose = () => {
			gate.closed(refused);
			gate.publish(app, sockets, 'scan', envelope('left'));
		};
		gate.publish(app, sockets, 'scan', envelope('outer'));
		expect(refused.ended?.code).toBe(DELIVERY_REFUSED_CLOSE_CODE);
		for (const ws of later) expect(ws.sent.map((f) => f.data)).toEqual(['outer', 'left']);
		expect(refused.sent).toEqual([]);
	});

	it('sends what a decision queued natively once the policy was removed meanwhile', () => {
		const { gate, attach } = setup(null);
		const a = attach(socket('a'));
		const b = attach(socket('b'));
		gate.configure((ws) => {
			if (ws === a) {
				gate.send(b, envelope('queued'));
				gate.reset();
			}
			return true;
		});
		gate.send(a, envelope('decided'));
		expect(a.sent.map((f) => f.data)).toEqual(['decided']);
		expect(b.sent.map((f) => f.data)).toEqual(['queued']);
		expect(b.ended).toBeNull();
	});

	it('keeps a request queued by a decision marked held when its socket closed before it ran', () => {
		const { gate, attach } = setup(null);
		const a = attach(socket('a'));
		const b = attach(socket('b'));
		const receipt = { status: 2, held: false };
		gate.configure((ws) => {
			if (ws === a) {
				gate.send(b, JSON.stringify({ type: 'request', ref: 1, event: 'ask', data: null }), false, false, null, null, receipt);
				b.end(1000);
			}
			return true;
		});
		gate.send(a, envelope('decided'));
		expect(b.sent).toEqual([]);
		// Never handed to the transport: the close sweep reads it as never sent.
		expect(receipt.held).toBe(true);
	});

	it('corks the frames one publish walk or one drain hands to a socket', () => {
		const corked = (id) => {
			const ws = socket(id);
			ws.corks = 0;
			ws.inCork = false;
			ws.cork = function (fn) { this.corks++; this.inCork = true; try { fn(); } finally { this.inCork = false; } };
			const send = ws.send.bind(ws);
			ws.uncorked = 0;
			ws.send = function (payload) { if (!this.inCork) this.uncorked++; return send(payload); };
			return ws;
		};
		const { gate, attach } = setup(() => true);
		const app = { publish() { throw new Error('native broadcast bypass'); }, numSubscribers: () => 2 };
		const walked = [attach(corked('a')), attach(corked('b'))];
		gate.publish(app, new Set(walked), 'scan', envelope(1));
		for (const ws of walked) expect([ws.corks, ws.uncorked, ws.sent.length]).toEqual([1, 0, 1]);
		const drained = attach(corked('drained'));
		drained.buffer(1);
		for (let i = 0; i < 3; i++) gate.send(drained, envelope(i));
		drained.buffer(0);
		gate.drain(drained);
		expect([drained.corks, drained.uncorked, drained.sent.length]).toEqual([1, 0, 3]);
	});
});
