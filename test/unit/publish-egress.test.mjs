import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// The egress ceilings driven through the REAL publish lanes: what a refusal
// leaves untouched is the contract here, and only the production platform can
// prove it - the pure account tests cannot see a seq stamped for a frame that
// never went out.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { platform } = await import('../../src/runtime/handler/platform.js');
const { configureEgress, egressGate, _resetEgressForSim } = await import(
	'../../src/runtime/handler/publish-egress.js'
);
const { setServer, topicPublishStats, topicSeqs, wsCounters } = await import(
	'../../src/runtime/handler/ws-state.js'
);

/** A server that records publishes and answers a fixed subscriber count. */
function fakeServer(subscribers = 3) {
	const published = [];
	return {
		published,
		// Bun answers 0 for an empty topic; a fake that always claimed a byte
		// count would make a publish to nobody read as delivered.
		publish(topic, payload) {
			published.push({ topic, payload });
			return subscribers > 0 ? payload.length : 0;
		},
		subscriberCount: () => subscribers
	};
}

const realWarn = console.warn;
beforeEach(() => {
	topicPublishStats.clear();
	topicSeqs.clear();
	console.warn = () => {};
});
const restore = () => { console.warn = realWarn; };

test('zero-config publishes are charged into the stats and window counters, never refused', () => {
	try {
		configureEgress(undefined, null);
		const srv = fakeServer(4);
		setServer(srv);
		wsCounters.egressDeliveriesWindow = 0;
		assert.equal(platform.publish('room', 'tick', { n: 1 }), true);
		assert.equal(srv.published.length, 1);
		const s = topicPublishStats.get('room');
		assert.equal(s.m, 1);
		assert.equal(s.d, 4, 'deliveries ride the stats even with no ceiling armed');
		assert.equal(wsCounters.egressDeliveriesWindow, 4);
	} finally { restore(); }
});

test('a refused publish leaves no trace: no frame, no count, no seq, false back', () => {
	try {
		configureEgress({ topic: { messages: 1 } }, null);
		const srv = fakeServer(2);
		setServer(srv);
		assert.equal(platform.publish('room', 'tick', { n: 1 }, { seq: true }), true);
		const countBefore = wsCounters.publishCount;
		const seqBefore = topicSeqs.get('room');
		assert.equal(platform.publish('room', 'tick', { n: 2 }, { seq: true }), false, 'refused');
		assert.equal(srv.published.length, 1, 'nothing reached the native layer');
		assert.equal(wsCounters.publishCount, countBefore, 'publishCount never moved');
		assert.equal(topicSeqs.get('room'), seqBefore, 'no counter seq was drawn for it');
	} finally { restore(); }
});

test('a batch is admitted whole or refused whole, and decides exactly once', () => {
	try {
		configureEgress({ topic: { messages: 3 } }, null);
		const srv = fakeServer(1);
		setServer(srv);
		const wire = { capability: 'cap:x', schemaVersion: 1, encode: () => null };
		const entries = [{ data: 1 }, { data: 2 }, { data: 3 }];
		assert.equal(
			platform.publishWireBatch('room', 'tick', entries, wire, undefined),
			true,
			'three fit a window of three - and the batch decision is one, not one per entry'
		);
		assert.equal(srv.published.length, 3, 'every entry fanned out');
		assert.equal(
			platform.publish('room', 'tick', { n: 4 }),
			false,
			'the window is spent by exactly the batch size'
		);
	} finally { restore(); }
});

test('an admitted batch cannot be split by its own entries crossing a ceiling mid-flight', () => {
	// The bytes ceiling admits until the window has REACHED it, and the
	// stateless reroute charges entry by entry - so entry one's charge can
	// put the window at the ceiling while entries two and three are still in
	// flight. The batch decision covers them all: re-deciding per entry would
	// deliver a partial batch, which is exactly what whole-or-nothing forbids.
	try {
		configureEgress({ topic: { bytes: 10 } }, null);
		const srv = fakeServer(1);
		setServer(srv);
		const wire = { capability: 'cap:x', schemaVersion: 1, encode: () => null };
		const entries = [{ data: 'x'.repeat(40) }, { data: 'y'.repeat(40) }, { data: 'z'.repeat(40) }];
		assert.equal(platform.publishWireBatch('room', 'tick', entries, wire, undefined), true);
		assert.equal(srv.published.length, 3, 'every entry delivered - the batch was admitted whole');
		assert.equal(platform.publish('room', 'tick', 1), false, 'and the NEXT publish is the refused one');
	} finally { restore(); }
});

test('a batch heavier than the window is refused with nothing stamped or sent', () => {
	try {
		configureEgress({ topic: { messages: 2 } }, null);
		const srv = fakeServer(1);
		setServer(srv);
		const wire = { capability: 'cap:x', schemaVersion: 1, encode: () => null };
		const entries = [{ data: 1 }, { data: 2 }, { data: 3 }];
		const countBefore = wsCounters.publishCount;
		assert.equal(platform.publishWireBatch('room', 'tick', entries, wire, undefined), false);
		assert.equal(srv.published.length, 0, 'no entry reached the native layer');
		assert.equal(wsCounters.publishCount, countBefore);
	} finally { restore(); }
});

test('a refused sendTo delivers to nobody and answers zero', () => {
	try {
		configureEgress({ topic: { messages: 1 } }, null);
		setServer(fakeServer(0));
		// Spend the topic's window. Nobody subscribes, so the publish reaches
		// no one - but it is still one logical publish and is still charged.
		assert.equal(platform.publish('room', 'tick', { n: 1 }), false, 'reached nobody');
		assert.equal(platform.sendTo(() => true, 'room', 'tick', { n: 2 }), 0, 'refused');
	} finally { restore(); }
});

test('tenant ceilings pool a tenant across its topics', () => {
	try {
		configureEgress({ tenant: { messages: 2 } }, (topic) => topic.split(':')[0]);
		const srv = fakeServer(1);
		setServer(srv);
		assert.equal(platform.publish('acme:a', 'tick', 1), true);
		assert.equal(platform.publish('acme:b', 'tick', 2), true);
		assert.equal(platform.publish('acme:c', 'tick', 3), false, 'the TENANT window is spent');
		assert.equal(platform.publish('other:a', 'tick', 4), true, 'another tenant is untouched');
	} finally { restore(); }
});

test('a defined non-function egressTenantOf refuses the boot rather than unarming quietly', () => {
	try {
		assert.throws(
			() => configureEgress({ tenant: { messages: 1 } }, 'not-a-function'),
			/egressTenantOf export must be a function/
		);
	} finally { restore(); }
});

test('the sim reset replays the configuration with fresh windows', () => {
	try {
		configureEgress({ topic: { messages: 1 } }, null);
		const srv = fakeServer(1);
		setServer(srv);
		assert.equal(platform.publish('room', 'tick', 1), true);
		assert.equal(platform.publish('room', 'tick', 2), false, 'spent');
		_resetEgressForSim();
		assert.equal(egressGate.armed, true, 'still armed after the reset');
		assert.equal(platform.publish('room', 'tick', 3), true, 'and the window is fresh');
	} finally {
		restore();
		// Leave the module unarmed for whatever runs after this file.
		configureEgress(undefined, null);
	}
});
