import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestServer } from '../../src/testing.js';
import { createSmoothAuthority, createSmoothWireCodec, SmoothDrainError, SMOOTH_TOPIC_PREFIX } from '../../src/plugins/smooth/server.js';
import { createProductionTestServer } from '../helpers/smooth-production-server.mjs';

let server;
let clients;
let nonce = 0;
const WIRE_TOPIC = SMOOTH_TOPIC_PREFIX + 'room';
function thrownValue(kind, message) {
	if (kind === 'undefined') return undefined;
	if (kind === 'null') return null;
	if (kind === 'primitive') return 42;
	if (kind === 'symbol') return Symbol('failure');
	if (kind === 'proxy') return new Proxy({}, { get() { throw new Error('do not inspect cause'); }, getPrototypeOf() { throw new Error('do not inspect cause'); } });
	if (kind === 'revoked') { const pair = Proxy.revocable({}, {}); pair.revoke(); return pair.proxy; }
	return Object.freeze(new Error(message));
}
async function connect() {
	const ws = new WebSocket(server.wsUrl);
	const frames = [];
	ws.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	const client = { ws, frames };
	clients.push(client);
	return client;
}
async function command(client, operation, values = {}) {
	const id = ++nonce;
	client.ws.send(JSON.stringify({ operation, ...values, nonce: id }));
	const end = Date.now() + 2000;
	while (Date.now() < end) {
		const reply = client.frames.find(frame => frame.event === 'reply' && frame.data.nonce === id);
		if (reply) return reply.data;
		await new Promise(resolve => setTimeout(resolve, 2));
	}
	throw new Error('authority did not answer the real socket command');
}
function batch(count, start = 1) {
	return Array.from({ length: count }, (_, index) => ({ id: start + index, cmd: { dx: 1, label: start + index } }));
}
function deliveredBefore(client, reply, from = 0) {
	const end = client.frames.findIndex(frame => frame.event === 'reply' && frame.data.nonce === reply.nonce);
	expect(end).toBeGreaterThanOrEqual(from);
	return client.frames.slice(from, end).filter(frame => frame.topic === 'smooth' || frame.topic === WIRE_TOPIC);
}
const productionChild = process.env.BUNSERVE_SMOOTH_PRODUCTION_CHILD === '1';
if (!productionChild) it('production drain failures preserve committed output over real sockets', () => {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const result = spawnSync(process.execPath, [
		'test', '--conditions=bunserve-test', '--preload', './test/helpers/test-env.mjs',
		'./test/public-native/smooth-drain-budget-real.test.js'
	], {
		cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true,
		env: { ...process.env, BUNSERVE_SMOOTH_PRODUCTION_CHILD: '1' }
	});
	const output = result.stdout + result.stderr;
	expect(result.error, output || result.error?.message).toBeUndefined();
	expect(result.status, output).toBe(0);
	expect(output).toContain('45 pass');
	expect(output).toContain('0 fail');
}, 20000);
const surfaces = productionChild ? [['production', createProductionTestServer]] : [['testing', createTestServer]];
for (const [surface, startServer] of surfaces) describe('smooth authority command budget over actual ' + surface + ' sockets', () => {
	beforeEach(async () => {
		clients = [];
		let authority;
		const failed = new Set();
		let lastThrown;
		let failureMessage;
		let wire = false;
		const codec = createSmoothWireCodec();
		const emitTick = (tick, platform) => {
			if (wire) {
				for (const update of tick.updates) platform.publishWire(WIRE_TOPIC, 'update', { key: update.key, data: update.state }, codec, update.commanded ? { excludeWs: update.ws } : undefined);
				for (const ack of tick.acks) platform.sendWire(ack.ws, WIRE_TOPIC, 'ack', { id: ack.id, state: ack.state }, codec);
				for (const event of tick.events) platform.publishWire(WIRE_TOPIC, 'applied', { key: event.key, data: event.data }, codec, !event.commanded || event.opts?.toAuthor ? undefined : { excludeWs: event.ws });
				return;
			}
			for (const ack of tick.acks) platform.send(ack.ws, 'smooth', 'ack', { key: ack.key, id: ack.id, state: ack.state });
			for (const update of tick.updates) platform.send(update.ws, 'smooth', 'update', { key: update.key, state: update.state });
			for (const event of tick.events) platform.send(event.ws, 'smooth', 'applied', { key: event.key, data: event.data });
		};
		server = await startServer({ handler: {
			async message(ws, { data, platform }) {
				const msg = JSON.parse(Buffer.from(data).toString());
				let result;
				if (msg.operation === 'configure') {
					try {
						wire = msg.wire === true;
						authority = createSmoothAuthority({
							...msg.options,
							apply(state, cmd, ctx) {
								if (cmd.append) authority.enqueue(ctx.key, cmd.append);
								ctx.emitEvent('applied', cmd.label, { toAuthor: cmd.toAuthor });
								if ((cmd.failOnce && !failed.has(cmd.label)) || cmd.failAlways) {
									failed.add(cmd.label);
									failureMessage = 'apply failed once';
									lastThrown = thrownValue(cmd.throwKind, failureMessage);
									throw lastThrown;
								}
								return { x: state.x + cmd.dx, trail: [...state.trail, cmd.label] };
							},
							onMissing: msg.missing ? (state, lastCommand) => {
								if (msg.missing === 'throws' && state.trail.includes('missing-fails')) {
									failureMessage = 'missing failed';
									lastThrown = thrownValue(msg.missingThrowKind, failureMessage);
									throw lastThrown;
								}
								return { x: state.x + 10, trail: [...state.trail, msg.missing === 'lastCommand' ? lastCommand?.label : 'missing'] };
							} : undefined
						});
						result = { configured: true };
					} catch (error) { result = { error: error.message }; }
				} else if (msg.operation === 'join') result = authority.ensure(msg.key, ws, msg.initial || { x: 0, trail: [] }, { active: msg.active });
				else if (msg.operation === 'watch') result = { subscribed: await platform.subscribe(ws, WIRE_TOPIC) };
				else if (msg.operation === 'barrier') result = { barrier: true };
				else if (msg.operation === 'queue') result = { accepted: authority.enqueue(msg.key, msg.commands) };
				else if (msg.operation === 'inject') result = { accepted: authority.inject(msg.key, msg.command) };
				else if (msg.operation === 'tick') {
					let tick;
					try { tick = authority.drain(); }
					catch (error) {
						if (!(error instanceof SmoothDrainError)) throw error;
						emitTick(error.partial, platform);
						platform.send(ws, 'probe', 'reply', {
							error: failureMessage, code: error.code, causeSame: error.cause === lastThrown,
							idle: error.partial.idle, nonce: msg.nonce
						});
						return;
					}
					emitTick(tick, platform);
					result = {
						idle: tick.idle,
						eventKeys: tick.events.map(event => event.key),
						acks: tick.acks.map(({ key, id, state }) => ({ key, id, state })),
						updates: tick.updates.map(({ key, state, commanded }) => ({ key, state, commanded })),
						events: tick.events.map(({ data, commanded }) => ({ data, commanded }))
					};
				}
				platform.send(ws, 'probe', 'reply', { ...result, nonce: msg.nonce });
			}
		} });
	});
	afterEach(async () => {
		for (const client of clients) client.ws.terminate();
		await server?.close();
	});

	it('drains each entity independently in ordered prefixes and acknowledges only applied commands', async () => {
		const first = await connect(), second = await connect();
		await command(first, 'configure', { options: { maxCommandsPerTick: 2 } });
		await command(first, 'join', { key: 'a' });
		await command(second, 'join', { key: 'b' });
		await command(first, 'queue', { key: 'a', commands: batch(5) });
		await command(second, 'queue', { key: 'b', commands: batch(3) });
		const ticks = [];
		for (let i = 0; i < 3; i++) ticks.push(await command(first, 'tick'));
		expect(ticks.map(tick => tick.acks.map(ack => [ack.key, ack.id, ack.state.x]))).toEqual([
			[['a', 2, 2], ['b', 2, 2]], [['a', 4, 4], ['b', 3, 3]], [['a', 5, 5]]
		]);
		expect(ticks.map(tick => tick.events.map(event => event.data))).toEqual([[1, 2, 1, 2], [3, 4, 3], [5]]);
		expect(ticks.every(tick => !tick.idle)).toBe(true);
		expect((await command(first, 'tick')).idle).toBe(true);
		expect(first.frames.filter(frame => frame.event === 'ack').map(frame => frame.data.id)).toEqual([2, 4, 5]);
		expect(second.frames.filter(frame => frame.event === 'ack').map(frame => frame.data.id)).toEqual([2, 3]);
	});

	it('keeps queueCap as the only drop point while newly arrived work follows the retained tail', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 1, queueCap: 3 } });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: batch(3) });
		expect((await command(client, 'tick')).acks[0].id).toBe(1);
		await command(client, 'queue', { key: 'a', commands: batch(2, 4) });
		const applied = [];
		for (let i = 0; i < 3; i++) applied.push((await command(client, 'tick')).acks[0]);
		expect(applied.map(ack => ack.id)).toEqual([3, 4, 5]);
		expect(applied[2].state.trail).toEqual([1, 3, 4, 5]);
	});

	it('waits for the client tail before onMissing while server injections keep their own delivery semantics', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 1 }, missing: true });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: batch(2) });
		await command(client, 'inject', { key: 'a', command: { dx: 100, label: 'hit' } });
		const one = await command(client, 'tick');
		expect(one.acks[0]).toMatchObject({ id: 1, state: { x: 101, trail: [1, 'hit'] } });
		expect(one.updates[0].commanded).toBe(false);
		expect(one.events).toEqual([{ data: 1, commanded: true }, { data: 'hit', commanded: false }]);
		expect((await command(client, 'tick')).acks[0]).toMatchObject({ id: 2, state: { x: 102, trail: [1, 'hit', 2] } });
		const missing = await command(client, 'tick');
		expect(missing.acks).toEqual([]);
		expect(missing.updates[0]).toMatchObject({ commanded: false, state: { x: 112 } });
	});

	it('drops a remaining old-socket tail when an entity is rebound', async () => {
		const first = await connect(), replacement = await connect();
		await command(first, 'configure', { options: { maxCommandsPerTick: 1 } });
		await command(first, 'join', { key: 'a' });
		await command(first, 'queue', { key: 'a', commands: batch(3) });
		await command(first, 'tick');
		const rebound = await command(replacement, 'join', { key: 'a' });
		expect(rebound).toMatchObject({ state: { x: 1 }, lastAckedId: 0 });
		await command(replacement, 'queue', { key: 'a', commands: [{ id: 1, cmd: { dx: 10, label: 'new' } }] });
		expect((await command(replacement, 'tick')).acks[0].state).toEqual({ x: 11, trail: [1, 'new'] });
		expect((await command(replacement, 'tick')).acks).toEqual([]);
	});

	it('preserves default draining of commands enqueued synchronously by apply', async () => {
		const client = await connect();
		await command(client, 'configure', { options: {} });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: [{ id: 1, cmd: { dx: 1, label: 1, append: batch(1, 2) } }] });
		const tick = await command(client, 'tick');
		expect(tick.acks[0]).toMatchObject({ id: 2, state: { x: 2, trail: [1, 2] } });
		expect((await command(client, 'tick')).acks).toEqual([]);
	});

	it('owns the bounded in-flight prefix when apply enqueues enough commands to evict the waiting tail', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 2, queueCap: 3 } });
		await command(client, 'join', { key: 'a' });
		const commands = batch(3);
		commands[0].cmd.append = batch(3, 4);
		await command(client, 'queue', { key: 'a', commands });
		const one = await command(client, 'tick');
		expect(one.acks[0]).toMatchObject({ id: 2, state: { x: 2, trail: [1, 2] } });
		const two = await command(client, 'tick');
		expect(two.acks[0]).toMatchObject({ id: 5, state: { x: 4, trail: [1, 2, 4, 5] } });
		expect((await command(client, 'tick')).acks[0].state.trail).toEqual([1, 2, 4, 5, 6]);
		expect((await command(client, 'tick')).acks).toEqual([]);
	});

	it('restores the whole detached prefix after apply throws before state is committed', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 2 } });
		await command(client, 'join', { key: 'a' });
		const commands = batch(3);
		commands[1].cmd.failOnce = true;
		await command(client, 'queue', { key: 'a', commands });
		expect((await command(client, 'tick')).error).toBe('apply failed once');
		expect(client.frames.filter(frame => frame.event === 'ack')).toEqual([]);
		const retry = await command(client, 'tick');
		expect(retry.acks[0]).toMatchObject({ id: 2, state: { x: 2, trail: [1, 2] } });
		expect((await command(client, 'tick')).acks[0]).toMatchObject({ id: 3, state: { x: 3, trail: [1, 2, 3] } });
	});

	for (const options of [{}, { maxCommandsPerTick: 2 }]) {
		it('commits command metadata only with the full successful prefix: ' + JSON.stringify(options), async () => {
			const client = await connect();
			await command(client, 'configure', { options });
			await command(client, 'join', { key: 'a' });
			await command(client, 'queue', { key: 'a', commands: batch(1) });
			await command(client, 'tick');
			const commands = batch(2, 2); commands[1].cmd.failOnce = true;
			await command(client, 'queue', { key: 'a', commands });
			expect((await command(client, 'tick')).error).toBe('apply failed once');
			expect(await command(client, 'join', { key: 'a' })).toMatchObject({ state: { x: 1, trail: [1] }, lastAckedId: 1 });
			const retried = await command(client, 'tick');
			expect(retried.acks[0]).toMatchObject({ id: 3, state: { x: 3, trail: [1, 2, 3] } });
			expect(retried.events.map(event => event.data)).toEqual([2, 3]);
			expect(retried.eventKeys).toEqual(['2:0', '3:0']);
		});

		it('retains the last committed command for onMissing after a failed prefix: ' + JSON.stringify(options), async () => {
			const client = await connect();
			await command(client, 'configure', { options, missing: 'lastCommand' });
			await command(client, 'join', { key: 'a' });
			await command(client, 'queue', { key: 'a', commands: batch(1) });
			await command(client, 'tick');
			const commands = batch(2, 2); commands[1].cmd.failOnce = true;
			await command(client, 'queue', { key: 'a', commands });
			expect((await command(client, 'tick')).error).toBe('apply failed once');
			const replacement = await connect();
			await command(replacement, 'join', { key: 'a' });
			const missing = await command(replacement, 'tick');
			expect(missing.updates[0].state).toEqual({ x: 11, trail: [1, 1] });
		});

		it('delivers committed owner output before an injected failure and does not replay it: ' + JSON.stringify(options), async () => {
			const client = await connect();
			await command(client, 'configure', { options });
			await command(client, 'join', { key: 'a' });
			await command(client, 'queue', { key: 'a', commands: batch(3) });
			await command(client, 'inject', { key: 'a', command: { dx: 10, label: 'injected', failOnce: true } });
			const failed = await command(client, 'tick');
			expect(failed).toMatchObject({ code: 'SMOOTH_DRAIN_FAILED', causeSame: true, idle: false });
			const count = options.maxCommandsPerTick || 3;
			const committed = deliveredBefore(client, failed);
			expect(committed.map(frame => frame.event)).toEqual(['ack', 'update', ...Array(count).fill('applied')]);
			expect(committed[0].data).toEqual({ key: 'a', id: count, state: { x: count, trail: batch(count).map(c => c.id) } });
			expect(committed.filter(frame => frame.event === 'applied').map(frame => frame.data.data)).toEqual(batch(count).map(c => c.id));
			const from = client.frames.length;
			const retry = await command(client, 'tick');
			expect(retry.updates[0].state).toEqual({ x: 13, trail: [1, 2, 3, 'injected'] });
			expect(retry.acks.map(ack => ack.id)).toEqual(count === 2 ? [3] : []);
			expect(deliveredBefore(client, retry, from).filter(frame => frame.event === 'applied').map(frame => frame.data.data)).toEqual(count === 2 ? [3, 'injected'] : ['injected']);
			expect((await command(client, 'tick')).updates).toEqual([]);
		});
	}

	it.each(['undefined', 'primitive', 'frozen', 'proxy'])('delivers committed output once even when injection keeps throwing %s', async throwKind => {
		const client = await connect();
		await command(client, 'configure', { options: {} });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: batch(2) });
		await command(client, 'inject', { key: 'a', command: { dx: 10, label: 'failure', failAlways: true, throwKind } });
		const first = await command(client, 'tick');
		expect(first).toMatchObject({ code: 'SMOOTH_DRAIN_FAILED', causeSame: true, idle: false });
		expect(deliveredBefore(client, first).map(frame => frame.event)).toEqual(['ack', 'update', 'applied', 'applied']);
		const from = client.frames.length;
		const second = await command(client, 'tick');
		expect(second).toMatchObject({ code: 'SMOOTH_DRAIN_FAILED', causeSame: true, idle: false });
		expect(deliveredBefore(client, second, from)).toEqual([]);
		expect(await command(client, 'join', { key: 'a' })).toMatchObject({ state: { x: 2, trail: [1, 2] }, lastAckedId: 2 });
	});

	it.each(['owner', 'injected', 'missing'])('retains earlier entity outputs when a later %s phase fails', async phase => {
		const client = await connect();
		await command(client, 'configure', { options: {}, missing: phase === 'missing' ? 'throws' : undefined });
		await command(client, 'join', { key: 'first' });
		await command(client, 'join', { key: 'later', initial: { x: 0, trail: ['missing-fails'] }, active: true });
		await command(client, 'queue', { key: 'first', commands: batch(1) });
		if (phase === 'owner') {
			await command(client, 'queue', { key: 'later', commands: [
				{ id: 1, cmd: { dx: 1, label: 'uncommitted' } },
				{ id: 2, cmd: { dx: 1, label: 'failure', failOnce: true } }
			] });
		} else if (phase === 'injected') {
			await command(client, 'inject', { key: 'later', command: { dx: 1, label: 'uncommitted' } });
			await command(client, 'inject', { key: 'later', command: { dx: 1, label: 'failure', failOnce: true } });
		}
		const failed = await command(client, 'tick');
		expect(failed).toMatchObject({ code: 'SMOOTH_DRAIN_FAILED', causeSame: true, idle: false });
		const frames = deliveredBefore(client, failed);
		expect(frames.map(frame => frame.event)).toEqual(['ack', 'update', 'applied']);
		expect(frames[0].data).toMatchObject({ key: 'first', id: 1, state: { x: 1 } });
		expect(frames[1].data).toMatchObject({ key: 'first', state: { x: 1 } });
		expect(frames[2].data).toEqual({ key: '1:0', data: 1 });
		expect(await command(client, 'join', { key: 'later' })).toMatchObject({ state: { x: 0, trail: ['missing-fails'] }, lastAckedId: 0 });
		const from = client.frames.length;
		const next = await command(client, 'tick');
		expect(deliveredBefore(client, next, from).filter(frame => frame.event === 'ack').map(frame => frame.data.key)).toEqual(phase === 'owner' ? ['later'] : []);
		expect(deliveredBefore(client, next, from).filter(frame => frame.event === 'applied').map(frame => frame.data.data)).toEqual(phase === 'missing' ? [] : ['uncommitted', 'failure']);
	});

	for (const phase of ['owner', 'missing']) it.each(['undefined', 'null', 'primitive', 'frozen', 'symbol', 'proxy', 'revoked'])(
		'preserves an opaque cause and committed prefix through repeated ' + phase + ' failures: %s', async throwKind => {
			const client = await connect();
			await command(client, 'configure', { options: { maxCommandsPerTick: 2 }, missing: phase === 'missing' ? 'throws' : undefined, missingThrowKind: throwKind });
			await command(client, 'join', { key: 'first' });
			await command(client, 'join', { key: 'later', initial: { x: 0, trail: ['missing-fails'] }, active: true });
			await command(client, 'queue', { key: 'first', commands: batch(1) });
			if (phase === 'owner') await command(client, 'queue', { key: 'later', commands: [
				{ id: 1, cmd: { dx: 1, label: 'uncommitted' } },
				{ id: 2, cmd: { dx: 1, label: 'failure', failAlways: true, throwKind } }
			] });
			const failed = await command(client, 'tick');
			expect(failed).toMatchObject({ code: 'SMOOTH_DRAIN_FAILED', causeSame: true, idle: false });
			expect(deliveredBefore(client, failed).filter(frame => frame.event === 'ack').map(frame => frame.data.key)).toEqual(['first']);
			expect(deliveredBefore(client, failed).filter(frame => frame.event === 'applied').map(frame => frame.data.data)).toEqual([1]);
			const from = client.frames.length;
			const again = await command(client, 'tick');
			expect(again).toMatchObject({ code: 'SMOOTH_DRAIN_FAILED', causeSame: true });
			expect(deliveredBefore(client, again, from).filter(frame => frame.event === 'ack' || frame.event === 'applied')).toEqual([]);
			expect(await command(client, 'join', { key: 'later' })).toMatchObject({ state: { x: 0, trail: ['missing-fails'] }, lastAckedId: 0 });
		}
	);

	it('delivers committed onMissing motion when the following injection fails', async () => {
		const client = await connect();
		await command(client, 'configure', { options: {}, missing: true });
		await command(client, 'join', { key: 'a', active: true });
		await command(client, 'inject', { key: 'a', command: { dx: 1, label: 'failure', failOnce: true } });
		const failed = await command(client, 'tick');
		expect(deliveredBefore(client, failed).map(frame => [frame.event, frame.data])).toEqual([
			['update', { key: 'a', state: { x: 10, trail: ['missing'] } }]
		]);
		const retry = await command(client, 'tick');
		expect(retry.updates).toEqual([{ key: 'a', state: { x: 21, trail: ['missing', 'missing', 'failure'] }, commanded: false }]);
		expect(retry.acks).toEqual([]);
	});

	it.each(['owner', 'missing'])('routes committed %s output to its author and observer through the public wire API', async phase => {
		const author = await connect(), observer = await connect();
		await command(author, 'configure', { options: {}, wire: true, missing: phase === 'missing' });
		await command(author, 'watch');
		await command(observer, 'watch');
		await command(author, 'join', { key: 'a', active: phase === 'missing' });
		if (phase === 'owner') {
			const commands = batch(2);
			commands[1].cmd.toAuthor = true;
			await command(author, 'queue', { key: 'a', commands });
		}
		await command(author, 'inject', { key: 'a', command: { dx: 1, label: 'injected', failOnce: true } });
		const failed = await command(author, 'tick');
		const observed = await command(observer, 'barrier');
		const ownFrames = deliveredBefore(author, failed), otherFrames = deliveredBefore(observer, observed);
		expect(ownFrames.map(frame => frame.event)).toEqual(phase === 'owner' ? ['ack', 'applied'] : ['update']);
		expect(otherFrames.map(frame => frame.event)).toEqual(phase === 'owner' ? ['update', 'applied', 'applied'] : ['update']);
		if (phase === 'owner') {
			expect(ownFrames[0].data).toEqual({ id: 2, state: { x: 2, trail: [1, 2] } });
			expect(ownFrames[1].data.data).toBe(2);
		} else expect(ownFrames[0].data).toEqual({ key: 'a', data: { x: 10, trail: ['missing'] } });
		expect(otherFrames[0].data.data.x).toBe(phase === 'owner' ? 2 : 10);
		const authorFrom = author.frames.length, observerFrom = observer.frames.length;
		const retry = await command(author, 'tick');
		const observedRetry = await command(observer, 'barrier');
		for (const frames of [deliveredBefore(author, retry, authorFrom), deliveredBefore(observer, observedRetry, observerFrom)]) {
			expect(frames.map(frame => frame.event)).toEqual(['update', 'applied']);
			expect(frames[0].data.data.x).toBe(phase === 'owner' ? 3 : 21);
			expect(frames[1].data.data).toBe('injected');
		}
	});

	it('discards scratch events when an injected command throws before its state commits', async () => {
		const client = await connect();
		await command(client, 'configure', { options: {} });
		await command(client, 'join', { key: 'a' });
		await command(client, 'inject', { key: 'a', command: { dx: 10, label: 'one' } });
		await command(client, 'inject', { key: 'a', command: { dx: 20, label: 'two', failOnce: true } });
		expect((await command(client, 'tick')).error).toBe('apply failed once');
		expect(await command(client, 'join', { key: 'a' })).toMatchObject({ state: { x: 0, trail: [] }, lastAckedId: 0 });
		const retried = await command(client, 'tick');
		expect(retried.acks).toEqual([]);
		expect(retried.updates[0]).toMatchObject({ state: { x: 30, trail: ['one', 'two'] }, commanded: false });
		expect(retried.events).toEqual([{ data: 'one', commanded: false }, { data: 'two', commanded: false }]);
		expect(retried.eventKeys).toEqual(['-1:0', '-2:0']);
	});

	it('keeps queueCap as the drop point when a failing callback also appends commands', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 2, queueCap: 3 } });
		await command(client, 'join', { key: 'a' });
		const commands = batch(3);
		commands[1].cmd = { dx: 1, label: 2, failOnce: true, append: batch(3, 4) };
		await command(client, 'queue', { key: 'a', commands });
		expect((await command(client, 'tick')).error).toBe('apply failed once');
		expect((await command(client, 'tick')).acks[0].state.trail).toEqual([4, 5]);
		expect((await command(client, 'tick')).acks[0].state.trail).toEqual([4, 5, 6]);
		expect((await command(client, 'tick')).acks).toEqual([]);
	});

	it('preserves the default full drain', async () => {
		const client = await connect();
		await command(client, 'configure', { options: {} });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: batch(32) });
		const tick = await command(client, 'tick');
		expect(tick.acks[0]).toMatchObject({ id: 32, state: { x: 32 } });
		expect(tick.events).toHaveLength(32);
	});

	it.each([0, -1, 1.5, null, '2'])('refuses an invalid configured budget %s', async maxCommandsPerTick => {
		const client = await connect();
		expect((await command(client, 'configure', { options: { maxCommandsPerTick } })).error).toMatch(/maxCommandsPerTick/);
	});
});
