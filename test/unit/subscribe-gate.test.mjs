import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Same bootstrap as ws-state.test.mjs: the handler modules read values the build
// freezes into the bundle, so setting them here is what lets the gate be tested
// without a build, a server, or a socket. The loader additionally resolves the
// build-resolved #ws-handler specifier to a stub, which is what makes the
// authorization gate reachable from a unit test at all.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';


const { platform, subscribeWithVerdict } = await import(
	'../../src/runtime/handler/platform.js'
);
const { MAX_SUBSCRIPTIONS_PER_CONNECTION, WS_SUBSCRIPTIONS } = await import('../../src/runtime/handler/ws-state.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

/** A stand-in for the socket facade, recording what it was asked to install. */
function fakeWs() {
	const installed = [];
	const ud = { [WS_SUBSCRIPTIONS]: new Set() };
	return {
		installed,
		getUserData: () => ud,
		subscribe: (topic) => installed.push(topic)
	};
}

/** Install an app gate for the duration of one test. */
async function withGate(hooks, fn) {
	__setHooks(hooks);
	try {
		return await fn();
	} finally {
		__setHooks({});
	}
}

test('a private recover offset the wire would refuse does not reach the hook', async () => {
	// The private entry reaches the same recover branch a `subscribe` frame
	// does, so the offset rule cannot live only in the demux - an app calling the
	// API directly would otherwise hand the hook a value the wire refuses. The
	// last case is the one that matters in the other direction: refusing does not
	// clamp, it skips the gap-fill entirely, so an app cursor has to survive.
	let ran = 0;
	await withGate({ subscribe: () => null, resume: () => { ran++; } }, async () => {
		const ws = fakeWs();
		await subscribeWithVerdict(ws, 'room:1', { recover: { offset: '5' } });
		assert.equal(ran, 0, 'a string offset is not a recover');
		await subscribeWithVerdict(ws, 'room:2', { recover: { offset: -1 } });
		assert.equal(ran, 0, 'nor a negative one');
		await subscribeWithVerdict(ws, 'room:3', { recover: { offset: 1e999 } });
		assert.equal(ran, 0, 'nor a non-finite one');
		await subscribeWithVerdict(ws, 'room:4', { recover: { offset: 1e308 } });
		assert.equal(ran, 1, 'an app cursor past 2^53 still gap-fills');
	});
});

test('extra arguments to platform.subscribe cannot bypass the gate', async () => {
	// A batch verdict means "already authorized, install it", and any value that
	// is not `false` and not a string reads as one. So a fourth parameter on the
	// public method makes the everyday
	// `topics.map(platform.subscribe.bind(platform, ws))` - which supplies
	// (topic, index, array) - install every topic with no gate run at all. The
	// verdict channel is module-private and this method takes two parameters.
	await withGate(
		{ subscribe: () => 'FORBIDDEN' },
		async () => {
			const topics = ['user:42', 'user:43'];
			const ws = fakeWs();
			const results = await Promise.all(
				topics.map(platform.subscribe.bind(platform, ws))
			);
			assert.deepEqual(results, ['FORBIDDEN', 'FORBIDDEN']);
			assert.deepEqual(ws.installed, [], 'nothing may be installed past a denying gate');

			// The same, spelled with every extra-argument shape that reaches it.
			for (const extra of [[], {}, 0, 1, true, null, 'anything', Symbol('x')]) {
				const w = fakeWs();
				assert.equal(
					await platform.subscribe(w, 'room:1', undefined, extra),
					'FORBIDDEN',
					`a 4th argument of ${String(extra)} must not authorize`
				);
				assert.deepEqual(w.installed, []);
			}
		}
	);
});

test('platform.subscribe declares exactly two parameters', () => {
	// Arity IS the defense: a fourth parameter turns every extra argument a
	// caller passes into a verdict. Asserted directly so adding one fails here.
	assert.equal(platform.subscribe.length, 2);
});

test('checkSubscribe answers a non-string topic instead of throwing', async () => {
	// The system-namespace guard used to run first, and `isSystemTopic` reads
	// `topic.charCodeAt(0)`. checkSubscribe is the one gate entry point the
	// adapter cannot see the other half of - the documented pattern feeds it
	// client input directly - so `{"room": null}` became a rejected promise
	// where `subscribe` returns INVALID_TOPIC. An app wrapping the documented
	// call in a try/catch with a permissive fallback turned that into an allow.
	await withGate({ subscribe: () => null }, async () => {
		const ws = fakeWs();
		for (const topic of [null, undefined, 17, {}, [], true, Symbol('t')]) {
			assert.equal(
				await platform.checkSubscribe(ws, topic),
				'INVALID_TOPIC',
				`${String(topic)} must be answered, not thrown`
			);
			// And the two entry points agree about it, which is the whole point
			// of the shared gate.
			assert.equal(await platform.subscribe(ws, topic), 'INVALID_TOPIC');
		}
	});
});

test('a __proto__ topic fails closed on the per-topic gate too', async () => {
	// The batch mapping already refused it, because it cannot be an own key of
	// the denials object. The per-topic hook has the mirror-image problem: an
	// app whose gate is an allowlist lookup reads Object.prototype for it, which
	// is truthy, and allows. Two lanes disagreeing about one topic name is the
	// class this guard deletes.
	await withGate(
		{
			subscribe: (ws, topic) => {
				const ALLOWLIST = { 'room:1': true };
				return ALLOWLIST[topic] ? null : 'FORBIDDEN';
			}
		},
		async () => {
			const ws = fakeWs();
			assert.equal(
				await platform.subscribe(ws, '__proto__', { allowSystemTopic: true }),
				'INTERNAL_ERROR'
			);
			assert.deepEqual(ws.installed, []);
			assert.equal(await platform.subscribe(ws, '__proto__'), 'INTERNAL_ERROR');
			// An ordinary topic is unaffected.
			assert.equal(await platform.subscribe(ws, 'room:1'), null);
			assert.deepEqual(ws.installed, ['room:1']);
		}
	);
});

test('an empty-string denial reason still denies', async () => {
	// The reason is tested for nullishness, not truthiness: a hook produces ''
	// naturally from a lookup miss, and under truthiness that denial installs.
	await withGate({ subscribe: () => '' }, async () => {
		const ws = fakeWs();
		assert.equal(await platform.subscribe(ws, 'room:1'), '');
		assert.deepEqual(ws.installed, []);
	});
});

test('the private verdict channel still carries the batch verdict', async () => {
	// The half that fails SILENTLY: because the public method takes two
	// parameters, the wire batch path must call subscribeWithVerdict directly.
	// Passing a verdict to `platform.subscribe` drops it, and every entry in the
	// batch re-runs the app gate - one hook call per topic, the exact cost
	// `subscribeBatch` exists to avoid, with nothing to show it happened.
	let hookCalls = 0;
	await withGate(
		{
			subscribe: () => {
				hookCalls++;
				return null;
			}
		},
		async () => {
			const ws = fakeWs();
			// A denial verdict is honoured without consulting the hook...
			assert.equal(
				await subscribeWithVerdict(ws, 'room:1', undefined, 'FORBIDDEN'),
				'FORBIDDEN'
			);
			// ...and so is an allow.
			assert.equal(await subscribeWithVerdict(ws, 'room:2', undefined, undefined), null);
			assert.equal(hookCalls, 1, 'only the entry with no verdict may reach the hook');
			assert.deepEqual(ws.installed, ['room:2']);
		}
	);
});

test('a verdict cannot override wire validation or the system-namespace guard', async () => {
	// A verdict says the GATE ran, not that the topic is legal. Both checks run
	// ahead of it.
	await withGate({ subscribe: () => null }, async () => {
		const ws = fakeWs();
		assert.equal(await subscribeWithVerdict(ws, '', undefined, undefined), 'INVALID_TOPIC');
		assert.equal(
			await subscribeWithVerdict(ws, '__internal', undefined, undefined, { fromWire: true }),
			'INVALID_TOPIC'
		);
		assert.equal(
			await subscribeWithVerdict(ws, '__proto__', { allowSystemTopic: true }, undefined),
			'INTERNAL_ERROR'
		);
		assert.deepEqual(ws.installed, []);
	});
});

test('a verdict the adapter cannot read denies instead of allowing', async () => {
	// The per-topic lane allowed everything that was not `false` and not a
	// string, so a gate written `return allowed[topic] ? null : 403` denied
	// nothing, and a forgotten `await` handed the client every topic it could
	// name. The batch lane has always refused these values; both now share
	// isReadableVerdict, so the same hook logic cannot allow through one entry
	// point and deny through the other.
	for (const unreadable of [403, 0, NaN, {}, [], new Error('FORBIDDEN'), Symbol('no'), 12n]) {
		await withGate({ subscribe: () => unreadable }, async () => {
			const ws = fakeWs();
			assert.equal(
				await platform.subscribe(ws, 'user:42'),
				'INTERNAL_ERROR',
				`a verdict of ${String(unreadable)} must not authorize`
			);
			assert.deepEqual(ws.installed, []);
			// checkSubscribe is the same gate, so it must answer the same way.
			assert.equal(await platform.checkSubscribe(ws, 'user:42'), 'INTERNAL_ERROR');
		});
	}
	// A promise is the shape an `async` gate produces when its result is
	// returned without being awaited by a synchronous wrapper.
	await withGate({ subscribe: () => Promise.resolve('FORBIDDEN') }, async () => {
		const ws = fakeWs();
		// Awaited by the gate itself, so this one resolves to a real reason.
		assert.equal(await platform.subscribe(ws, 'user:42'), 'FORBIDDEN');
		assert.deepEqual(ws.installed, []);
	});
	await withGate({ subscribe: () => ({ then: 17 }) }, async () => {
		const ws = fakeWs();
		assert.equal(await platform.subscribe(ws, 'user:42'), 'INTERNAL_ERROR');
		assert.deepEqual(ws.installed, []);
	});
});

test('the readable no-opinion shapes still allow', async () => {
	// The fail-closed rule must not swallow the overwhelmingly common return
	// from a hook that guards a few topics and ignores the rest.
	for (const allowing of [null, undefined, true]) {
		await withGate({ subscribe: () => allowing }, async () => {
			const ws = fakeWs();
			assert.equal(
				await platform.subscribe(ws, 'room:1'),
				null,
				`a verdict of ${String(allowing)} must allow`
			);
			assert.deepEqual(ws.installed, ['room:1']);
		});
	}
});

test('the subscription cap is re-checked AFTER the gate, not only before it', () => {
	// The bound that a pipelined blast defeats if it is read once. An async gate
	// lets many frames pass the pre-await size check and all install, so the
	// landing has to ask again against the set as it stands then. Driven here
	// directly rather than by pipelining, because the live lane can no longer
	// reach this ceiling: it is a constant of 65,536 now, not a settable option.
	const ws = fakeWs();
	const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
	for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION - 1; i++) subs.add(`filler:${i}`);
	let landed = null;
	return withGate({
		subscribe: async () => {
			// Another subscribe lands while this one is parked in the hook. The
			// pre-await check already passed for both.
			subs.add('raced');
			return null;
		}
	}, async () => {
		landed = await platform.subscribe(ws, 'late');
		assert.equal(landed, 'RATE_LIMITED', 'refused at the landing, not installed past the cap');
		assert.equal(subs.has('late'), false, 'and nothing was added');
		assert.equal(subs.size, MAX_SUBSCRIPTIONS_PER_CONNECTION, 'the cap holds exactly');
		assert.deepEqual(ws.installed, [], 'the socket was never asked to subscribe');
	});
});


test('platform subscribe silently allows missing hooks and closed sockets', async () => {
	await withGate({}, async () => {
		assert.equal(await platform.subscribe(fakeWs(), 'public'), null);
		assert.equal(await platform.subscribe({ getUserData() { throw new Error('closed'); } }, 'room'), null);
	});
	await withGate({ subscribe: () => null }, async () => {
		const ws = fakeWs();
		ws.subscribe = () => { throw new Error('closed'); };
		assert.equal(await platform.subscribe(ws, 'closed-during-gate'), null);
	});
});


test('pending subscribes count attempts even when all target one topic', async () => {
	let release;
	const parked = new Promise(resolve => { release = resolve; });
	let calls = 0;
	await withGate({ subscribe: () => { calls++; return parked; } }, async () => {
		const ws = fakeWs();
		const pending = Array.from({ length: 4096 }, () => platform.subscribe(ws, 'same'));
		assert.equal(calls, 4096);
		assert.equal(await platform.subscribe(ws, 'same'), 'RATE_LIMITED');
		assert.equal(await subscribeWithVerdict(ws, 'other', undefined, undefined, { fromWire: true }), 'RATE_LIMITED');
		release(null);
		assert.ok((await Promise.all(pending)).every(result => result === null));
		assert.equal(await platform.subscribe(ws, 'other'), null);
	});
});


test('server system topics reach the application gate without an escape option', async () => {
	const topics = [];
	await withGate({ subscribe: (_ws, topic) => { topics.push(topic); return topic === '__denied' ? 'FORBIDDEN' : null; } }, async () => {
		const ws = fakeWs();
		assert.equal(await platform.subscribe(ws, '__realtime'), null);
		assert.equal(await platform.checkSubscribe(ws, '__observer'), null);
		assert.equal(await platform.subscribe(ws, '__denied'), 'FORBIDDEN');
		assert.equal(await platform.checkSubscribe(ws, '__denied'), 'FORBIDDEN');
		assert.deepEqual(topics, ['__realtime', '__observer', '__denied', '__denied']);
		assert.deepEqual(ws.installed, ['__realtime']);
	});
});

test('platform.subscribe ignores extra recovery and system-topic options', async () => {
	let resumed = 0;
	await withGate({ subscribe: () => null, resume: () => { resumed++; } }, async () => {
		const ws = fakeWs();
		const options = new Proxy({}, { get() { assert.fail('extra arguments are not inspected'); } });
		assert.equal(await platform.subscribe(ws, '__realtime', options), null);
		assert.equal(resumed, 0);
	});
});


test('observer checks share the configured wire alphabet while server checks remain trusted', () => {
	for (const allowNonAsciiTopics of [false, true]) {
		const script = `
			import assert from 'node:assert/strict';
			globalThis.ENV_PREFIX = '';
			globalThis.WS_OPTIONS = { allowNonAsciiTopics: ${allowNonAsciiTopics} };
			globalThis.WS_PATH = '/ws';
			const { platform } = await import('./src/runtime/handler/platform.js');
			const { WS_SUBSCRIPTIONS } = await import('./src/runtime/handler/ws-state.js');
			const { __setHooks } = await import('./test/helpers/ws-handler-stub.mjs');
			let calls = 0;
			__setHooks({ subscribe: () => { calls++; return null; } });
			const topic = 'room:' + String.fromCharCode(0x00fc);
			const data = { [WS_SUBSCRIPTIONS]: new Set([topic]) };
			const ws = { getUserData: () => data };
			platform.authorizeWireSubscribe('strict');
			assert.equal(await platform.checkSubscribe(ws, topic), null);
			assert.equal(await platform.checkSubscribe(ws, topic, { requireGrant: true }), ${allowNonAsciiTopics ? 'null' : "'INVALID_TOPIC'"});
			assert.equal(calls, ${allowNonAsciiTopics ? 2 : 1});
		`;
		const result = spawnSync(process.execPath, ['--conditions=bunserve-test', '--input-type=module', '-e', script], {
			cwd: new URL('../../', import.meta.url), encoding: 'utf8'
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
	}
});
