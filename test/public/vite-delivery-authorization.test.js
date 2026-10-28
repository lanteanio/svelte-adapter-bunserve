import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { setOperationalEventSink } from '../../src/runtime/diagnostic.js';
import { ADAPTER_ERROR_IDS, REQUEST_CLOSED_DETAIL, adapterErrorMessage } from '../../src/runtime/error-registry.js';


// Every client a test opened, terminated after it.
const openedClients = [];

/** A ws client recording parsed frames and its close code. */
async function client(url, headers) {
	const { WebSocket } = await import('ws');
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

describe('authorizeDelivery through the Vite plugin', () => {
	let httpServer = null;
	let dispose = null;
	const opened = [];
	afterEach(async () => {
		for (const c of opened.splice(0)) { try { c.ws.terminate(); } catch { /* gone */ } }
		openedClients.length = 0;
		dispose?.();
		dispose = null;
		if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
		httpServer = null;
	});

	async function bootDev(handlerRef) {
		const mod = await import('../../src/vite.js');
		const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });
		httpServer = createServer();
		await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
		const server = {
			httpServer,
			middlewares: { stack: [], use() {} },
			config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
			async ssrLoadModule() {
				if (handlerRef.loadError) throw handlerRef.loadError;
				return { default: handlerRef.current, ...handlerRef.current };
			}
		};
		await plugin.configureServer(server);
		await new Promise((r) => setTimeout(r, 60));
		return { plugin, server, url: 'ws://127.0.0.1:' + httpServer.address().port + '/ws' };
	}

	it('closes a revoked socket with 1013 and leaves a raw socket publish outside the policy', async () => {
		const app = application();
		app.handler.message = (ws, { data }) => {
			const msg = JSON.parse(Buffer.from(data).toString());
			if (msg.type === 'raw') ws.publish('scan', 'raw-' + msg.nonce);
		};
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		const writer = await client(dev.url, { 'x-id': 'writer' });
		opened.push(writer);
		await subscribed(reader, 'scan', 1);
		app.revoked.add('reader');
		writer.send({ type: 'raw', nonce: 'one' });
		await until(() => reader.frames.includes('raw-one'));
		expect(reader.closeCode).toBeNull();
		app.platform.publish('scan', 'after', 'secret');
		await until(() => reader.closeCode !== null);
		expect(reader.closeCode).toBe(1013);
		expect(reader.frames.some((f) => f?.event === 'after')).toBe(false);
	});

	it('hands on a frame held behind a raw socket publish once that write completes', async () => {
		const app = application();
		let status = null;
		app.handler.message = (ws, { data }) => {
			const msg = JSON.parse(Buffer.from(data).toString());
			if (msg.type !== 'raw-then-send') return;
			// The raw write leaves bytes unflushed for the next read of the
			// buffer, so the frame after it is held until that write completes.
			const reader = app.sockets.get('reader');
			let unflushed = true;
			reader.getBufferedAmount = () => (unflushed ? ((unflushed = false), 1) : 0);
			ws.publish('scan', 'raw');
			status = app.platform.send(reader, 'scan', 'after-raw', 1);
		};
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		const writer = await client(dev.url, { 'x-id': 'writer' });
		opened.push(writer);
		await subscribed(reader, 'scan', 1);
		writer.send({ type: 'raw-then-send' });
		await until(() => reader.frames.some((f) => f?.event === 'after-raw'), 5000);
		// Held behind the raw write's unflushed bytes, then handed on.
		expect(status).toBe(0);
	});

	it('delivers a publish a policy issues during a dev publish after it, everywhere', async () => {
		const app = application();
		let nested = false;
		app.handler.init = ({ platform }) => {
			app.platform = platform;
			platform.authorizeDelivery((_ws, delivery) => {
				if (delivery.event === 'outer' && !nested) {
					nested = true;
					platform.publish('scan', 'inner', 2);
				}
				return true;
			});
		};
		const dev = await bootDev({ current: app.handler });
		const readers = [];
		for (const id of ['r1', 'r2', 'r3']) {
			const reader = await client(dev.url, { 'x-id': id });
			opened.push(reader);
			await subscribed(reader, 'scan', id);
			readers.push(reader);
		}
		app.platform.publish('scan', 'outer', 1);
		for (const reader of readers) {
			await until(() => reader.frames.some((f) => f?.event === 'inner'));
			expect(reader.frames.filter((f) => f?.event === 'outer' || f?.event === 'inner').map((f) => f.event)).toEqual(['outer', 'inner']);
		}
	});

	it('reports a dev policy that closed the socket itself with no close code', async () => {
		const events = [];
		dispose = setOperationalEventSink((record) => { events.push(record); });
		const app = application();
		app.handler.init = ({ platform }) => {
			app.platform = platform;
			platform.authorizeDelivery((ws) => { ws.end(4401, 'Session revoked'); return false; });
		};
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		await subscribed(reader, 'scan', 1);
		app.platform.publish('scan', 'refused', 1);
		await until(() => reader.closeCode !== null);
		expect(reader.closeCode).toBe(4401);
		expect(events.filter((e) => e.event === 'delivery-authorization.denied').map((e) => e.attributes.closeCode)).toEqual([null]);
	});

	it('keeps the newest coalesced value and counts held bytes', async () => {
		const app = application();
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'held-reader' });
		opened.push(reader);
		await subscribed(reader, 'scan', 1);
		const ws = app.sockets.get('held-reader');
		app.platform.send(ws, 'scan', 'first', 1);
		expect(app.platform.bufferedAmount(ws)).toBeGreaterThan(0);
		for (let i = 1; i <= 5; i++) app.platform.sendCoalesced(ws, { key: 'k', topic: 'scan', event: 'latest', data: i });
		app.release();
		await until(() => reader.frames.some((f) => f?.event === 'latest' && f.data === 5));
		await new Promise((r) => setTimeout(r, 50));
		expect(reader.frames.filter((f) => f?.event === 'first' || f?.event === 'latest').map((f) => f.data)).toEqual([1, 5]);
	});

	it('runs a failed init again without reporting a second installation', async () => {
		const events = [];
		dispose = setOperationalEventSink((record) => { events.push(record); });
		let attempts = 0;
		const app = application();
		const install = app.handler.init;
		const handlerRef = {
			current: {
				...app.handler,
				init(ctx) {
					attempts++;
					install(ctx);
					if (attempts === 1) throw new Error('first init fails after installing its policy');
				}
			}
		};
		// The module fails to load, then its first init fails after installing
		// its policy; the next edit must run init again and recover.
		handlerRef.loadError = new Error('module does not load yet');
		const dev = await bootDev(handlerRef);
		handlerRef.loadError = null;
		handlerRef.current = { ...handlerRef.current };
		dev.plugin.handleHotUpdate({ server: dev.server });
		await until(() => events.some((e) => e.event === 'vite.handler.reload-failed'));
		handlerRef.current = { ...handlerRef.current };
		dev.plugin.handleHotUpdate({ server: dev.server });
		await until(() => events.filter((e) => e.event.startsWith('vite.handler.')).length >= 3);
		const reloads = events.filter((e) => e.event === 'vite.handler.reload-failed' || e.event === 'vite.handler.recovered');
		expect(reloads.map((e) => e.event)).toEqual(['vite.handler.reload-failed', 'vite.handler.recovered']);
		expect(reloads[0].attributes.error.message).toBe('first init fails after installing its policy');
		expect(attempts).toBe(2);
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		await subscribed(reader, 'scan', 1);
		app.revoked.add('reader');
		app.platform.publish('scan', 'after', 'secret');
		await until(() => reader.closeCode !== null);
		expect(reader.closeCode).toBe(1013);
	});

	it.each(Object.keys(NEST_CALLS))('delivers what a dev policy issues during %s after the whole call', async (call) => {
		const app = nestingApplication();
		const dev = await bootDev({ current: app.handler });
		const readers = [];
		for (const id of ['r1', 'r2']) {
			const reader = await client(dev.url, { 'x-id': id });
			opened.push(reader);
			await subscribed(reader, 'scan', id);
			readers.push(reader);
		}
		NEST_CALLS[call](app.platform);
		for (const reader of readers) {
			await until(() => sequenceOf(reader).includes('after'));
			expect(sequenceOf(reader)).toEqual(NEST_EXPECTED[call]);
		}
	});

	it('delivers what a dev policy issues during a mixed-topic publishBatched after the whole call', async () => {
		const app = nestingApplication();
		const dev = await bootDev({ current: app.handler });
		// One reader holds both topics, the other only one: the per-event path.
		const both = await client(dev.url, { 'x-id': 'both' });
		opened.push(both);
		await subscribed(both, 'scan', 'both-scan');
		await subscribed(both, 'other', 'both-other');
		const one = await client(dev.url, { 'x-id': 'one' });
		opened.push(one);
		await subscribed(one, 'scan', 'one-scan');
		app.platform.publishBatched([
			{ topic: 'scan', event: 'nest-1', data: 1 },
			{ topic: 'other', event: 'nest-2', data: 2 }
		]);
		await until(() => sequenceOf(both).includes('after') && sequenceOf(one).includes('after'));
		expect(sequenceOf(both)).toEqual(['nest-1', 'nest-2', 'after']);
		expect(sequenceOf(one)).toEqual(['nest-1', 'after']);
	});

	it('delivers what a dev policy issues during a shared-codec publishWire after it', async () => {
		const app = nestingApplication();
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		await subscribed(reader, 'scan', 1);
		app.platform.publishWire('scan', 'nest-shared', { n: 1 }, NEST_CODECS.shared);
		await until(() => sequenceOf(reader).includes('after'));
		expect(sequenceOf(reader)).toEqual(['nest-shared', 'after']);
	});

	it('never delivers a frame whose decision ended the dev connection with an invalid close', async () => {
		const app = application();
		app.handler.init = ({ platform }) => {
			app.platform = platform;
			platform.authorizeDelivery((ws, delivery) => {
				// A reason without a code is refused by end() itself.
				if (delivery.event === 'kick') ws.end(undefined, 'revoked');
				return true;
			});
		};
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		await subscribed(reader, 'scan', 1);
		app.platform.publish('scan', 'kick', 1);
		app.platform.publish('scan', 'later', 2);
		await until(() => reader.closeCode !== null);
		expect(reader.closeCode).toBe(1011);
		expect(reader.frames.some((f) => f?.event === 'kick' || f?.event === 'later')).toBe(false);
	});

	it('keeps only the newest coalesced value offered while a dev policy call runs', async () => {
		const app = coalescingApplication();
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		await subscribed(reader, 'scan', 1);
		app.platform.send(app.sockets.get('reader'), 'scan', 'first', 0);
		await until(() => latestOf(reader).includes('latest:2'));
		await new Promise((r) => setTimeout(r, 50));
		expect(latestOf(reader)).toEqual(['first:0', 'latest:2']);
	});

	it('runs the close hook of a socket refused during a dev publish after the publish reached the rest', async () => {
		const app = application();
		app.handler.close = (ws, { platform }) => { platform.publish('scan', 'left', ws.getUserData().id); };
		const dev = await bootDev({ current: app.handler });
		const victim = await client(dev.url, { 'x-id': 'victim' });
		opened.push(victim);
		await subscribed(victim, 'scan', 'victim');
		const readers = [];
		for (const id of ['b', 'c']) {
			const reader = await client(dev.url, { 'x-id': id });
			opened.push(reader);
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

	it('rejects a dev request the policy held and then refused as never sent', async () => {
		const app = application();
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'held-asked' });
		opened.push(reader);
		await subscribed(reader, 'scan', 1);
		const asked = app.platform.request(app.sockets.get('held-asked'), 'ask', 1);
		app.revoked.add('held-asked');
		app.release();
		await expect(asked).rejects.toThrow('the request frame was never sent');
		await until(() => reader.closeCode !== null);
		expect(reader.closeCode).toBe(1013);
	});

	it('reports a failed dev request send to a closing socket when no policy is installed', async () => {
		const app = application();
		app.handler.init = ({ platform }) => { app.platform = platform; };
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		await subscribed(reader, 'scan', 1);
		const ws = app.sockets.get('reader');
		ws.end(1000);
		await expect(app.platform.request(ws, 'ask', 1)).rejects.toThrow(
			adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_CLOSED, REQUEST_CLOSED_DETAIL.SEND_FAILED)
		);
	});

	it('sends the dev resume truncation marker on the control lane, never to the policy', async () => {
		const app = application();
		let opening;
		const opened2 = new Promise((resolve) => { opening = resolve; });
		let finish;
		const finished = new Promise((resolve) => { finish = resolve; });
		app.handler.init = ({ platform }) => {
			app.platform = platform;
			platform.authorizeDelivery((_ws, delivery) => {
				app.handler.contexts.push(delivery);
				// An access list that knows only application events.
				return !(delivery.kind === 'replay' && delivery.event === 'truncated');
			});
		};
		app.handler.resume = async () => { opening(); await finished; };
		const dev = await bootDev({ current: app.handler });
		const reader = await client(dev.url, { 'x-id': 'reader' });
		opened.push(reader);
		reader.send({ type: 'subscribe', topic: 'scan', ref: 1, recover: { offset: 0 } });
		await opened2;
		// More than the resume window holds: the flush must signal truncation.
		for (let i = 0; i < 4100; i++) app.platform.publish('scan', 'missed', i);
		finish();
		await until(() => reader.frames.some((f) => f?.topic === '__replay:scan' && f.event === 'truncated'), 5000);
		await until(() => reader.frames.some((f) => f?.type === 'subscribed' && f.ref === 1), 5000);
		expect(reader.closeCode).toBeNull();
		expect(app.handler.contexts.some((d) => d.event === 'truncated')).toBe(false);
	}, 20000);
});
