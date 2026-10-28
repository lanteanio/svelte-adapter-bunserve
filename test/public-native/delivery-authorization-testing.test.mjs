// platform.authorizeDelivery through createTestServer over native Bun sockets.
// Delivery decisions, ordering, coalescing and close follow the built runtime.

import { describe, test as it, expect, afterEach } from 'bun:test';
import { setOperationalEventSink } from '../../src/runtime/diagnostic.js';

const describeUWS = describe;

// Every client a test opened, terminated after it.
const openedClients = [];

/** A ws client recording parsed frames and its close code. */
async function client(url, headers) {
	// Use the package implementation so the backpressure case can pause its TCP reader.
	const { default: WebSocket } = await import(new URL('./lib/websocket.js', import.meta.resolve('ws/package.json')).href);
	const ws = new WebSocket(url, headers ? { headers } : undefined);
	const frames = [];
	const state = { ws, frames, closeCode: null };
	openedClients.push(state);
	ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { frames.push(raw.toString()); } });
	ws.on('close', (code) => { state.closeCode = code; });
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	state.send = (msg) => ws.send(JSON.stringify(msg));
	return state;
}

/**
 * The shared application: ids starting with `held-` wait on `gate.release`,
 * revoked ids are refused, the `control` topic is always admitted.
 */
function application() {
	const revoked = new Set();
	let release;
	const pending = new Promise((resolve) => { release = resolve; });
	const sockets = new Map();
	const app = {
		revoked,
		release: () => release(),
		sockets,
		handler: {
			upgrade: ({ headers }) => ({ id: headers['x-id'] || 'anon' }),
			contexts: [],
			open(ws) { sockets.set(ws.getUserData().id, ws); },
			subscribe: (ws) => !revoked.has(ws.getUserData().id),
			init({ platform }) {
				app.platform = platform;
				platform.authorizeDelivery((ws, delivery) => {
					app.handler.contexts.push(delivery);
					// A binary frame must name an application topic, never an internal one.
					if (delivery.binary && delivery.topic !== 'scan') return false;
					const id = ws.getUserData().id;
					const allowed = () => delivery.topic === 'control' || !revoked.has(id);
					return id.startsWith('held-') ? pending.then(allowed) : allowed();
				});
			}
		}
	};
	return app;
}

async function subscribed(c, topic, ref) {
	c.send({ type: 'subscribe', topic, ref });
	const deadline = Date.now() + 2000;
	while (!c.frames.some((f) => f?.type === 'subscribed' && f.ref === ref)) {
		if (Date.now() > deadline) throw new Error('subscribe was not acknowledged');
		await new Promise((r) => setTimeout(r, 10));
	}
}

const until = async (predicate, ms = 2000) => {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('condition not reached');
		await new Promise((r) => setTimeout(r, 10));
	}
};

/**
 * An application whose policy publishes `after` on the first frame it decides
 * of a call whose event starts with `nest` (or, armed, on the first binary
 * frame). That publish must reach every socket after the whole call.
 */
function nestingApplication({ binary = false } = {}) {
	const app = application();
	let fired = false;
	app.handler.init = ({ platform }) => {
		app.platform = platform;
		platform.authorizeDelivery((_ws, delivery) => {
			const trigger = binary ? delivery.binary : typeof delivery.event === 'string' && delivery.event.startsWith('nest');
			if (trigger && !fired) {
				fired = true;
				platform.publish('scan', 'after', 0);
			}
			return true;
		});
	};
	return app;
}

/** A policy that, deciding the frame `first`, offers two coalesced values for one key. */
function coalescingApplication() {
	const app = application();
	let offered = false;
	app.handler.init = ({ platform }) => {
		app.platform = platform;
		platform.authorizeDelivery((ws, delivery) => {
			if (delivery.event === 'first' && !offered) {
				offered = true;
				for (const data of [1, 2]) platform.sendCoalesced(ws, { key: 'k', topic: 'scan', event: 'latest', data });
			}
			return true;
		});
	};
	return app;
}
const latestOf = (reader) => reader.frames.filter((f) => f?.event === 'first' || f?.event === 'latest').map((f) => f.event + ':' + f.data);

/** The call's frames and the nested publish, in arrival order. */
const sequenceOf = (reader) => reader.frames
	.map((f) => (typeof f === 'string' ? 'binary' : f?.event))
	.filter((e) => e === 'binary' || e === 'after' || (typeof e === 'string' && e.startsWith('nest')));

const NEST_CODECS = {
	shared: { capability: 'surface.nest-shared:1', schemaVersion: 1, shared: true, encode: () => new TextEncoder().encode('nest-shared-frame') },
	stateless: { capability: 'surface.nest-stateless:1', schemaVersion: 1, encode: () => new TextEncoder().encode('nest-stateless-frame') },
	stateful: { capability: 'surface.nest-state:1', schemaVersion: 1, state: { onAttach: () => ({}) }, encode: () => new TextEncoder().encode('nest-state-frame') }
};

// Each call delivers two frames to every reader; the second must arrive
// before the publish its first frame's decision issued.
const NEST_CALLS = {
	'publishBatched (per-event path)': (platform) => platform.publishBatched([
		{ topic: 'scan', event: 'nest-1', data: 1 },
		{ topic: 'scan', event: 'nest-2', data: 2 }
	]),
	batch: (platform) => platform.batch([
		{ topic: 'scan', event: 'nest-1', data: 1 },
		{ topic: 'scan', event: 'nest-2', data: 2 }
	]),
	'publishWireBatch (stateless codec)': (platform) => platform.publishWireBatch('scan', 'nest-wb', [{ data: 1 }, { data: 2 }], NEST_CODECS.stateless),
	'publishWireBatch (stateful codec)': (platform) => platform.publishWireBatch('scan', 'nest-wb', [{ data: 1 }, { data: 2 }], NEST_CODECS.stateful)
};
const NEST_EXPECTED = {
	'publishBatched (per-event path)': ['nest-1', 'nest-2', 'after'],
	batch: ['nest-1', 'nest-2', 'after'],
	'publishWireBatch (stateless codec)': ['nest-wb', 'nest-wb', 'after'],
	'publishWireBatch (stateful codec)': ['nest-wb', 'nest-wb', 'after']
};

describeUWS('authorizeDelivery through createTestServer', () => {
	let server = null;
	let dispose = null;
	// Servers a test closes itself, closed here only when it failed first.
	const servers = [];
	afterEach(async () => {
		for (const c of openedClients.splice(0)) { try { c.ws.terminate(); } catch { /* gone */ } }
		for (const closing of servers.splice(0)) await closing.close();
		await server?.close();
		server = null;
		dispose?.();
		dispose = null;
	});

	it('delivers a synchronous burst inline and closes a revoked socket with 1013', async () => {
		const events = [];
		dispose = setOperationalEventSink((record) => { events.push(record); });
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		server = await createTestServer({ handler: app.handler });
		const reader = await client(server.wsUrl, { 'x-id': 'reader' });
		await subscribed(reader, 'scan', 1);
		const ws = app.sockets.get('reader');
		for (let i = 0; i < 300; i++) expect(app.platform.send(ws, 'scan', 'burst', i)).toBe(1);
		await until(() => reader.frames.filter((f) => f?.event === 'burst').length === 300);
		expect(reader.frames.filter((f) => f?.event === 'burst').map((f) => f.data)).toEqual(Array.from({ length: 300 }, (_, i) => i));
		app.revoked.add('reader');
		app.platform.publish('scan', 'after', 'secret');
		await until(() => reader.closeCode !== null);
		expect(reader.closeCode).toBe(1013);
		expect(reader.frames.some((f) => f?.event === 'after')).toBe(false);
		expect(events.map((e) => e.event)).toContain('delivery-authorization.denied');
	});

	it('parses a sendTo frame once for every recipient', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		server = await createTestServer({ handler: app.handler });
		const readers = [];
		for (const id of ['a', 'b', 'c']) {
			const reader = await client(server.wsUrl, { 'x-id': id });
			await subscribed(reader, 'scan', id);
			readers.push(reader);
		}
		app.handler.contexts.length = 0;
		const parse = JSON.parse;
		let parses = 0;
		JSON.parse = function (...args) { parses++; return parse.apply(this, args); };
		let count;
		try { count = app.platform.sendTo(() => true, 'scan', 'once', 1); } finally { JSON.parse = parse; }
		expect(count).toBe(3);
		expect(parses).toBe(1);
		expect(new Set(app.handler.contexts).size).toBe(1);
		for (const reader of readers) await until(() => reader.frames.some((f) => f?.event === 'once'));
	});

	it('checks a shared-codec cohort frame under its application topic', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		const codec = { capability: 'surface.shared:1', schemaVersion: 1, shared: true, encode: () => new TextEncoder().encode('shared-frame') };
		server = await createTestServer({ handler: app.handler });
		app.platform.registerWireCodec(codec);
		const reader = await client(server.wsUrl, { 'x-id': 'reader' });
		reader.send({ type: 'hello', caps: ['surface.shared:1'] });
		await subscribed(reader, 'scan', 1);
		app.platform.publishWire('scan', 'tick', { n: 1 }, codec);
		await until(() => reader.frames.some((f) => typeof f === 'string' && f.includes('shared-frame')));
		expect(app.handler.contexts.filter((d) => d.binary).map((d) => d.topic)).toEqual(['scan']);
		expect(reader.closeCode).toBeNull();
	});

	it('names the topic of stateful binary frames and parses batch envelopes once', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		const codec = {
			capability: 'surface.state:1',
			schemaVersion: 1,
			state: { onAttach: () => ({}) },
			encode: () => new TextEncoder().encode('state-frame')
		};
		server = await createTestServer({ handler: app.handler });
		app.platform.registerWireCodec(codec);
		const capable = await client(server.wsUrl, { 'x-id': 'capable' });
		capable.send({ type: 'hello', caps: ['surface.state:1'] });
		await subscribed(capable, 'scan', 'capable');
		const plain = [];
		for (const id of ['p1', 'p2']) {
			const reader = await client(server.wsUrl, { 'x-id': id });
			await subscribed(reader, 'scan', id);
			plain.push(reader);
		}
		app.platform.publishWire('scan', 'tick', { n: 1 }, codec);
		await until(() => capable.frames.some((f) => typeof f === 'string' && f.includes('state-frame')));
		expect(capable.closeCode).toBeNull();
		expect(app.handler.contexts.filter((d) => d.binary).map((d) => d.topic)).toEqual(['scan']);
		const parse = JSON.parse;
		let parses = 0;
		JSON.parse = function (...args) { parses++; return parse.apply(this, args); };
		try { app.platform.publishWireBatch('scan', 'batch', [{ data: 1 }], codec); } finally { JSON.parse = parse; }
		expect(parses).toBe(1);
		for (const reader of plain) await until(() => reader.frames.some((f) => f?.event === 'batch'));
		expect(capable.closeCode).toBeNull();
	});

	it('waits at close for frames still held, as production shutdown does', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		const closing = await createTestServer({ handler: app.handler });
		servers.push(closing);
		const reader = await client(closing.wsUrl, { 'x-id': 'held-reader' });
		await subscribed(reader, 'scan', 1);
		expect(app.platform.send(app.sockets.get('held-reader'), 'scan', 'parting', 1)).toBe(0);
		// Past close()'s own one-second wait for sockets to leave.
		let released = false;
		setTimeout(() => { released = true; app.release(); }, 1300);
		await closing.close();
		// Closed once; the native listen socket must not be closed again.
		servers.splice(servers.indexOf(closing), 1);
		expect(released).toBe(true);
		await until(() => reader.closeCode !== null);
		expect(reader.frames.some((f) => f?.event === 'parting')).toBe(true);
		expect(reader.closeCode).toBe(1001);
	});

	it('stops waiting at close for held frames once the shutdown budget is spent', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const before = process.env.SHUTDOWN_TIMEOUT;
		process.env.SHUTDOWN_TIMEOUT = '1';
		try {
			const app = application();
			const init = app.handler.init;
			app.handler.init = ({ platform }) => { init({ platform: { ...platform, authorizeDelivery: (fn) => platform.authorizeDelivery(fn, { timeoutMs: 20000 }) } }); app.platform = platform; };
			const closing = await createTestServer({ handler: app.handler });
			servers.push(closing);
			const reader = await client(closing.wsUrl, { 'x-id': 'held-forever' });
			await subscribed(reader, 'scan', 1);
			app.platform.send(app.sockets.get('held-forever'), 'scan', 'never', 1);
			const started = Date.now();
			await closing.close();
			servers.splice(servers.indexOf(closing), 1);
			expect(Date.now() - started).toBeLessThan(6000);
			// The connection still waiting is closed outright, not left behind.
			await until(() => reader.closeCode !== null);
			expect(reader.frames.some((f) => f?.event === 'never')).toBe(false);
		} finally {
			if (before === undefined) delete process.env.SHUTDOWN_TIMEOUT;
			else process.env.SHUTDOWN_TIMEOUT = before;
		}
	}, 25000);

	it('orders, coalesces and counts frames held behind a pending decision', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		server = await createTestServer({ handler: app.handler });
		const reader = await client(server.wsUrl, { 'x-id': 'held-reader' });
		await subscribed(reader, 'scan', 1);
		const ws = app.sockets.get('held-reader');
		app.platform.send(ws, 'scan', 'first', 1);
		expect(app.platform.bufferedAmount(ws)).toBeGreaterThan(0);
		for (let i = 1; i <= 5; i++) app.platform.sendCoalesced(ws, { key: 'k', topic: 'scan', event: 'latest', data: i });
		reader.send({ type: 'subscribe', topic: 'other', ref: 'late' });
		await new Promise((r) => setTimeout(r, 50));
		expect(reader.frames.some((f) => f?.event === 'first' || f?.ref === 'late')).toBe(false);
		app.release();
		await until(() => reader.frames.some((f) => f?.event === 'latest') && reader.frames.some((f) => f?.ref === 'late'));
		const first = reader.frames.findIndex((f) => f?.event === 'first');
		const ack = reader.frames.findIndex((f) => f?.ref === 'late');
		expect(first).toBeLessThan(ack);
		await new Promise((r) => setTimeout(r, 50));
		// Every value arrived while a frame was held, so only the newest is sent.
		expect(reader.frames.filter((f) => f?.event === 'latest').map((f) => f.data)).toEqual([5]);
		expect(app.platform.bufferedAmount(ws)).toBe(0);
	});

	it.each(Object.keys(NEST_CALLS))('delivers what a policy issues during %s after the whole call', async (call) => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = nestingApplication();
		server = await createTestServer({ handler: app.handler });
		const readers = [];
		for (const id of ['r1', 'r2']) {
			const reader = await client(server.wsUrl, { 'x-id': id });
			await subscribed(reader, 'scan', id);
			readers.push(reader);
		}
		NEST_CALLS[call](app.platform);
		for (const reader of readers) {
			await until(() => sequenceOf(reader).includes('after'));
			expect(sequenceOf(reader)).toEqual(NEST_EXPECTED[call]);
		}
	});

	it('delivers what a policy issues while deciding a binary cohort frame after the JSON cohort', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = nestingApplication({ binary: true });
		server = await createTestServer({ handler: app.handler });
		app.platform.registerWireCodec(NEST_CODECS.shared);
		const capable = await client(server.wsUrl, { 'x-id': 'capable' });
		capable.send({ type: 'hello', caps: [NEST_CODECS.shared.capability] });
		await subscribed(capable, 'scan', 'capable');
		const plain = await client(server.wsUrl, { 'x-id': 'plain' });
		await subscribed(plain, 'scan', 'plain');
		app.platform.publishWire('scan', 'nest-shared', { n: 1 }, NEST_CODECS.shared);
		await until(() => sequenceOf(capable).includes('after') && sequenceOf(plain).includes('after'));
		expect(sequenceOf(capable)).toEqual(['binary', 'after']);
		expect(sequenceOf(plain)).toEqual(['nest-shared', 'after']);
	});

	it('runs no drain work for a connection a refusal closed while it drained', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		const closed = new Set();
		const drainedAfterClose = [];
		app.handler.close = (ws) => { closed.add(ws.getUserData().id); };
		app.handler.drain = (ws) => { if (closed.has(ws.getUserData().id)) drainedAfterClose.push(ws.getUserData().id); };
		server = await createTestServer({ handler: app.handler });
		const reader = await client(server.wsUrl, { 'x-id': 'drain-reader' });
		await subscribed(reader, 'scan', 1);
		const ws = app.sockets.get('drain-reader');
		// Stop reading until a frame waits behind the transport for a drain.
		reader.ws._socket.pause();
		for (let i = 0; i < 80 && app.platform.bufferedAmount(ws) <= ws.getBufferedAmount(); i++) {
			app.platform.send(ws, 'scan', 'big', 'x'.repeat(300000));
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(app.platform.bufferedAmount(ws)).toBeGreaterThan(ws.getBufferedAmount());
		app.revoked.add('drain-reader');
		reader.ws._socket.resume();
		await until(() => reader.closeCode !== null, 10000);
		expect(reader.closeCode).toBe(1013);
		expect(drainedAfterClose).toEqual([]);
	}, 30000);

	it('keeps only the newest coalesced value offered while a policy call runs', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = coalescingApplication();
		server = await createTestServer({ handler: app.handler });
		const reader = await client(server.wsUrl, { 'x-id': 'reader' });
		await subscribed(reader, 'scan', 1);
		app.platform.send(app.sockets.get('reader'), 'scan', 'first', 0);
		await until(() => latestOf(reader).includes('latest:2'));
		await new Promise((r) => setTimeout(r, 50));
		expect(latestOf(reader)).toEqual(['first:0', 'latest:2']);
	});

	it('runs the close hook of a socket refused during a publish after the publish reached the rest', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		app.handler.close = (ws, { platform }) => { platform.publish('scan', 'left', ws.getUserData().id); };
		server = await createTestServer({ handler: app.handler });
		const victim = await client(server.wsUrl, { 'x-id': 'victim' });
		await subscribed(victim, 'scan', 'victim');
		const readers = [];
		for (const id of ['b', 'c']) {
			const reader = await client(server.wsUrl, { 'x-id': id });
			await subscribed(reader, 'scan', id);
			readers.push(reader);
		}
		app.revoked.add('victim');
		app.platform.publish('scan', 'outer', 1);
		await until(() => victim.closeCode !== null);
		expect(victim.closeCode).toBe(1013);
		for (const reader of readers) {
			await until(() => reader.frames.some((f) => f?.event === 'left'));
			expect(reader.frames.filter((f) => f?.event === 'outer' || f?.event === 'left').map((f) => f.event)).toEqual(['outer', 'left']);
		}
	});

	it('rejects a request the policy held and then refused as never sent', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const app = application();
		server = await createTestServer({ handler: app.handler });
		const reader = await client(server.wsUrl, { 'x-id': 'held-asked' });
		await subscribed(reader, 'scan', 1);
		const asked = app.platform.request(app.sockets.get('held-asked'), 'ask', 1);
		app.revoked.add('held-asked');
		app.release();
		await expect(asked).rejects.toThrow('the request frame was never sent');
		await until(() => reader.closeCode !== null);
		expect(reader.closeCode).toBe(1013);
		expect(reader.frames.some((f) => f?.type === 'request')).toBe(false);
	});
});
