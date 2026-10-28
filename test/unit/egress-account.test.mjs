import { test } from 'node:test';
import { buildBinaryFrame } from '../../src/runtime/utils/wire.js';
import assert from 'node:assert/strict';
import {
	EGRESS_ADMITTED,
	EGRESS_DEFAULT_WINDOW_MS,
	binaryFrameChargeBytes,
	createEgressAccount,
	envelopeWireBytes,
	normalizeEgressOptions
} from '../../src/runtime/utils/egress-account.js';

// The account drives everything through an injected clock, so every window
// boundary in this file is exact and no test sleeps.

/** An account with its refusals and evictions recorded, on a manual clock. */
function harness(section, io = {}) {
	let now = 0;
	const refused = [];
	const evicted = [];
	const resolverInvalid = [];
	const account = createEgressAccount({
		options: normalizeEgressOptions(section),
		clock: () => now,
		onRefused: (scope, topic, dimension, limit) => refused.push({ scope, topic, dimension, limit }),
		onEvicted: (scope) => evicted.push(scope),
		onResolverInvalid: (raw) => resolverInvalid.push(raw),
		...io
	});
	return { account, refused, evicted, resolverInvalid, tick: (ms) => { now += ms; }, at: () => now };
}

test('the defaults are the family numbers, and zero or absent disables a ceiling', () => {
	const c = normalizeEgressOptions(undefined);
	assert.equal(c.windowMs, EGRESS_DEFAULT_WINDOW_MS);
	assert.equal(c.maxKeys, 4096);
	assert.equal(c.evictionSample, 8);
	assert.equal(c.topicEnabled, false);
	assert.equal(c.tenantEnabled, false);
	assert.equal(c.bytesEnabled, false);
	const armed = normalizeEgressOptions({ topic: { messages: 5, bytes: 0 } });
	assert.equal(armed.topicEnabled, true);
	assert.equal(armed.topic.bytes, 0, 'zero stays a disable, never a bound');
	assert.equal(armed.bytesEnabled, false, 'no bytes ceiling means no envelope walk');
});

test('maxKeys rounds UP to the next power of two, exactly', () => {
	assert.equal(normalizeEgressOptions({ maxKeys: 1024 }).maxKeys, 1024);
	assert.equal(normalizeEgressOptions({ maxKeys: 1025 }).maxKeys, 2048);
	assert.equal(normalizeEgressOptions({ maxKeys: 4353 }).maxKeys, 8192);
	assert.equal(normalizeEgressOptions({ maxKeys: 2 ** 24 }).maxKeys, 2 ** 24);
	// Out of the guard's range reads as absent, never inverted.
	assert.equal(normalizeEgressOptions({ maxKeys: 12 }).maxKeys, 4096);
});

test('a messages ceiling refuses the publish that WOULD cross it', () => {
	const { account, refused } = harness({ topic: { messages: 2 } });
	assert.equal(account.admit('t', null, 1, 0), true);
	account.charge('t', null, 1, 0, 0);
	assert.equal(account.admit('t', null, 1, 0), true);
	account.charge('t', null, 1, 0, 0);
	assert.equal(account.admit('t', null, 1, 0), false, 'the third message crosses');
	assert.deepEqual(refused, [{ scope: 'topic', topic: 't', dimension: 'messages', limit: 2 }]);
});

test('a deliveries ceiling counts recipients, not calls', () => {
	const { account } = harness({ topic: { deliveries: 10 } });
	assert.equal(account.admit('t', null, 1, 8), true);
	account.charge('t', null, 1, 8, 0);
	assert.equal(account.admit('t', null, 1, 3), false, '8 + 3 crosses 10');
	assert.equal(account.admit('t', null, 1, 2), true, '8 + 2 does not');
});

test('the bytes ceiling delivers the crossing publish and refuses the next', () => {
	// A publish's byte weight exists only after serialization, which must not
	// precede admission - so the ceiling refuses once the charge has REACHED
	// it, and overshoot is bounded by one publish's bytes.
	const { account, refused } = harness({ topic: { bytes: 100 } });
	assert.equal(account.admit('t', null, 1, 1), true);
	account.charge('t', null, 1, 1, 150);
	assert.equal(account.admit('t', null, 1, 1), false, 'the window has reached its bytes');
	assert.equal(refused[0].dimension, 'bytes');
});

test('a lapsed window rotates in place and the allowance returns', () => {
	const { account, tick } = harness({ topic: { messages: 1 }, windowMs: 1000 });
	account.charge('t', null, 1, 0, 0);
	assert.equal(account.admit('t', null, 1, 0), false);
	tick(1000);
	assert.equal(account.admit('t', null, 1, 0), true, 'a new window, a new allowance');
});

test('a batch is one decision: whole or not at all', () => {
	const { account } = harness({ topic: { messages: 5 } });
	assert.equal(account.admit('t', null, 4, 0), true, 'four fit');
	account.charge('t', null, 4, 0, 0);
	assert.equal(account.admit('t', null, 2, 0), false, 'two more do not - refused whole');
	assert.equal(account.admit('t', null, 1, 0), true, 'but one still fits');
});

test('a publish heavier than the whole window allowance is refused on every attempt', () => {
	// A 10-entry batch under messages: 5 can never fit a window. It must be
	// refused and REPORTED every time rather than admitted once the window is
	// fresh - and a fresh window is exactly when the temptation exists.
	const { account, refused, tick } = harness({ topic: { messages: 5 } });
	for (let round = 0; round < 3; round++) {
		assert.equal(account.admit('t', null, 10, 0), false, `attempt ${round + 1}`);
		tick(1000);
	}
	assert.equal(refused.length, 3, 'reported on every attempt, not just the first');
});

test('tenant ceilings ride the resolver, and an invalid answer attributes nothing', () => {
	const { account, refused, resolverInvalid } = harness(
		{ tenant: { messages: 1 } },
		{ tenantOf: (topic) => (topic === 'good' ? 'tenant-a' : { bogus: true }) }
	);
	const tenant = account.resolveTenant('good');
	assert.equal(tenant, 'tenant-a');
	assert.equal(account.admit('good', tenant, 1, 0), true);
	account.charge('good', tenant, 1, 0, 0);
	assert.equal(account.admit('good', tenant, 1, 0), false, 'the tenant window is spent');
	assert.equal(refused[0].scope, 'tenant');
	// The invalid answer: charged unattributed, defect reported once.
	assert.equal(account.resolveTenant('bad'), null);
	assert.equal(account.resolveTenant('bad2'), null);
	assert.equal(resolverInvalid.length, 1, 'a repeating coding defect is one line, not a stream');
});

test('a throwing resolver attributes nothing and never breaks a publish', () => {
	const { account, resolverInvalid } = harness(
		{ tenant: { messages: 1 } },
		{ tenantOf: () => { throw new Error('resolver boom'); } }
	);
	assert.equal(account.resolveTenant('t'), null);
	assert.equal(resolverInvalid.length, 1);
});

test('an id outside the shared attribution rule is refused, not mangled', () => {
	const { account } = harness(
		{ tenant: { messages: 1 } },
		{ tenantOf: () => 'has/slash', memoize: false }
	);
	assert.equal(account.resolveTenant('t'), null, 'a / could spoof a tenant-namespaced prefix');
});

test('the resolver is memoized per topic', () => {
	let calls = 0;
	const { account } = harness(
		{ tenant: { messages: 100 } },
		{ tenantOf: () => { calls++; return 'ten-1'; } }
	);
	account.resolveTenant('t');
	account.resolveTenant('t');
	account.resolveTenant('t');
	assert.equal(calls, 1, 'one resolver call, then the memo');
});

test('the ledger reclaims lapsed windows instead of evicting live ones', () => {
	// Fill past the cap ACROSS windows: every earlier key has lapsed by the
	// time the ledger is full, so new keys seat by reclamation and no live
	// window pays. maxKeys floor is 1024, so the churn here crosses it.
	const { account, evicted, tick } = harness({ maxKeys: 1024, topic: { messages: 100 }, windowMs: 100 });
	for (let i = 0; i < 3000; i++) {
		account.charge('t' + i, null, 1, 0, 0);
		tick(1);
	}
	assert.deepEqual(evicted, [], 'lapsed windows were reclaimed; no enforcement was thrown away');
});

test('at the cap with everything live, eviction is counted per scope', () => {
	// Every key inside ONE window: nothing has lapsed, so the cap can only
	// hold by dropping a live window - and each such drop is the enforcement
	// loss the counter exists to make visible.
	const { account, evicted } = harness({ maxKeys: 1024, topic: { messages: 100 } });
	for (let i = 0; i < 1200; i++) {
		account.charge('t' + i, null, 1, 0, 0);
	}
	assert.ok(evicted.length > 0, 'live evictions are reported');
	assert.ok(evicted.every((s) => s === 'topic'), 'under their scope');
});

test('admit reads and never writes, so a refusal leaves the window untouched', () => {
	const { account } = harness({ topic: { messages: 1 } });
	account.charge('t', null, 1, 0, 0);
	for (let i = 0; i < 5; i++) assert.equal(account.admit('t', null, 1, 0), false);
	// If refusals charged anything, the rotation below would still be over.
	const { account: fresh } = harness({ topic: { messages: 2 } });
	fresh.charge('u', null, 1, 0, 0);
	assert.equal(fresh.admit('u', null, 1, 0), true);
	assert.equal(fresh.admit('u', null, 1, 0), true, 'asking twice spends nothing');
});

test('the byte helpers price what the lanes send', () => {
	assert.equal(envelopeWireBytes('abc', 3, false), 9, 'UTF-16 length when no bytes ceiling');
	assert.equal(envelopeWireBytes('ä', 2, true), 4, 'exact UTF-8 bytes once one is armed');
	assert.equal(envelopeWireBytes('abc', 0), 0, 'nobody receiving charges nothing');
	assert.equal(binaryFrameChargeBytes(10, 0, 1), 14, 'tag + version + id + 1-byte seq + payload');
	assert.equal(binaryFrameChargeBytes(10, 128, 1), 15, 'a wider seq varint is charged');
	// The topic id is a VARINT too. Counting it as a flat byte is right only
	// while it stays under 128, so a shared wire id past the 127th shared topic
	// paid less than it sent, on every frame, for as long as it lived.
	assert.equal(binaryFrameChargeBytes(10, 0, 128), 15, 'and so is a wider topic-id varint');
	assert.equal(binaryFrameChargeBytes(10, 128, 128), 16, 'both widen independently');
	assert.equal(binaryFrameChargeBytes(10, 0, 16384), 16, 'three-byte id');
	// Exactly what the encoder writes, checked against it rather than against
	// arithmetic that could drift from it.
	for (const [seq, id] of [[0, 1], [128, 1], [0, 128], [200000, 70000]]) {
		assert.equal(
			binaryFrameChargeBytes(4, seq, id),
			buildBinaryFrame(1, id, seq, new Uint8Array(4)).length,
			`charge matches the frame the encoder builds (seq=${seq} id=${id})`
		);
	}
});

test('EGRESS_ADMITTED is a symbol, so no client payload can carry it', () => {
	assert.equal(typeof EGRESS_ADMITTED, 'symbol');
});

test('a refused decision leaves the ledger exactly as it found it', () => {
	// The topic half of the decision used to run through the mutating window
	// lookup, so it inserted a key - reclaiming and, at the cap, EVICTING
	// another to make room - before the tenant half could refuse. A tenant
	// already over its ceiling could then churn the topic ledger with fresh
	// topic names and reset other topics' accounting on the way through.
	const { account, evicted } = harness(
		{ maxKeys: 1024, topic: { messages: 100 }, tenant: { messages: 1 } },
		{ tenantOf: () => 'ten-1', memoize: false }
	);
	// Spend the tenant's whole allowance, so every later publish is refused by
	// the tenant half after the topic half has already been consulted.
	assert.equal(account.admit('t0', 'ten-1', 1, 0), true);
	account.charge('t0', 'ten-1', 1, 0, 0);
	assert.equal(account.admit('t0', 'ten-1', 1, 0), false, 'the tenant window is spent');

	// Now drive far more refused publishes, each naming a fresh topic, than the
	// ledger could hold. None of them may seat a key.
	for (let i = 0; i < 4000; i++) {
		assert.equal(account.admit('fresh' + i, 'ten-1', 1, 0), false, `refused at ${i}`);
	}
	assert.deepEqual(evicted, [], 'a refused publish evicted nothing');

	// And the topic that DID spend still holds its charge: a refused decision
	// must not have rotated its window and handed its allowance back.
	const snapshot = account.snapshot ? account.snapshot() : null;
	if (snapshot === null) {
		// No introspection surface - assert behaviourally instead: t0 has spent
		// 1 of 100 messages, so 99 more fit and the 100th does not.
		assert.equal(account.admitTopic('t0', 99, 0), true, 'the earlier charge is still counted');
		assert.equal(account.admitTopic('t0', 100, 0), false, 'and it is counted exactly once');
	}
});
