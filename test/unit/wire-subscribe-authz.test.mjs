import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same bootstrap as subscribe-gate.test.mjs: the handler modules read values the
// build freezes into the bundle, and the loader resolves the build-resolved
// #ws-handler specifier to a stub, which is what makes the gate reachable
// without a build, a server or a socket.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';


const { platform, subscribeWithVerdict, wireGrantGateDecides } = await import(
	'../../src/runtime/handler/platform.js'
);
const { WS_SUBSCRIPTIONS, subscribeAuth, tombstonePendingSubscribe } = await import(
	'../../src/runtime/handler/ws-state.js'
);
const { normalizeWsOptions } = await import('../../src/runtime/utils/ws-options.js');
const {
	deniesRefLessRecover,
	deniesUngrantedObserve,
	deniesWireSubscribeLanding,
	deniesWireSubscribePreHook,
	recoverIsRevoked,
	recoverRequiresRefFrame
} = await import('../../src/runtime/utils/subscribe-policy.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

/** A stand-in for the socket facade, recording what it was asked to install. */
function fakeWs() {
	const installed = [];
	const ud = { [WS_SUBSCRIPTIONS]: new Set() };
	return {
		installed,
		getUserData: () => ud,
		subscribe: (topic) => {
			installed.push(topic);
		}
	};
}

/**
 * Run one test with a posture and an app gate, and put both back afterwards.
 *
 * The arming latches by design - nothing in the runtime lowers it - so the
 * reset is written here rather than asked of the runtime.
 */
async function withPosture({ enabled = false, strict = false, hooks = {} }, fn) {
	subscribeAuth.enabled = enabled;
	subscribeAuth.strict = strict;
	__setHooks(hooks);
	try {
		return await fn();
	} finally {
		__setHooks({});
		subscribeAuth.enabled = false;
		subscribeAuth.strict = false;
	}
}

/** A client-initiated subscribe, which is the lane the gate judges. */
function wireSubscribe(ws, topic, options) {
	return subscribeWithVerdict(ws, topic, options, undefined, { fromWire: true });
}

test('the predicates decide the four postures', () => {
	// Pure functions of named inputs, so the lanes cannot disagree about one
	// topic by spelling the same question differently.
	const t = 'room:1';
	assert.equal(deniesWireSubscribePreHook({ armed: false, hasUserHook: false, held: false, topic: t }), false,
		'unarmed denies nothing before the hook');
	assert.equal(deniesWireSubscribePreHook({ armed: true, hasUserHook: true, held: false, topic: t }), false,
		'an app hook decides the topic itself');
	assert.equal(deniesWireSubscribePreHook({ armed: true, hasUserHook: false, held: true, topic: t }), false,
		'a topic the server already granted passes');
	assert.equal(deniesWireSubscribePreHook({ armed: true, hasUserHook: false, held: false, topic: t }), true,
		'and an ungranted one does not');

	assert.equal(deniesWireSubscribeLanding({ armed: true, hasUserHook: false, held: false, topic: t }), true,
		'the landing asks again against the set as it stands now');
	assert.equal(deniesWireSubscribeLanding({ armed: true, hasUserHook: false, held: true, topic: t }), false);

	assert.equal(recoverIsRevoked({ held: true, wireAuthz: true, cancelled: true, topic: t }), false,
		'membership first: a re-grant inside one window is visible, so history is served');
	assert.equal(recoverIsRevoked({ held: false, wireAuthz: false, cancelled: true, topic: t }), true,
		'a cancelled subscribe gets no replay');
	assert.equal(recoverIsRevoked({ held: false, wireAuthz: false, cancelled: false, topic: t }), false);

	assert.equal(deniesUngrantedObserve(true, false, new Set([t]), t), false);
	assert.equal(deniesUngrantedObserve(true, false, new Set(), t), true);
	assert.equal(deniesUngrantedObserve(true, true, new Set(), t), false, 'an app hook decides');
	assert.equal(deniesUngrantedObserve(false, false, new Set(), t), false, 'unarmed falls through');
	assert.equal(deniesUngrantedObserve(true, false, undefined, t), true, 'no set at all fails closed');
});

test('armed with no app hook, only what the server granted is subscribable', async () => {
	await withPosture({ enabled: true }, async () => {
		const ws = fakeWs();
		// The client naming a topic nobody granted is the case the gate exists
		// for: with no hook there is nothing else to consult.
		assert.equal(await wireSubscribe(ws, 'room:private'), 'FORBIDDEN');
		assert.deepEqual(ws.installed, []);

		// The server's own subscribe IS the grant, so it is not judged against
		// one. Without this an armed worker could authorize nothing at all.
		assert.equal(await platform.subscribe(ws, 'room:granted'), null);
		assert.deepEqual(ws.installed, ['room:granted']);

		// And now the client may (re)subscribe it.
		assert.equal(await wireSubscribe(ws, 'room:granted'), null);
	});
});

test('unarmed without a hook allows public topics', async () => {
	// The gate is opt-in. An app that never armed anything and exports no hook
	// still meets the refusal it always met, rather than the grant model.
	await withPosture({ enabled: false }, async () => {
		const ws = fakeWs();
		assert.equal(await wireSubscribe(ws, 'room:1'), null);
	});
});

test('armed with an app hook, the hook decides and the gate stands aside', async () => {
	const seen = [];
	await withPosture({
		enabled: true,
		hooks: { subscribe: (_ws, topic) => { seen.push(topic); return topic === 'ok' ? null : 'FORBIDDEN'; } }
	}, async () => {
		const ws = fakeWs();
		assert.equal(await wireSubscribe(ws, 'ok'), null, 'no grant needed: the app took the decision');
		assert.equal(await wireSubscribe(ws, 'no'), 'FORBIDDEN', 'and its refusal still stands');
		assert.deepEqual(seen, ['ok', 'no'], 'the hook ran for both');
	});
});

test('strict requires the grant even when an app hook allows', async () => {
	let ran = 0;
	await withPosture({
		enabled: true,
		strict: true,
		hooks: { subscribe: () => { ran++; return null; } }
	}, async () => {
		const ws = fakeWs();
		// Conjunctive: a permissive hook cannot stand in for a server grant, so
		// the frame is refused before the hook is even consulted.
		assert.equal(await wireSubscribe(ws, 'room:ungranted'), 'FORBIDDEN');
		assert.equal(ran, 0, 'refused ahead of the hook');

		await platform.subscribe(ws, 'room:granted');
		assert.equal(ran, 1, 'the server grant runs the hook, which is the second authority');
		assert.equal(await wireSubscribe(ws, 'room:granted'), null);
	});
});

test('a subscribe that entered unarmed lands under the posture in force now', async () => {
	// The arming latches false -> true at runtime, so a frame parked in an app
	// hook while the gate was armed underneath it must not land under the
	// posture it started in. Both ends read the flag fresh for this reason.
	await withPosture({
		enabled: true,
		hooks: {
			subscribe: async () => {
				subscribeAuth.strict = true;
				return null;
			}
		}
	}, async () => {
		const ws = fakeWs();
		assert.equal(await wireSubscribe(ws, 'room:1'), 'FORBIDDEN');
		assert.deepEqual(ws.installed, [], 'and nothing installed');
	});
});

test('a cancelled subscribe is served no replay history', async () => {
	// The gap-fill runs BEFORE the subscription lands, so a client that left
	// while the gate was awaiting would otherwise receive the history anyway -
	// the settle that reports the cancellation happens after the hook.
	let replayed = 0;
	await withPosture({
		hooks: {
			subscribe: async (ws, topic) => {
				tombstonePendingSubscribe(ws.getUserData(), topic);
				return null;
			},
			resume: () => { replayed++; }
		}
	}, async () => {
		const ws = fakeWs();
		assert.equal(await wireSubscribe(ws, 'room:1', { recover: { offset: 5 } }), 'FORBIDDEN');
		assert.equal(replayed, 0, 'the resume hook never ran');
	});
});

test('the observer lane honours the grant only where the wire lane does', async () => {
	await withPosture({ enabled: true }, async () => {
		const ws = fakeWs();
		assert.equal(
			await platform.checkSubscribe(ws, 'room:1', { requireGrant: true }),
			'FORBIDDEN',
			'armed with no hook, an ungranted observer is refused'
		);
		await platform.subscribe(ws, 'room:1');
		assert.equal(await platform.checkSubscribe(ws, 'room:1', { requireGrant: true }), null);
	});

	await withPosture({ enabled: false }, async () => {
		// Unarmed it falls through to the ordinary app gate. Denying here
		// regardless would break the snapshot lanes of every app that never
		// armed anything, with no error on either side.
		const ws = fakeWs();
		assert.equal(
			await platform.checkSubscribe(ws, 'room:1', { requireGrant: true }),
			null
		);
	});
});

test('platform.authorizeWireSubscribe arms, latches strict, and refuses a mode it cannot read', async () => {
	await withPosture({}, async () => {
		assert.equal(platform.authorizeWireSubscribe(), 'legacy');
		assert.equal(subscribeAuth.enabled, true);
		assert.equal(platform.authorizeWireSubscribe('strict'), 'strict');
		// Latched: a later legacy call cannot downgrade a strict worker.
		assert.equal(platform.authorizeWireSubscribe(), 'strict');
		assert.equal(platform.authorizeWireSubscribe('legacy'), 'strict');
		// A mode it cannot read is refused rather than treated as the weaker
		// one, for the same reason the option refuses a value it cannot read.
		assert.throws(() => platform.authorizeWireSubscribe('on'), TypeError);
		assert.throws(() => platform.authorizeWireSubscribe(true), TypeError);
	});
});

test('the batch lane knows when the grant, not a hook, is deciding', async () => {
	// What the wire batch path asks before it runs `subscribeBatch`. Every topic
	// reaching that hook is one the connection does not hold, so when this is
	// true the whole remainder is refused - and a client cannot drive the app's
	// batch hook over topic names it chose just by naming enough of them.
	const hooks = { subscribeBatch: () => ({}) };

	await withPosture({ enabled: false, hooks }, () => {
		assert.equal(wireGrantGateDecides(), false, 'unarmed, the hook decides');
	});
	await withPosture({ enabled: true, hooks }, () => {
		assert.equal(wireGrantGateDecides(), false, 'armed with a hook, the hook still decides');
	});
	await withPosture({ enabled: true, strict: true, hooks }, () => {
		assert.equal(wireGrantGateDecides(), true, 'strict: the hook cannot stand in for a grant');
	});
	await withPosture({ enabled: true }, () => {
		assert.equal(wireGrantGateDecides(), true, 'armed with no hook, there is nothing else to ask');
	});
	await withPosture({ enabled: false }, () => {
		assert.equal(wireGrantGateDecides(), false, 'and unarmed it is not this gate refusing');
	});
});

test('the option accepts its three spellings and refuses everything else', () => {
	for (const value of [true, false, 'strict']) {
		const { options } = normalizeWsOptions({ authorizeWireSubscribe: value });
		assert.equal(options.authorizeWireSubscribe, value);
	}
	assert.equal(
		normalizeWsOptions({}).options.authorizeWireSubscribe,
		false,
		'off by default: arming is a posture an app opts into'
	);
	// A restrictive flag that coerces arms nothing while the config reads as
	// armed. `process.env.WS_AUTHZ` is the natural way to write it and is a
	// string when set, so it has to be a build error rather than a silent off.
	for (const value of ['true', 'on', 1, 0, null, {}, 'Strict']) {
		assert.throws(
			() => normalizeWsOptions({ authorizeWireSubscribe: value }),
			/authorizeWireSubscribe/,
			`refused: ${JSON.stringify(value)}`
		);
	}
});

test('a ref-less subscribe asking for history is refused, not silently dropped', async () => {
	// Silence is right for a ref-less subscribe that asks for nothing: the
	// client said it would not listen. The recover lane is the one request whose
	// reply it MUST correlate - a caller replaying an offset and assuming it
	// took, when a gate or a denial swallowed it, resumes into a gap it cannot
	// see. Refused before anything can swallow it, in the uncorrelatable-error
	// shape (there is no ref to echo).
	assert.equal(
		deniesRefLessRecover({ hasResumeHook: () => {}, recover: { offset: 5 }, ref: null }),
		true
	);
	assert.equal(
		deniesRefLessRecover({ hasResumeHook: () => {}, recover: { offset: 5 }, ref: 7 }),
		false,
		'a ref means the answer is deliverable'
	);
	// No resume hook: there is no history to miss, so nothing is owed.
	assert.equal(
		deniesRefLessRecover({ hasResumeHook: undefined, recover: { offset: 5 }, ref: null }),
		false
	);
	// A malformed recover is ignored here exactly as the recover lane ignores it.
	for (const recover of [null, undefined, {}, { offset: -1 }, { offset: 1.5 }, { offset: '5' }]) {
		assert.equal(
			deniesRefLessRecover({ hasResumeHook: () => {}, recover, ref: null }),
			false,
			`not a history request: ${JSON.stringify(recover)}`
		);
	}
	// The frame names the topic, so a developer reading a client log can see
	// which request died.
	assert.equal(
		recoverRequiresRefFrame('room:1'),
		'{"type":"error","code":"RECOVER_REQUIRES_REF","topic":"room:1"}'
	);
	assert.equal(
		recoverRequiresRefFrame('say "hi"'),
		'{"type":"error","code":"RECOVER_REQUIRES_REF","topic":"say \\"hi\\""}',
		'the topic is JSON-encoded, not concatenated'
	);
});
