import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Same bootstrap as ws-state.test.mjs: the handler modules read values the build
// freezes into the bundle, so setting them here is what lets the gate be tested
// without a build, a server, or a socket. The loader additionally resolves the
// build-injected WS_HANDLER specifier to a stub, which is what makes the
// authorization gate reachable from a unit test at all.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { platform, subscribeWithVerdict } = await import(
	'../../src/runtime/handler/platform.js'
);
const { WS_SUBSCRIPTIONS } = await import('../../src/runtime/handler/ws-state.js');
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

test('a recover offset the wire would refuse does not reach the hook here either', async () => {
	// platform.subscribe reaches the same recover branch a `subscribe` frame
	// does, so the offset rule cannot live only in the demux - an app calling the
	// API directly would otherwise hand the hook a value the wire refuses. The
	// last case is the one that matters in the other direction: refusing does not
	// clamp, it skips the gap-fill entirely, so an app cursor has to survive.
	let ran = 0;
	await withGate({ subscribe: () => null, resume: () => { ran++; } }, async () => {
		const ws = fakeWs();
		await platform.subscribe(ws, 'room:1', { recover: { offset: '5' } });
		assert.equal(ran, 0, 'a string offset is not a recover');
		await platform.subscribe(ws, 'room:2', { recover: { offset: -1 } });
		assert.equal(ran, 0, 'nor a negative one');
		await platform.subscribe(ws, 'room:3', { recover: { offset: 1e999 } });
		assert.equal(ran, 0, 'nor a non-finite one');
		await platform.subscribe(ws, 'room:4', { recover: { offset: 1e308 } });
		assert.equal(ran, 1, 'an app cursor past 2^53 still gap-fills');
	});
});

test('extra arguments to platform.subscribe cannot bypass the gate', async () => {
	// A batch verdict means "already authorized, install it", and any value that
	// is not `false` and not a string reads as one. So a fourth parameter on the
	// public method makes the everyday
	// `topics.map(platform.subscribe.bind(platform, ws))` - which supplies
	// (topic, index, array) - install every topic with no gate run at all. The
	// verdict channel is module-private and this method takes three parameters.
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

test('platform.subscribe declares exactly three parameters', () => {
	// Arity IS the defense: a fourth parameter turns every extra argument a
	// caller passes into a verdict. Asserted directly so adding one fails here.
	assert.equal(platform.subscribe.length, 3);
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
			// Without the escape it never reaches the gate at all.
			assert.equal(await platform.subscribe(ws, '__proto__'), 'INVALID_TOPIC');
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
	// The half that fails SILENTLY: because the public method takes three
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
			await subscribeWithVerdict(ws, '__internal', undefined, undefined),
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
