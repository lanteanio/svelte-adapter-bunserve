import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { releaseSubscription, trackedSubscribe } from 'svelte-adapter-bunserve/subscriptions';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
const { WS_SUBSCRIPTIONS, wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const { WS_PENDING_SUBSCRIBES, WS_PUBLISH_GRANT, pendingSubscribeTotal } = await import('../../src/runtime/utils/ws-symbols.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');
const prefixes = globalThis[Symbol.for('adapter-uws.derived-topic-prefixes')];
const prefix = '__release-test:';
const topic = 'room';
const baseline = wsCounters.totalSubscriptions;
const opened = [];

function connect() {
	const native = new Set();
	const raw = {
		native, data: upgradeData(), readyState: 1,
		send: () => 1,
		subscribe(t) { native.add(t); return true; },
		unsubscribe: t => native.delete(t),
		isSubscribed: t => native.has(t),
		close() {}, terminate() {}, getBufferedAmount: () => 0, cork: fn => fn()
	};
	websocketHandlers.open(raw);
	opened.push(raw);
	return { raw, ws: wsFacade(raw) };
}

function gates() {
	const pending = [];
	let unsubscribes = 0;
	__setHooks({
		subscribe: () => new Promise(resolve => pending.push(resolve)),
		unsubscribe: () => unsubscribes++
	});
	return { pending, unsubscribes: () => unsubscribes };
}

async function until(ready) {
	for (let i = 0; i < 100 && !ready(); i++) await new Promise(resolve => setImmediate(resolve));
	assert.ok(ready(), 'the subscribe hook opened');
}

afterEach(() => {
	for (const raw of opened.splice(0)) {
		if (raw.readyState === 1) {
			raw.readyState = 3;
			websocketHandlers.close(raw, 1000, '');
		}
	}
	__setHooks({});
	prefixes.delete(prefix);
	assert.equal(wsCounters.totalSubscriptions, baseline);
});

for (const outcome of ['allow', 'deny', 'revoke']) {
	test(`release removes current access while an independent admission later receives ${outcome}`, async () => {
		prefixes.add(prefix);
		const gate = gates();
		const { raw, ws } = connect();
		const first = platform.subscribe(ws, topic);
		const second = platform.subscribe(ws, topic);
		await until(() => gate.pending.length === 2);
		gate.pending[0](null);
		assert.equal(await first, null);
		trackedSubscribe(ws, prefix + topic);
		raw.data[WS_PUBLISH_GRANT] = topic;
		const record = raw.data[WS_PENDING_SUBSCRIBES].get(topic);
		const epoch = record.epoch;
		assert.equal(releaseSubscription(ws, topic), true);
		assert.equal(releaseSubscription(ws, topic), false);
		assert.equal(record.epoch, epoch, 'rollback does not revoke the independent admission');
		assert.equal(record.granted, false, 'the released grant is no longer authority');
		assert.equal(pendingSubscribeTotal(raw.data), 1);
		assert.equal(raw.native.size, 0);
		assert.equal(raw.data[WS_SUBSCRIPTIONS].size, 0);
		assert.equal(raw.data[WS_PUBLISH_GRANT], undefined);
		assert.equal(gate.unsubscribes(), 0, 'rollback does not invoke application cleanup');
		assert.equal(wsCounters.totalSubscriptions, baseline);
		if (outcome === 'revoke') assert.equal(platform.unsubscribe(ws, topic), true);
		gate.pending[1](outcome === 'deny' ? 'FORBIDDEN' : null);
		assert.equal(await second, outcome === 'allow' ? null : 'FORBIDDEN');
		assert.equal(raw.native.has(topic), outcome === 'allow');
		assert.equal(raw.data[WS_SUBSCRIPTIONS].has(topic), outcome === 'allow');
		assert.equal(pendingSubscribeTotal(raw.data), 0);
		assert.equal(wsCounters.totalSubscriptions, baseline + Number(outcome === 'allow'));
	});
}

test('derived admissions remain independent and an earlier revocation stays effective', async () => {
	prefixes.add(prefix);
	const gate = gates();
	const { raw, ws } = connect();
	const first = platform.subscribe(ws, topic);
	const derived = platform.subscribe(ws, prefix + topic);
	await until(() => gate.pending.length === 2);
	gate.pending[0](null);
	assert.equal(await first, null);
	trackedSubscribe(ws, prefix + topic);
	assert.equal(releaseSubscription(ws, topic), true);
	gate.pending[1](null);
	assert.equal(await derived, null);
	assert.deepEqual([...raw.native], [prefix + topic]);
	const pending = platform.subscribe(ws, topic);
	await until(() => gate.pending.length === 3);
	assert.equal(platform.unsubscribe(ws, topic), true);
	releaseSubscription(ws, topic);
	gate.pending[2](null);
	assert.equal(await pending, 'FORBIDDEN');
	assert.equal(raw.native.size, 0);
});

test('a released newer grant cannot authorize an older revoked hook installation', async () => {
	const pending = [];
	let attempts = 0;
	let unwound = 0;
	__setHooks({
		async subscribe(ws, target) {
			const index = attempts++;
			await new Promise(resolve => pending.push(resolve));
			if (index === 0) trackedSubscribe(ws, target);
			return null;
		},
		unsubscribe: () => unwound++
	});
	const { raw, ws } = connect();
	const older = platform.subscribe(ws, topic);
	await until(() => pending.length === 1);
	platform.unsubscribe(ws, topic);
	const current = platform.subscribe(ws, topic);
	await until(() => pending.length === 2);
	pending[1]();
	assert.equal(await current, null);
	assert.equal(releaseSubscription(ws, topic), true);
	const before = unwound;
	pending[0]();
	assert.equal(await older, 'FORBIDDEN');
	assert.equal(unwound, before + 1, 'the revoked hook installation runs its ordinary unwind');
	assert.equal(raw.native.size, 0);
	assert.equal(raw.data[WS_SUBSCRIPTIONS].size, 0);
});

test('missing, settled and closed memberships are harmless', async () => {
	__setHooks({ subscribe: () => null });
	const { raw, ws } = connect();
	assert.equal(releaseSubscription(ws, topic), false);
	assert.equal(await platform.subscribe(ws, topic), null);
	raw.readyState = 3;
	websocketHandlers.close(raw, 1000, '');
	assert.equal(releaseSubscription(ws, topic), false);
	assert.equal(releaseSubscription({ getUserData() { throw Error('closed'); } }, topic), false);
	assert.equal(releaseSubscription({ getUserData: () => ({}) }, topic), false);
});
