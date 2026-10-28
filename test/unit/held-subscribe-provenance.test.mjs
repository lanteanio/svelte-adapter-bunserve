import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// The held-at-landing provenance read, driven through the real message
// handler and platform.
//
// A revocation (platform.unsubscribe) cancels an in-flight subscribe and
// removes the membership, so a topic HELD when a revoked attempt lands was
// installed during the await window - either by a fresh attempt whose
// authorization completed (current authority; the revoked frame may ack) or
// by the revoked attempt's OWN hook (a plugin join; the cancellation exists to
// defeat exactly that, so it is unwound). A plugin join is a hook that calls
// trackedSubscribe and keeps a roster the app's unsubscribe hook empties.
//
// A revoked attempt is answered FORBIDDEN, as on svelte-adapter-uws.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
const { MAX_SUBSCRIPTIONS_PER_CONNECTION, WS_SUBSCRIPTIONS, subscribeAuth, wsCounters } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const {
	addLogicalSubscription,
	beginPendingSubscribe,
	settleHeldSubscribe,
	settlePendingSubscribe,
	tombstonePendingSubscribe,
	trackedSubscribe,
	trackedUnsubscribe
} = await import('../../src/runtime/utils/ws-symbols.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

const TOPIC = 'lobby';

/** @type {any[]} */
let opened = [];
let baseline = 0;

beforeEach(() => {
	baseline = wsCounters.totalSubscriptions;
});

afterEach(() => {
	for (const raw of opened) {
		if (raw.readyState === 1) {
			raw.readyState = 3;
			websocketHandlers.close(raw, 1000, '');
		}
	}
	opened = [];
	__setHooks({});
	assert.equal(wsCounters.totalSubscriptions, baseline, 'every case leaves the total where it found it');
});

/** Open one connection through the real handler, recording what it is sent. */
function connect() {
	const native = new Set();
	/** @type {any[]} */
	const sent = [];
	const raw = {
		native,
		sent,
		data: upgradeData(),
		readyState: 1,
		send: (/** @type {string} */ payload) => { sent.push(JSON.parse(payload)); return payload.length; },
		subscribe: (/** @type {string} */ t) => { native.add(t); return true; },
		unsubscribe: (/** @type {string} */ t) => native.delete(t),
		isSubscribed: (/** @type {string} */ t) => native.has(t),
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (/** @type {() => unknown} */ fn) => fn()
	};
	websocketHandlers.open(raw);
	opened.push(raw);
	return { raw, ws: wsFacade(raw) };
}

/** Send one control frame; the returned promise settles when its lane does. */
function send(/** @type {any} */ raw, /** @type {object} */ frame) {
	return websocketHandlers.message(raw, JSON.stringify(frame));
}

/** Wait, one loop turn at a time, until `ready` holds. */
async function until(/** @type {() => boolean} */ ready) {
	for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setImmediate(r));
	assert.ok(ready(), 'the awaited condition never held');
}

/** The answer a ref received. */
function answerFor(/** @type {any} */ raw, /** @type {number} */ ref) {
	return raw.sent.find((/** @type {any} */ f) => f.ref === ref);
}

/** A roster of joined topics the plugin join fills and the app's unsubscribe hook empties. */
function roster() {
	const members = new Set();
	return {
		members,
		join(/** @type {any} */ ws, /** @type {string} */ topic) {
			trackedSubscribe(ws, topic);
			members.add(topic);
		},
		unsubscribe(/** @type {any} */ _ws, /** @type {string} */ topic) { members.delete(topic); }
	};
}

/** Parked hook calls, released by index. */
function parker() {
	/** @type {Array<(value?: unknown) => void>} */
	const releases = [];
	return {
		releases,
		park: () => new Promise((resolve) => { releases.push(resolve); })
	};
}

test('a membership the revoked attempt installed itself is denied and unwound', async () => {
	const group = roster();
	const gate = parker();
	__setHooks({
		async subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			await gate.park();
			group.join(ws, topic);
			return null;
		},
		unsubscribe: group.unsubscribe
	});
	const { raw, ws } = connect();
	const landed = send(raw, { type: 'subscribe', topic: TOPIC, ref: 1 });
	await until(() => gate.releases.length === 1);

	platform.unsubscribe(ws, TOPIC);
	gate.releases[0]();
	await landed;

	assert.deepEqual(answerFor(raw, 1), { type: 'subscribe-denied', topic: TOPIC, ref: 1, reason: 'FORBIDDEN' });
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), false, 'no membership may survive the revocation');
	assert.equal(raw.native.has(TOPIC), false, 'native membership with it');
	assert.equal(group.members.size, 0, 'the unwind ran the app unsubscribe hook');
	assert.equal(wsCounters.totalSubscriptions, baseline, 'and charged the release once');
});

test('the revoked frame acks when a platform.subscribe re-grant landed first', async () => {
	// A revoke followed by a re-grant inside one window is current authority:
	// the re-grant marks the topic granted, and the revoked landing reads it.
	const group = roster();
	const gate = parker();
	let park = true;
	__setHooks({
		async subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			if (park) await gate.park();
			group.join(ws, topic);
			return null;
		},
		unsubscribe: group.unsubscribe
	});
	const { raw, ws } = connect();
	const landed = send(raw, { type: 'subscribe', topic: TOPIC, ref: 1 });
	await until(() => gate.releases.length === 1);

	platform.unsubscribe(ws, TOPIC);
	park = false;
	assert.equal(await platform.subscribe(ws, TOPIC), null, 'the re-grant succeeds');

	gate.releases[0]();
	await landed;
	assert.deepEqual(answerFor(raw, 1), { type: 'subscribed', topic: TOPIC, ref: 1, epoch: answerFor(raw, 1).epoch });
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true);
	assert.equal(group.members.size, 1);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

test('the revoked frame acks when the client re-subscribed and landed first', async () => {
	const group = roster();
	const gate = parker();
	let park = true;
	__setHooks({
		async subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			if (park) await gate.park();
			group.join(ws, topic);
			return null;
		},
		unsubscribe: group.unsubscribe
	});
	const { raw, ws } = connect();
	const first = send(raw, { type: 'subscribe', topic: TOPIC, ref: 1 });
	await until(() => gate.releases.length === 1);
	platform.unsubscribe(ws, TOPIC);

	park = false;
	await send(raw, { type: 'subscribe', topic: TOPIC, ref: 2 });
	assert.equal(answerFor(raw, 2).type, 'subscribed', 'the fresh attempt is acked');

	gate.releases[0]();
	await first;
	assert.equal(answerFor(raw, 1).type, 'subscribed', 'the fresh ack is current authority for the revoked frame too');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

test('the revoked frame is denied without an unwind while the fresh attempt is still in flight', async () => {
	const group = roster();
	const gate = parker();
	__setHooks({
		async subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			await gate.park();
			group.join(ws, topic);
			return null;
		},
		unsubscribe: group.unsubscribe
	});
	const { raw, ws } = connect();
	const first = send(raw, { type: 'subscribe', topic: TOPIC, ref: 1 });
	await until(() => gate.releases.length === 1);
	platform.unsubscribe(ws, TOPIC);
	const second = send(raw, { type: 'subscribe', topic: TOPIC, ref: 2 });
	await until(() => gate.releases.length === 2);

	// The revoked attempt lands first: its own hook installed the membership,
	// but the fresh attempt is still in flight to judge it.
	gate.releases[0]();
	await first;
	assert.equal(answerFor(raw, 1).reason, 'FORBIDDEN');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true, 'left for the fresh landing to judge');

	gate.releases[1]();
	await second;
	assert.equal(answerFor(raw, 2).type, 'subscribed');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true);
	assert.equal(group.members.size, 1);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

test('the deferral is not a leak: a fresh attempt that denies unwinds it', async () => {
	// The revoked landing defers to the fresh attempt, and the fresh attempt
	// leaves through its denial exit - so that exit is the last settler and
	// owns the unwind. Settled blindly, the socket kept the membership and the
	// roster entry with both frames refused.
	const group = roster();
	const gate = parker();
	let calls = 0;
	__setHooks({
		async subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			const mine = ++calls;
			await gate.park();
			if (mine === 1) {
				group.join(ws, topic);
				return null;
			}
			return 'FORBIDDEN';
		},
		unsubscribe: group.unsubscribe
	});
	const { raw, ws } = connect();
	const first = send(raw, { type: 'subscribe', topic: TOPIC, ref: 1 });
	await until(() => gate.releases.length === 1);
	platform.unsubscribe(ws, TOPIC);
	const second = send(raw, { type: 'subscribe', topic: TOPIC, ref: 2 });
	await until(() => gate.releases.length === 2);

	gate.releases[0]();
	await first;
	assert.equal(answerFor(raw, 1).reason, 'FORBIDDEN');

	gate.releases[1]();
	await second;
	assert.equal(answerFor(raw, 2).reason, 'FORBIDDEN', 'the denying attempt is answered with its own reason');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), false, 'unwound once no attempt was left to judge it');
	assert.equal(raw.native.has(TOPIC), false);
	assert.equal(group.members.size, 0);
	assert.equal(wsCounters.totalSubscriptions, baseline);
});

test('platform.subscribe: a hook that installs membership and then refuses has it unwound', async () => {
	const group = roster();
	__setHooks({
		subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			group.join(ws, topic);
			return 'FORBIDDEN';
		},
		unsubscribe: group.unsubscribe
	});
	const { raw, ws } = connect();
	assert.equal(await platform.subscribe(ws, TOPIC), 'FORBIDDEN');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), false, 'the refusing hook\'s membership does not stand');
	assert.equal(group.members.size, 0, 'and the app unsubscribe hook ran');
	assert.equal(wsCounters.totalSubscriptions, baseline);
});

test('a denied gap-fill of a held topic answers the frame and keeps the membership', async () => {
	// Held before the attempt enrolled, so the entry is seeded with that
	// authority: the denial answers the frame and evicts nothing nobody revoked.
	let unsubscribeRuns = 0;
	let deny = false;
	__setHooks({
		subscribe: () => (deny ? 'FORBIDDEN' : null),
		resume: () => undefined,
		unsubscribe() { unsubscribeRuns++; }
	});
	const { raw, ws } = connect();
	assert.equal(await platform.subscribe(ws, TOPIC), null);
	deny = true;
	await send(raw, { type: 'subscribe', topic: TOPIC, ref: 1, recover: { offset: 3 } });
	assert.equal(answerFor(raw, 1).reason, 'FORBIDDEN');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true, 'the standing membership survives');
	assert.equal(unsubscribeRuns, 0, 'no unsubscribe hook for a membership nobody revoked');
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

test('batch: a membership the revoked batch hook installed is denied and unwound', async () => {
	const group = roster();
	const gate = parker();
	__setHooks({
		async subscribeBatch(/** @type {any} */ ws, /** @type {string[]} */ topics) {
			await gate.park();
			for (const topic of topics) group.join(ws, topic);
			return {};
		},
		unsubscribe: group.unsubscribe
	});
	const { raw, ws } = connect();
	const landed = send(raw, { type: 'subscribe-batch', topics: [TOPIC, 'other'], ref: 1 });
	await until(() => gate.releases.length === 1);

	platform.unsubscribe(ws, TOPIC);
	gate.releases[0]();
	await landed;

	const answers = raw.sent.filter((/** @type {any} */ f) => f.ref === 1);
	assert.deepEqual(
		answers.map((/** @type {any} */ f) => [f.topic, f.type, f.reason]),
		[[TOPIC, 'subscribe-denied', 'FORBIDDEN'], ['other', 'subscribed', undefined]]
	);
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), false, 'the revoked entry\'s membership is unwound');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has('other'), true, 'its neighbour stands');
	assert.deepEqual([...group.members], ['other'], 'the roster lost the revoked join only');
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

test('batch: a refusal from the batch hook unwinds what that hook installed', async () => {
	const group = roster();
	__setHooks({
		subscribeBatch(/** @type {any} */ ws, /** @type {string[]} */ topics) {
			for (const topic of topics) group.join(ws, topic);
			return { [TOPIC]: 'FORBIDDEN' };
		},
		unsubscribe: group.unsubscribe
	});
	const { raw } = connect();
	await send(raw, { type: 'subscribe-batch', topics: [TOPIC], ref: 1 });
	assert.equal(answerFor(raw, 1).reason, 'FORBIDDEN');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), false);
	assert.equal(group.members.size, 0);
	assert.equal(wsCounters.totalSubscriptions, baseline);
});

test('batch: revocation cancels ordered landing after concurrent authorization', async () => {
	// Both hooks start before landing. A revocation while the first hook is
	// parked still cancels the second entry's in-flight stamp.
	const gate = parker();
	/** @type {string[]} */
	const asked = [];
	__setHooks({
		async subscribe(/** @type {any} */ _ws, /** @type {string} */ topic) {
			asked.push(topic);
			if (topic === 'first') await gate.park();
			return null;
		}
	});
	const { raw, ws } = connect();
	const landed = send(raw, { type: 'subscribe-batch', topics: ['first', 'second'], ref: 1 });
	await until(() => gate.releases.length === 1);
	platform.unsubscribe(ws, 'second');
	gate.releases[0]();
	await landed;

	assert.deepEqual(asked, ['first', 'second'], 'both hooks ran before ordered landing');
	const answers = raw.sent.filter((/** @type {any} */ f) => f.ref === 1);
	assert.deepEqual(
		answers.map((/** @type {any} */ f) => [f.topic, f.type, f.reason]),
		[['first', 'subscribed', undefined], ['second', 'subscribe-denied', 'FORBIDDEN']]
	);
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has('second'), false);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

// - a held topic whose membership a revoked attempt may have installed --------

/**
 * A hook whose first call parks, installs the membership itself (the plugin
 * join), and parks again before allowing; every later call allows at once.
 * The second park is the window in which a held topic is a revoked attempt's
 * own install still waiting on that attempt's landing.
 */
function twoPhaseJoin(/** @type {ReturnType<typeof roster>} */ group) {
	const phase = parker();
	let calls = 0;
	return {
		phase,
		calls: () => calls,
		async subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			if (++calls === 1) {
				await phase.park();
				group.join(ws, topic);
				await phase.park();
			}
			return null;
		}
	};
}

/**
 * Send one subscribe, revoke it while parked, and let its hook install. The
 * landing comes back wrapped: returned bare from an async function it would be
 * adopted, and awaiting this would wait on the landing it is meant to hold.
 */
async function revokedInstall(/** @type {any} */ hook, /** @type {any} */ raw, /** @type {any} */ ws, /** @type {object} */ frame) {
	const landed = send(raw, frame);
	await until(() => hook.phase.releases.length === 1);
	platform.unsubscribe(ws, TOPIC);
	hook.phase.releases[0]();
	await until(() => hook.phase.releases.length === 2);
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true, 'the revoked attempt installed it');
	return { landed };
}

test('a re-subscribe while a revoked attempt holds its own install is judged, not acked on sight', async () => {
	// Acked on sight, the re-subscribe was told it held a membership the
	// revoked attempt's landing then unwound. Judged, its allow is fresh
	// authority, and the revoked landing reads it.
	const group = roster();
	const hook = twoPhaseJoin(group);
	__setHooks({ subscribe: hook.subscribe, unsubscribe: group.unsubscribe });
	const { raw, ws } = connect();
	const { landed: first } = await revokedInstall(hook, raw, ws, { type: 'subscribe', topic: TOPIC, ref: 1 });

	await send(raw, { type: 'subscribe', topic: TOPIC, ref: 2 });
	assert.equal(hook.calls(), 2, 'the re-subscribe ran the hook');
	assert.equal(answerFor(raw, 2).type, 'subscribed');
	hook.phase.releases[1]();
	await first;
	assert.equal(answerFor(raw, 1).type, 'subscribed', 'the fresh allow is authority for the revoked frame too');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true, 'nothing unwound what ref 2 was told it holds');
	assert.equal(group.members.size, 1);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

test('a platform.subscribe re-grant over a revoked attempt\'s own install is authority for it', async () => {
	const group = roster();
	const hook = twoPhaseJoin(group);
	__setHooks({ subscribe: hook.subscribe, unsubscribe: group.unsubscribe });
	const { raw, ws } = connect();
	const { landed: first } = await revokedInstall(hook, raw, ws, { type: 'subscribe', topic: TOPIC, ref: 1 });

	assert.equal(await platform.subscribe(ws, TOPIC), null);
	assert.equal(hook.calls(), 2, 'the re-grant went through the gate');
	hook.phase.releases[1]();
	await first;
	assert.equal(answerFor(raw, 1).type, 'subscribed');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

test('under the grant gate, a revoked attempt\'s own install is not a grant a re-subscribe can claim', async () => {
	// The gate's only evidence is membership, and this membership is the
	// install the revocation was meant to defeat: read as a grant, a client
	// re-sending its subscribe would keep the topic it was revoked from.
	const { raw, ws } = connect();
	subscribeAuth.enabled = true;
	try {
		// A revoked attempt still in flight, whose own hook installed the topic.
		const revoked = beginPendingSubscribe(raw.data, TOPIC);
		tombstonePendingSubscribe(raw.data, TOPIC);
		addLogicalSubscription(raw.data[WS_SUBSCRIPTIONS], TOPIC);
		await send(raw, { type: 'subscribe', topic: TOPIC, ref: 1 });
		assert.equal(answerFor(raw, 1).reason, 'FORBIDDEN');
		assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true, 'left for the revoked attempt to judge');
		assert.equal(settleHeldSubscribe(raw.data, TOPIC, revoked), 'deny-unwind', 'and nothing granted it meanwhile');
		trackedUnsubscribe(ws, TOPIC);

		// The control: a grant with nothing revoked in flight is still acked.
		addLogicalSubscription(raw.data[WS_SUBSCRIPTIONS], 'granted');
		await send(raw, { type: 'subscribe', topic: 'granted', ref: 2 });
		assert.equal(answerFor(raw, 2).type, 'subscribed');
		trackedUnsubscribe(ws, 'granted');
	} finally {
		subscribeAuth.enabled = false;
	}
});

test('a revoked recover subscribe whose own hook installed the topic is served no history', async () => {
	// Membership first would read the install as held and serve the replay,
	// and only the landing would then refuse it.
	const group = roster();
	const gate = parker();
	let replays = 0;
	__setHooks({
		async subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			await gate.park();
			group.join(ws, topic);
			return null;
		},
		resume() { replays++; },
		unsubscribe: group.unsubscribe
	});
	const { raw, ws } = connect();
	const landed = send(raw, { type: 'subscribe', topic: TOPIC, ref: 1, recover: { offset: 3 } });
	await until(() => gate.releases.length === 1);
	platform.unsubscribe(ws, TOPIC);
	gate.releases[0]();
	await landed;
	assert.equal(replays, 0, 'the resume hook never ran');
	assert.equal(answerFor(raw, 1).reason, 'FORBIDDEN');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), false);
	assert.equal(group.members.size, 0);
});

test('batch: an entry acquired while the frame waited still consults its hook', async () => {
	// Every wire request is authorized even if another request already landed.
	const gate = parker();
	/** @type {string[]} */
	const asked = [];
	__setHooks({
		async subscribe(/** @type {any} */ _ws, /** @type {string} */ topic) {
			asked.push(topic);
			if (topic === 'y') await gate.park();
			return null;
		}
	});
	const { raw } = connect();
	const frame = send(raw, { type: 'subscribe-batch', topics: ['y', 'x'], ref: 1 });
	await until(() => gate.releases.length === 1);
	await send(raw, { type: 'subscribe', topic: 'x', ref: 2 });
	assert.equal(answerFor(raw, 2).type, 'subscribed');
	gate.releases[0]();
	await frame;
	assert.deepEqual(asked, ['y', 'x', 'x'], 'both requests for x consult the hook');
	const answers = raw.sent.filter((/** @type {any} */ f) => f.ref === 1).map((/** @type {any} */ f) => [f.topic, f.type]);
	assert.deepEqual(answers, [['y', 'subscribed'], ['x', 'subscribed']]);
	assert.equal(wsCounters.totalSubscriptions, baseline + 2);
});

// - a membership no attempt has confirmed, without a revocation ---------------

test('batch: a duplicate entry does not ack what its twin\'s refusing hook installed', async () => {
	// One frame, the same topic twice. The first entry's hook installs and then
	// refuses; the second must judge the topic too rather than ack the install.
	const group = roster();
	let calls = 0;
	__setHooks({
		subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			calls++;
			group.join(ws, topic);
			return 'FORBIDDEN';
		},
		unsubscribe: group.unsubscribe
	});
	const { raw } = connect();
	await send(raw, { type: 'subscribe-batch', topics: [TOPIC, TOPIC], ref: 1 });
	assert.equal(calls, 2, 'each entry ran the hook');
	const answers = raw.sent.filter((/** @type {any} */ f) => f.ref === 1).map((/** @type {any} */ f) => f.reason);
	assert.deepEqual(answers, ['FORBIDDEN', 'FORBIDDEN']);
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), false, 'the refused install was unwound');
	assert.equal(group.members.size, 0);
	assert.equal(wsCounters.totalSubscriptions, baseline);
});

test('a re-subscribe while a live attempt holds its own install is judged, so a later refusal cannot strand it', async () => {
	// No revocation at all: the first attempt's hook installs, waits, and then
	// refuses. Acked on sight, the re-subscribe was told it held a membership
	// the first attempt's refusal then removed.
	const group = roster();
	const gate = parker();
	let calls = 0;
	__setHooks({
		async subscribe(/** @type {any} */ ws, /** @type {string} */ topic) {
			if (++calls === 1) {
				group.join(ws, topic);
				await gate.park();
				return 'FORBIDDEN';
			}
			return null;
		},
		unsubscribe: group.unsubscribe
	});
	const { raw } = connect();
	const first = send(raw, { type: 'subscribe', topic: TOPIC, ref: 1 });
	await until(() => gate.releases.length === 1);
	await send(raw, { type: 'subscribe', topic: TOPIC, ref: 2 });
	assert.equal(calls, 2, 'the re-subscribe ran the hook');
	assert.equal(answerFor(raw, 2).type, 'subscribed');
	gate.releases[0]();
	await first;
	assert.equal(answerFor(raw, 1).reason, 'FORBIDDEN');
	assert.equal(raw.data[WS_SUBSCRIPTIONS].has(TOPIC), true, 'the allowed re-subscribe is authority; nothing unwound it');
	assert.equal(group.members.size, 1);
	assert.equal(wsCounters.totalSubscriptions, baseline + 1);
});

test('batch: a topic held only by an unconfirmed install is admitted at the cap and judged', async () => {
	// It grows nothing, so it spends neither bound - as on the single lane,
	// which exempts a held topic from the cap.
	__setHooks({ subscribe: () => null });
	const { raw } = connect();
	const subs = raw.data[WS_SUBSCRIPTIONS];
	for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION - 1; i++) subs.add('filler:' + i);
	addLogicalSubscription(subs, TOPIC);
	const waiting = beginPendingSubscribe(raw.data, TOPIC);
	try {
		await send(raw, { type: 'subscribe-batch', topics: [TOPIC], ref: 1 });
		assert.equal(answerFor(raw, 1).type, 'subscribed', 'not refused RATE_LIMITED for a topic it holds');
	} finally {
		settlePendingSubscribe(raw.data, TOPIC, waiting);
		for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION - 1; i++) subs.delete('filler:' + i);
	}
});
