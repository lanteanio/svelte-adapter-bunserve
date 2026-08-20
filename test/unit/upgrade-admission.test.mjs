import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUpgradeAdmission, isCursorLaneUpgrade } from '../../src/runtime/utils/upgrade-admission.js';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// Admission control for the upgrade path. These pin the CONTRACT rather than
// the implementation, because the contract is shared: svelte-adapter-uws
// declares this block and this adapter must gate identically, so a config
// carried between the two behaves the same. Every default asserted here is
// uws's default, not one chosen locally.

test('every layer is off by default, so an empty block gates nothing', () => {
	const a = createUpgradeAdmission({});
	assert.equal(a.maxConcurrent, 0);
	assert.equal(a.maxConnections, 0);
	// Pacing off means no queue: the finite ceiling only exists to bound a queue
	// that pacing creates.
	assert.equal(a.maxDeferred, 0);
	assert.equal(a.cursorMaxConcurrent, 0);
	assert.equal(a.connectionHeadroom, null);
	assert.equal(a.hasCapacity(), true);
	for (let i = 0; i < 1000; i++) assert.equal(a.tryAcquire(), true);
	assert.equal(a.hasCapacity(), true);
});

test('maxConcurrent bounds in-flight handshakes and releases give the slot back', () => {
	const a = createUpgradeAdmission({ maxConcurrent: 2 });
	assert.equal(a.tryAcquire(), true);
	assert.equal(a.tryAcquire(), true);
	assert.equal(a.hasCapacity(), false);
	assert.equal(a.tryAcquire(), false, 'the third is refused');
	assert.equal(a.inFlight, 2);
	a.release();
	assert.equal(a.hasCapacity(), true);
	assert.equal(a.tryAcquire(), true);
});

test('maxConnections is held across the whole socket life, not just the handshake', () => {
	// The distinction that makes this different from maxConcurrent: permits are
	// NOT returned when the upgrade window ends, so sequential handshakes cannot
	// walk past the live-connection ceiling one at a time.
	const a = createUpgradeAdmission({ maxConnections: 2 });
	assert.equal(a.tryAcquireConnection(), true);
	assert.equal(a.tryAcquireConnection(), true);
	assert.equal(a.connectionPermits, 2);
	assert.equal(a.connectionHeadroom, 0);
	assert.equal(a.tryAcquireConnection(), false);
	assert.equal(a.hasCapacity(), false);
	a.releaseConnection();
	assert.equal(a.connectionHeadroom, 1);
	assert.equal(a.tryAcquireConnection(), true);
});

test('a permit released without an acquisition throws rather than going negative', () => {
	// Silence here would let a double-release manufacture headroom, and the
	// ceiling would then drift upward for the life of the process.
	const a = createUpgradeAdmission({ maxConnections: 1 });
	a.tryAcquireConnection();
	a.releaseConnection();
	assert.throws(() => a.releaseConnection(), /released without an acquisition/);
});

test('a disabled connection gate makes acquire and release both no-ops', () => {
	const a = createUpgradeAdmission({ maxConnections: 0 });
	assert.equal(a.tryAcquireConnection(), true);
	assert.equal(a.connectionPermits, 0);
	// Must NOT throw: with the gate off there is no permit to have acquired, and
	// the close path releases unconditionally.
	a.releaseConnection();
	assert.equal(a.connectionPermits, 0);
});

test('perTickBudget runs its budget synchronously and defers the rest to a later tick', async () => {
	const a = createUpgradeAdmission({ perTickBudget: 2, maxDeferred: 8 });
	const ran = [];
	assert.equal(a.admit(() => ran.push(0)), true);
	assert.equal(a.admit(() => ran.push(1)), true);
	assert.equal(a.admit(() => ran.push(2)), false, 'past the budget, deferred');
	assert.deepEqual(ran, [0, 1], 'the third has not run yet');
	assert.equal(a.deferredDepth, 1);
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(ran, [0, 1, 2], 'and runs on a later tick, in order');
	assert.equal(a.deferredDepth, 0);
});

test('the pacing queue is finite: overflow is refused, never retained', () => {
	// The point of the ceiling. An unbounded queue turns a connection storm into
	// retained closures, which is a leak wearing a throttle's clothing.
	const a = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 1 });
	assert.equal(a.admit(() => {}), true, 'this tick has budget');
	assert.equal(a.admit(() => {}), false, 'queued');
	assert.equal(a.admit(() => {}), null, 'queue full, refused');
	assert.equal(a.deferredRejectedTotal, 1);
	assert.equal(a.hasCapacity(), false);
});

test('maxDeferred defaults to 1024 while pacing, and stays 0 when pacing is off', () => {
	assert.equal(createUpgradeAdmission({ perTickBudget: 4 }).maxDeferred, 1024);
	assert.equal(createUpgradeAdmission({ maxDeferred: 50 }).maxDeferred, 0, 'no pacing, no queue');
	assert.equal(createUpgradeAdmission({ perTickBudget: 4, maxDeferred: 0 }).maxDeferred, 0);
});

test('the cursor lane carves a sub-budget and cannot starve the main lane', () => {
	const a = createUpgradeAdmission({ maxConcurrent: 8, cursorLane: { fraction: 0.25 } });
	assert.equal(a.cursorMaxConcurrent, 2, '25% of 8');
	assert.equal(a.tryAcquireCursor(), true);
	assert.equal(a.tryAcquireCursor(), true);
	assert.equal(a.tryAcquireCursor(), false, 'cursor sub-budget spent');
	// The main lane still has room, which is the property that matters: a flood
	// of cursor reconnects must never refuse a real client.
	assert.equal(a.tryAcquire(), true);
	assert.equal(a.inFlight, 3);
	a.releaseCursorInFlight();
	assert.equal(a.cursorInFlight, 1);
	assert.equal(a.inFlight, 2, 'both counters move together');
});

test('the cursor lane needs a ceiling to carve from, and is off unless asked for', () => {
	assert.equal(createUpgradeAdmission({ maxConcurrent: 8 }).cursorMaxConcurrent, 0, 'not requested');
	assert.equal(createUpgradeAdmission({ cursorLane: { fraction: 0.5 } }).cursorMaxConcurrent, 0, 'no ceiling');
	// An empty object enables the lane at the default fraction.
	assert.equal(createUpgradeAdmission({ maxConcurrent: 8, cursorLane: {} }).cursorMaxConcurrent, 2);
	// The floor of 1 keeps a configured lane usable against a small ceiling.
	assert.equal(createUpgradeAdmission({ maxConcurrent: 2, cursorLane: { fraction: 0.01 } }).cursorMaxConcurrent, 1);
});

test('the integer ceilings are validated by the controller itself', () => {
	// Held here as well as at config time, so an admission object built by any
	// other route is refused the same way.
	for (const bad of [-1, 1.5, NaN, Infinity]) {
		assert.throws(
			() => createUpgradeAdmission({ maxConnections: bad }),
			/maxConnections must be a non-negative safe integer/,
			`maxConnections ${bad}`
		);
		assert.throws(
			() => createUpgradeAdmission({ perTickBudget: 1, maxDeferred: bad }),
			/maxDeferred must be a non-negative safe integer/,
			`maxDeferred ${bad}`
		);
	}
});

test('hasCapacity answers without consuming a slot', () => {
	const a = createUpgradeAdmission({ maxConcurrent: 1 });
	assert.equal(a.hasCapacity(), true);
	assert.equal(a.hasCapacity(), true, 'asking twice does not spend the slot');
	assert.equal(a.inFlight, 0);
	a.tryAcquire();
	assert.equal(a.hasCapacity(), false);
});

test('the deferred observer is fed the right numbers, in the right order', () => {
	// Asserting only that it was CALLED leaves the arguments unpinned, and the
	// arguments are the whole payload: swapping depth for rejectedTotal, or
	// reporting a constant age, produces a metric that is confidently wrong.
	const a = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 1 });
	/** @type {Array<[number, number, number]>} */
	const seen = [];
	a.setDeferredObserver((depth, age, rejected) => seen.push([depth, age, rejected]));
	assert.deepEqual(seen.at(-1), [0, 0, 0], 'installing delivers an empty snapshot');

	a.admit(() => {});                       // runs, this tick has budget
	a.admit(() => {});                       // queued
	assert.deepEqual(seen.at(-1)?.[0], 1, 'depth is first');
	assert.deepEqual(seen.at(-1)?.[2], 0, 'rejectedTotal is third and still zero');

	a.admit(() => {});                       // refused, queue full
	assert.deepEqual(seen.at(-1)?.[0], 1, 'depth unchanged by a refusal');
	assert.deepEqual(seen.at(-1)?.[2], 1, 'and the refusal is counted');
});

test('the reported age of the oldest deferred callback is real, not a constant', async () => {
	const a = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 4 });
	assert.equal(a.deferredOldestAgeMs, 0, 'nothing queued, no age');
	a.admit(() => {});
	a.admit(() => {});
	await new Promise((r) => setTimeout(r, 25));
	// The queue drains on a later tick, so read before that happens is not
	// guaranteed; what IS guaranteed is that a queued entry ages.
	if (a.deferredDepth > 0) assert.ok(a.deferredOldestAgeMs > 0, 'a queued entry ages');
});

test('an observer that throws cannot refuse a connection', () => {
	const a = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 4 });
	a.setDeferredObserver(() => { throw new Error('exporter boom'); });
	// Observe-only: metrics must never be able to break admission.
	assert.doesNotThrow(() => { a.admit(() => {}); a.admit(() => {}); });
});

test('deferred callbacks run FIFO and stay within the tick budget', async () => {
	// Both properties were unpinned while only one callback was ever deferred:
	// a LIFO drain and a drain that flushed the whole queue in one tick each
	// passed. Six admits against a budget of two make the order observable and
	// the per-tick ceiling enforceable.
	const a = createUpgradeAdmission({ perTickBudget: 2, maxDeferred: 16 });
	const ran = [];
	for (let i = 0; i < 6; i++) a.admit(() => ran.push(i));
	assert.deepEqual(ran, [0, 1], 'only the budget runs synchronously');
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(ran, [0, 1, 2, 3, 4, 5], 'the rest follow in the order they arrived');
});

test('every accepted callback runs, in order, across a wrapping ring', async () => {
	// The ring only WRAPS while the queue stays non-empty - `dequeue` resets
	// head and tail to zero the moment it empties - so a test that lets it drain
	// between rounds never exercises the wrap at all. Admitting two per turn
	// against a budget of one keeps it occupied.
	//
	// The expectation is derived from what `admit` SAID it accepted, so this
	// pins the real contract: a callback the queue took must run, exactly once,
	// in arrival order. A head or tail that fails to wrap reads a hole, the
	// callback is silently swallowed by drain's guard, and the sequence comes up
	// short.
	const a = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 3 });
	/** @type {number[]} */
	const ran = [];
	/** @type {number[]} */
	const accepted = [];
	let n = 0;
	for (let round = 0; round < 8; round++) {
		for (let i = 0; i < 2; i++) {
			const id = n++;
			if (a.admit(() => ran.push(id)) !== null) accepted.push(id);
		}
		await new Promise((r) => setImmediate(r));
	}
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(ran, accepted, 'every accepted callback ran once, in arrival order');
	assert.ok(accepted.length > 8, `the run has to be long enough to wrap, accepted ${accepted.length}`);
});

test('a drain turn runs at most the tick budget, not the whole queue', async () => {
	// The point of pacing. A drain that flushes everything it has in one turn
	// starves the loop exactly as the unpaced path would, and every end-state
	// assertion still passes because the same callbacks eventually run.
	const a = createUpgradeAdmission({ perTickBudget: 2, maxDeferred: 32 });
	const ran = [];
	for (let i = 0; i < 8; i++) a.admit(() => ran.push(i));
	assert.deepEqual(ran, [0, 1], 'this tick spends its budget and no more');
	// One turn of the loop. The drain was scheduled before this, so it runs
	// first; anything past the budget having run means the budget is not held.
	await new Promise((r) => setImmediate(r));
	assert.ok(ran.length <= 4, `a single drain turn ran ${ran.length}, past the budget of 2`);
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(ran.length, 8, 'and the rest still arrive');
});

test('the age of a queued callback is measured, not reported as zero', async () => {
	// Read WITHOUT yielding, so no drain can empty the queue underneath the
	// assertion: the entry is provably still there, which is what makes a
	// hardcoded zero distinguishable from an empty queue.
	const a = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 4 });
	a.admit(() => {});
	a.admit(() => {});
	assert.equal(a.deferredDepth, 1, 'one is queued and nothing has yielded');
	const spun = Date.now();
	while (Date.now() - spun < 12) { /* hold the turn so the entry ages */ }
	assert.ok(a.deferredOldestAgeMs >= 10, `expected a real age, got ${a.deferredOldestAgeMs}`);
	await new Promise((r) => setTimeout(r, 40));
});

test('a drain that empties the queue still frees the following tick', async () => {
	// The drain consumes budget of its own while running callbacks, so after the
	// queue empties it has to schedule one more empty turn purely to reset the
	// counter. Without it the budget stays spent forever, and the next upgrade -
	// arriving on a quiet server, long after the burst - is paced against a tick
	// that ended minutes ago.
	const a = createUpgradeAdmission({ perTickBudget: 2, maxDeferred: 8 });
	for (let i = 0; i < 4; i++) a.admit(() => {});
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(a.deferredDepth, 0, 'the queue drained');
	assert.equal(a.admit(() => {}), true, 'and the next tick runs synchronously again');
});

test('a tick that spends its budget without queueing still resets on the next turn', async () => {
	// Without the reset the counter persists, and a quiet request arriving much
	// later is charged to a tick that ended long ago - so pacing refuses work
	// for a burst that has already passed.
	const a = createUpgradeAdmission({ perTickBudget: 2, maxDeferred: 4 });
	assert.equal(a.admit(() => {}), true);
	assert.equal(a.admit(() => {}), true, 'budget now spent, but nothing queued');
	assert.equal(a.deferredDepth, 0);
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	assert.equal(a.admit(() => {}), true, 'a later tick has its own budget');
});

test('a fraction above 1 is clamped rather than refused, as uws clamps it', () => {
	// Drop-in matters more than tidiness here: uws accepts this and clamps, so
	// refusing it would turn a running uws deployment into a build failure on
	// the way across.
	const a = createUpgradeAdmission({ maxConcurrent: 8, cursorLane: { fraction: 5 } });
	assert.equal(a.cursorMaxConcurrent, 8, 'clamped to the whole ceiling, not 40');
});

// --- the config surface -----------------------------------------------------

test('websocket.upgradeAdmission is accepted and normalized', () => {
	const { options } = normalizeWsOptions({
		upgradeAdmission: { maxConcurrent: 1000, maxConnections: 50_000, perTickBudget: 64, maxDeferred: 1024 }
	});
	assert.deepEqual(options.upgradeAdmission, {
		maxConcurrent: 1000, maxConnections: 50_000, perTickBudget: 64, maxDeferred: 1024
	});
});

test('an omitted block leaves the gate undefined rather than inventing a default', () => {
	const { options } = normalizeWsOptions({});
	assert.equal(options.upgradeAdmission, undefined);
});

test('an empty cursorLane survives normalization, because it is what enables the lane', () => {
	const { options } = normalizeWsOptions({ upgradeAdmission: { maxConcurrent: 8, cursorLane: {} } });
	assert.deepEqual(options.upgradeAdmission.cursorLane, {});
	assert.equal(createUpgradeAdmission(options.upgradeAdmission).cursorMaxConcurrent, 2);
});

test('a value uws accepts is accepted here too, rather than failing the build', () => {
	// THE DROP-IN CONSTRAINT, and the reason this does not simply validate
	// harder in every direction. A value uws runs has to build here, or carrying
	// a working config across turns into a build failure on the way.
	//
	// The counts are no longer among those values. uws range-checked two of the
	// four and took a fractional value for the rest; it now refuses all four
	// unless they are non-negative safe integers, and this adapter follows,
	// because a count is a whole number of things and `maxConcurrent: 1.5` was
	// never a bound anyone meant. What survives here is the cursor fraction,
	// which uws still CLAMPS rather than refuses - a fraction above 1, at 0, or
	// below it is a number uws runs, so refusing it here would be this adapter
	// inventing a failure.
	for (const block of [
		{ cursorLane: { fraction: 5 } },
		{ cursorLane: { fraction: 0 } },
		{ cursorLane: { fraction: -1 } }
	]) {
		assert.doesNotThrow(
			() => normalizeWsOptions({ upgradeAdmission: block }),
			`uws runs ${JSON.stringify(block)}`
		);
	}
	// And the counts uws does run: whole, non-negative, zero meaning off.
	for (const block of [{ maxConcurrent: 1000 }, { perTickBudget: 64 }, { maxConcurrent: 0 }]) {
		assert.doesNotThrow(
			() => normalizeWsOptions({ upgradeAdmission: block }),
			`uws runs ${JSON.stringify(block)}`
		);
	}
	// The shape is still a shape: a non-object block is a mistake in any adapter.
	assert.throws(
		() => normalizeWsOptions({ upgradeAdmission: 5 }),
		/`websocket\.upgradeAdmission` must be an object/
	);
});

test('a bound that is not a number is refused at build time, not carried into the gate', () => {
	// THE HOLE THE PIN ABOVE LEFT. That test says a value uws RUNS must build
	// here, and it is right; this one covers the values nothing runs. An
	// unconverted environment variable is the realistic way to get one, and the
	// gate reads `(opts && opts.x) || 0`, so a non-empty string is truthy and
	// becomes the bound itself.
	for (const key of ['maxConcurrent', 'maxConnections', 'perTickBudget', 'maxDeferred']) {
		for (const bad of ['1000', '', true, false, null, NaN, Infinity, {}, [], 10n, 1.5, -1]) {
			assert.throws(
				() => normalizeWsOptions({ upgradeAdmission: { [key]: bad } }),
				/must be a non-negative safe integer/,
				`refuses ${key}: ${String(bad)}`
			);
		}
	}
});

test('what those values did to a running gate, which is why the build refuses them', () => {
	// Kept as a live demonstration rather than a sentence in a comment, because
	// the guard above looks like fussiness until you see the cost. Both are
	// driven through the controller directly, since the build no longer lets
	// either shape reach it.
	//
	// A string ceiling admits everyone: `inFlight >= 'x'` is false forever.
	const noCeiling = createUpgradeAdmission({ maxConcurrent: 'definitely-not-valid' });
	let admitted = 0;
	for (let i = 0; i < 500; i++) if (noCeiling.tryAcquire()) admitted++;
	assert.equal(admitted, 500, 'the concurrency ceiling was off while the config asked for one');

	// A string pacing budget is worse than off: it fails the `<= 0` test that
	// would run callbacks inline, and leaves the deferred ceiling at 0, so the
	// queue is full on arrival and every upgrade is refused.
	const noUpgrades = createUpgradeAdmission({ perTickBudget: 'definitely-not-valid' });
	let ran = 0;
	for (let i = 0; i < 10; i++) noUpgrades.admit(() => { ran++; });
	assert.equal(ran, 0, 'nothing ran');
	assert.equal(noUpgrades.deferredDepth, 0, 'and nothing was queued to run later');
	assert.equal(noUpgrades.deferredRejectedTotal, 10, 'every upgrade was refused instead');
});

test('a cursor fraction that is not a number is refused rather than silently defaulted', () => {
	// The controller tests `typeof fraction === 'number'` and falls back to 0.25
	// when it is not, so this shape did not fail - it reserved a quarter of the
	// main ceiling for a lane the operator never sized, and said nothing. The
	// numbers uws clamps are still accepted; the pin above covers those.
	for (const bad of ['0.25', true, null, NaN, {}, 5n]) {
		assert.throws(
			() => normalizeWsOptions({ upgradeAdmission: { cursorLane: { fraction: bad } } }),
			/cursorLane\.fraction` must be a finite number/,
			`refuses fraction ${String(bad)}`
		);
	}
	// And the silent default it used to take, shown for what it was.
	assert.equal(
		createUpgradeAdmission({ maxConcurrent: 100, cursorLane: { fraction: 'x' } }).cursorMaxConcurrent,
		25,
		'a quarter of the ceiling, from a value nobody chose'
	);
});

test('the two ceilings uws range-checks are still range-checked, at the controller', () => {
	assert.throws(
		() => createUpgradeAdmission({ maxConnections: 1.5 }),
		/maxConnections must be a non-negative safe integer/
	);
	assert.throws(
		() => createUpgradeAdmission({ perTickBudget: 1, maxDeferred: -1 }),
		/maxDeferred must be a non-negative safe integer/
	);
});

test('a misspelled admission key WARNS, naming the keys that exist', () => {
	// Warned rather than thrown, because uws warns: a typo must be visible
	// without being a build failure that a carried-over config cannot survive.
	const { warnings } = normalizeWsOptions({ upgradeAdmission: { maxConcurent: 10 } });
	assert.ok(
		warnings.some((w) => /upgradeAdmission\.maxConcurent` is ignored/.test(w)),
		`expected a warning, got ${JSON.stringify(warnings)}`
	);
	const lane = normalizeWsOptions({ upgradeAdmission: { cursorLane: { frac: 0.5 } } });
	assert.ok(lane.warnings.some((w) => /cursorLane\.frac` is ignored/.test(w)));
});

test('waitingRoom is accepted, and an object asking for the page says so', () => {
	// uws serves a holding page by default whenever an admission layer is set,
	// and `false` is its documented opt-out. Refusing the key outright would
	// fail the build for exactly the config a careful uws operator writes.
	assert.doesNotThrow(() => normalizeWsOptions({
		upgradeAdmission: { maxConcurrent: 8, waitingRoom: false }
	}));
	const off = normalizeWsOptions({ upgradeAdmission: { maxConcurrent: 8, waitingRoom: false } });
	assert.equal(off.warnings.filter((w) => /waitingRoom/.test(w)).length, 0, 'false is the honest state here, so it is quiet');

	const asked = normalizeWsOptions({
		upgradeAdmission: { maxConcurrent: 8, waitingRoom: { path: '/waiting' } }
	});
	assert.ok(
		asked.warnings.some((w) => /waitingRoom` is not implemented/.test(w)),
		'a page that will not be served must not be accepted in silence'
	);
});

// --- the cursor lane's routing -----------------------------------------------

test('the cursor lane is keyed on the subprotocol token, with spacing tolerated', () => {
	// The token parsing is what routes an upgrade into the deprioritised lane.
	// Untested, the lane silently never engages and every cursor socket takes a
	// main-ceiling slot - which is the failure this lane exists to prevent.
	assert.equal(isCursorLaneUpgrade('svelte-realtime-cursor'), true);
	assert.equal(isCursorLaneUpgrade('other, svelte-realtime-cursor'), true, 'common ", " spacing');
	assert.equal(isCursorLaneUpgrade('other,svelte-realtime-cursor'), true, 'no spacing');
	assert.equal(isCursorLaneUpgrade('svelte-realtime-cursor, other'), true, 'first of several');
	assert.equal(isCursorLaneUpgrade('other'), false);
	assert.equal(isCursorLaneUpgrade('svelte-realtime-cursor-extra'), false, 'not a prefix match');
	assert.equal(isCursorLaneUpgrade(''), false);
	assert.equal(isCursorLaneUpgrade(undefined), false);
	assert.equal(isCursorLaneUpgrade(null), false);
});

test('zero is the documented off switch and must not be refused', () => {
	assert.doesNotThrow(() => normalizeWsOptions({
		upgradeAdmission: { maxConcurrent: 0, maxConnections: 0, perTickBudget: 0, maxDeferred: 0 }
	}));
});

test('the cursor lane needs the main ceiling to have room, not just its own', () => {
	// All-or-nothing. A cursor upgrade admitted while the main ceiling is full
	// would let the deprioritised lane overshoot the bound it is carved from.
	const a = createUpgradeAdmission({ maxConcurrent: 2, cursorLane: { fraction: 1 } });
	assert.equal(a.cursorMaxConcurrent, 2);
	assert.equal(a.tryAcquire(), true);
	assert.equal(a.tryAcquire(), true, 'main ceiling now full');
	assert.equal(a.tryAcquireCursor(), false, 'refused although the sub-budget is untouched');
	assert.equal(a.cursorInFlight, 0, 'and nothing was consumed by the refusal');
});
