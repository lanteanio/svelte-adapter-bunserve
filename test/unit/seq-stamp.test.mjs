import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// WHAT A PUBLISH STAMPS WHEN NOBODY SAID. The exotic seq VALUES are pinned in
// publish-seq.test.mjs; this file pins the option being ABSENT, which is the
// most common call shape there is and the one nothing pinned in either
// direction until the two adapters were executed side by side and disagreed.
//
// The table below is the contract, and svelte-adapter-uws answers it
// identically - the adapters are documented drop-in replacements, so the same
// app must put the same bytes on the wire under both:
//
//   option        stamps
//   no options    the per-topic counter
//   {}            the same counter
//   { seq: true }  the same counter
//   { seq: false } nothing (the envelope omits the field)
//   { seq: 5 }     5, as given
//
// The five rows are asserted through BOTH seams an app can reach: the pure
// stamping function, and platform.publish's real arity over a fake server.

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { platform } = await import('../../src/runtime/handler/platform.js');
const { MAX_SEQ_TOPICS, maxAuthoritativeSeq, setServer, stampSeq, stampSeqValue, topicSeqs } =
	await import('../../src/runtime/handler/ws-state.js');

/** A fake native server recording the envelopes handed to it. */
function fakeServer() {
	const published = [];
	return {
		published,
		publish(topic, payload) {
			published.push({ topic, payload });
			return typeof payload === 'string' ? payload.length : payload.byteLength;
		},
		subscriberCount: () => 1
	};
}

function reset() {
	topicSeqs.clear();
	maxAuthoritativeSeq.clear();
}

test('absent options draw the per-topic counter, 1, 2, 3', () => {
	try {
		assert.equal(stampSeqValue(undefined, 'room'), 1);
		assert.equal(stampSeqValue(undefined, 'room'), 2);
		assert.equal(stampSeqValue(undefined, 'room'), 3);
		// Per TOPIC, not per process: a second topic starts its own run.
		assert.equal(stampSeqValue(undefined, 'other'), 1);
		assert.equal(stampSeqValue(undefined, 'room'), 4);
	} finally {
		reset();
	}
});

test('an options object without seq is the same counter, and so is { seq: true }', () => {
	try {
		// stampSeq is the options form; both spellings feed one counter rather
		// than each keeping a run of its own.
		assert.equal(stampSeq(undefined, 'room'), 1);
		assert.equal(stampSeq({}, 'room'), 2);
		assert.equal(stampSeq({ compress: true }, 'room'), 3);
		assert.equal(stampSeq({ seq: true }, 'room'), 4);
		assert.equal(stampSeq(null, 'room'), 5, 'a null options object is absent options');
	} finally {
		reset();
	}
});

test('only an explicit false opts out, and it does not consume a counter value', () => {
	try {
		assert.equal(stampSeqValue(undefined, 'room'), 1);
		assert.equal(stampSeqValue(false, 'room'), null);
		assert.equal(stampSeqValue(false, 'room'), null);
		assert.equal(stampSeqValue(undefined, 'room'), 2, 'the run continues where it left off');
	} finally {
		reset();
	}
});

test('an explicit number is taken as given, and never advances the counter', () => {
	try {
		assert.equal(stampSeqValue(5, 'room'), 5);
		assert.equal(stampSeqValue(2 ** 53, 'room'), 2 ** 53, 'no ceiling: an event-store cursor passes through');
		assert.equal(stampSeqValue(undefined, 'room'), 1, 'the counter is untouched by the explicit lane');
	} finally {
		reset();
	}
});

test('the counter map is bounded, and a topic still being published to is not what is thrown away', () => {
	// The counter is now the DEFAULT, so this map is reached by every publish
	// and its bound is what keeps an app publishing to client-named topics
	// (room:<uuid>) from growing one entry per topic for the life of the
	// process. Eviction is second-chance rather than exact LRU - keeping the
	// map in use order costs an order of magnitude per stamp at this size -
	// so what is pinned here is the property that actually matters: a topic
	// touched since the last sweep outlives topics that were not.
	//
	// The refreshed topic is deliberately NOT the oldest key. A sweep that
	// only ever spared the entry it was about to evict would satisfy an
	// oldest-key version of this test while letting every other hot topic age
	// out and restart at seq 1, which is the user-visible harm.
	try {
		for (let i = 0; i < MAX_SEQ_TOPICS; i++) stampSeqValue(undefined, `t:${i}`);
		assert.equal(topicSeqs.size, MAX_SEQ_TOPICS, 'filled to exactly the cap');

		assert.equal(stampSeqValue(undefined, 't:5'), 2, 'a topic in the middle is stamped again');
		for (let i = 0; i < 6; i++) stampSeqValue(undefined, `fresh:${i}`);

		assert.equal(topicSeqs.size, MAX_SEQ_TOPICS, 'still exactly the cap');
		assert.equal(topicSeqs.get('t:5'), 2, 'the re-stamped topic survived, counter intact');
		for (const gone of ['t:0', 't:1', 't:2', 't:3', 't:4', 't:6']) {
			assert.equal(topicSeqs.has(gone), false, `${gone} was not touched and went instead`);
		}

		// An evicted topic restarts at 1 - the documented consequence, and the
		// reason the bound warns rather than silently discarding.
		assert.equal(stampSeqValue(undefined, 't:0'), 1);
	} finally {
		reset();
	}
});

test('the bound holds however many topics arrive', () => {
	// The eviction runs before the insert, so the map is never even
	// transiently over its bound - and an app churning through topics faster
	// than the cap must not be able to walk it upward.
	try {
		for (let i = 0; i < MAX_SEQ_TOPICS * 2; i++) {
			stampSeqValue(undefined, `churn:${i}`);
			if (topicSeqs.size > MAX_SEQ_TOPICS) {
				assert.fail(`the map grew to ${topicSeqs.size} at topic ${i}`);
			}
		}
		assert.equal(topicSeqs.size, MAX_SEQ_TOPICS);
		// The most recent arrivals are the ones still held.
		assert.equal(topicSeqs.has(`churn:${MAX_SEQ_TOPICS * 2 - 1}`), true);
	} finally {
		reset();
	}
});

test('platform.publish with no options argument delivers seq 1, then 2', () => {
	// The card this pins exists because every fixture and test site passed an
	// options object, so the three-argument arity - the one an app reaches for
	// first - was never executed anywhere.
	const srv = fakeServer();
	setServer(srv);
	try {
		platform.publish('room', 'said', { n: 1 });
		platform.publish('room', 'said', { n: 2 });
		platform.publish('room', 'said', { n: 3 }, {});

		const seqs = srv.published.map((p) => JSON.parse(p.payload).seq);
		assert.deepEqual(seqs, [1, 2, 3]);
		assert.equal(
			maxAuthoritativeSeq.get('room'),
			undefined,
			'a counter seq is not cluster-authoritative, so it marks nothing'
		);
	} finally {
		reset();
	}
});

test('platform.publish with { seq: false } omits the field entirely', () => {
	const srv = fakeServer();
	setServer(srv);
	try {
		platform.publish('room', 'said', { n: 1 }, { seq: false });
		const envelope = JSON.parse(srv.published[0].payload);
		assert.equal('seq' in envelope, false, 'omitted, not null and not 0');
		// And the opt-out is per call: the next bare publish still stamps.
		platform.publish('room', 'said', { n: 2 });
		assert.equal(JSON.parse(srv.published[1].payload).seq, 1);
	} finally {
		reset();
	}
});

test('platform.publish with an explicit seq marks the topic authoritative', () => {
	const srv = fakeServer();
	setServer(srv);
	try {
		platform.publish('room', 'said', { n: 1 }, { seq: 5 });
		assert.equal(JSON.parse(srv.published[0].payload).seq, 5);
		assert.equal(maxAuthoritativeSeq.get('room'), 5);
	} finally {
		reset();
	}
});
