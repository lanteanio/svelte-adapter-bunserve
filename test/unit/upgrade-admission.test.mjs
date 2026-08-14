import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUpgradeAdmission } from '../../src/runtime/utils/upgrade-admission.js';
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

test('the deferred observer is fed, and its throw cannot break admission', () => {
	const a = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 4 });
	const seen = [];
	a.setDeferredObserver((depth, age, rejected) => seen.push([depth, rejected]));
	assert.equal(seen.length, 1, 'installing delivers an initial snapshot');
	a.admit(() => {});
	a.admit(() => {});
	assert.ok(seen.length > 1, 'an enqueue notifies');
	a.setDeferredObserver(() => { throw new Error('exporter boom'); });
	// Observe-only: metrics must never be able to refuse a connection.
	assert.doesNotThrow(() => a.admit(() => {}));
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

test('a bad ceiling is REFUSED at config time, not warned about', () => {
	// Deliberately unlike the pressure block, which warns and falls back. A
	// mistyped threshold there still leaves a protective default in place; a
	// mistyped ceiling here would leave the gate wide open, so the operator who
	// asked for a bound would silently not have one.
	assert.throws(
		() => normalizeWsOptions({ upgradeAdmission: { maxConcurrent: -1 } }),
		/`websocket\.upgradeAdmission\.maxConcurrent` must be a non-negative safe integer/
	);
	assert.throws(
		() => normalizeWsOptions({ upgradeAdmission: { maxConnections: 1.5 } }),
		/must be a non-negative safe integer/
	);
	assert.throws(
		() => normalizeWsOptions({ upgradeAdmission: 5 }),
		/`websocket\.upgradeAdmission` must be an object/
	);
});

test('a misspelled admission key is refused, naming the keys that exist', () => {
	// A typo in a ceiling is the same failure as a bad value: the bound the
	// operator asked for is not applied, and nothing says so.
	assert.throws(
		() => normalizeWsOptions({ upgradeAdmission: { maxConcurent: 10 } }),
		/unknown adapter option `websocket\.upgradeAdmission\.maxConcurent`; known keys are/
	);
	assert.throws(
		() => normalizeWsOptions({ upgradeAdmission: { cursorLane: { frac: 0.5 } } }),
		/unknown adapter option `websocket\.upgradeAdmission\.cursorLane\.frac`/
	);
});

test('cursorLane.fraction is bounded to (0, 1]', () => {
	assert.throws(
		() => normalizeWsOptions({ upgradeAdmission: { cursorLane: { fraction: 0 } } }),
		/greater than 0 and at most 1/
	);
	assert.throws(
		() => normalizeWsOptions({ upgradeAdmission: { cursorLane: { fraction: 1.5 } } }),
		/greater than 0 and at most 1/
	);
	assert.doesNotThrow(() => normalizeWsOptions({ upgradeAdmission: { cursorLane: { fraction: 1 } } }));
});

test('zero is the documented off switch and must not be refused', () => {
	assert.doesNotThrow(() => normalizeWsOptions({
		upgradeAdmission: { maxConcurrent: 0, maxConnections: 0, perTickBudget: 0, maxDeferred: 0 }
	}));
});
