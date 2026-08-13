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
const {
	MAX_SEQ_TOPICS,
	SWEEP_LIMIT,
	evictOne,
	maxAuthoritativeSeq,
	notePublishedSeq,
	noteRecentlyUsed,
	resetSeqState,
	setServer,
	stampSeq,
	stampSeqValue,
	topicSeqs,
	topicSeqsRecent
} = await import('../../src/runtime/handler/ws-state.js');

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
	// Through the module's own reset, so the private recency flags go too. A
	// flag surviving into the next test spares a re-created topic an eviction
	// it never earned, which is a test-order dependency that only appears once
	// a test has filled a map to its cap.
	resetSeqState();
}

/**
 * A small stand-in for one of the bounded seq maps, so eviction ORDER can be
 * asserted over a full lap without filling ten thousand entries per round.
 *
 * @param {string[]} keys - in insertion order
 * @param {string[]} [used] - keys flagged as touched since the last sweep
 */
function queue(keys, used = []) {
	const map = new Map(keys.map((k, i) => [k, i + 1]));
	return { map, recent: new Set(used) };
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

test('the counter map is bounded, and a quiet topic is what an eviction reaches for', () => {
	// The counter is now the DEFAULT, so this map is reached by every publish
	// and its bound is what keeps an app publishing to client-named topics
	// (room:<uuid>) from growing one entry per topic for the life of the
	// process. Eviction is second-chance rather than exact LRU - keeping the
	// map in use order costs an order of magnitude per stamp at this size -
	// so what is pinned here is the property that actually matters: a topic
	// touched since the last sweep outlives topics that were not. Its limit -
	// an examined window with no quiet entry in it - is the next test.
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

test('at the cap, a uniformly hot front evicts an ACTIVE topic and its counter restarts at 1', () => {
	// The limit of the guarantee above, driven through the live map because it
	// is what an operator is told to expect. One eviction examines at most
	// SWEEP_LIMIT entries; where every one of them was published to since the
	// last sweep there is no quiet victim within reach and the oldest of them
	// goes anyway. The user-visible harm is the last assertion: a topic being
	// published to right now restarts at seq 1, so a client holding an older
	// seq for it sees the number go backwards.
	//
	// Scanning past the window to avoid this is the unbounded sweep the limit
	// exists to prevent, and a working set genuinely larger than the cap has no
	// quiet topic to evict at all. Both eviction warnings, the README and
	// evictOne's own comment state this case; this is what holds them to it.
	try {
		for (let i = 0; i < MAX_SEQ_TOPICS; i++) stampSeqValue(undefined, `t:${i}`);
		// Exactly the window, and the OLDEST entries: these are the ones an
		// eviction reaches first, and they are all in use.
		for (let i = 0; i < SWEEP_LIMIT; i++) {
			assert.equal(stampSeqValue(undefined, `t:${i}`), 2, `t:${i} is stamped again`);
		}
		assert.equal(topicSeqsRecent.size, SWEEP_LIMIT, 'the whole window is flagged');

		stampSeqValue(undefined, 'fresh');

		assert.equal(topicSeqs.size, MAX_SEQ_TOPICS, 'still exactly the cap');
		assert.equal(topicSeqs.has('t:0'), false, 'the oldest of the hot window went, though it was in use');
		for (let i = 1; i < SWEEP_LIMIT; i++) {
			assert.equal(topicSeqs.get(`t:${i}`), 2, `t:${i} was spared with its counter intact`);
		}
		assert.equal([...topicSeqs.keys()][0], `t:${SWEEP_LIMIT}`, 'the window was requeued behind the rest');
		assert.equal(topicSeqsRecent.size, 0, 'and every flag the sweep examined was spent');

		assert.equal(stampSeqValue(undefined, 't:0'), 1, 'an ACTIVE topic restarted its counter');
	} finally {
		reset();
	}
});

test('an untouched entry at the front is what an eviction takes', () => {
	const { map, recent } = queue(['a', 'b', 'c']);
	evictOne(map, recent);
	assert.deepEqual([...map.keys()], ['b', 'c']);
});

test('a touched entry is spared, moved to the back, and has spent its flag', () => {
	// Moving it is the load-bearing half. Left where it is, it comes up again
	// on the very NEXT eviction with its flag already spent, so being
	// published to buys a reprieve of exactly one round.
	const { map, recent } = queue(['a', 'b', 'c'], ['a']);
	evictOne(map, recent);
	assert.deepEqual([...map.keys()], ['c', 'a'], 'b went; a moved to the back');
	assert.equal(recent.has('a'), false, 'and the flag it was spared by is spent');
});

test('a topic touched once survives a full lap of evictions', () => {
	// The property the whole scheme exists for, stated over rounds rather than
	// over one call: a topic still being published to outlives the quiet ones
	// ahead of it, not merely the next one in line.
	const { map, recent } = queue(['a', 'b', 'c', 'd', 'e'], ['a']);
	for (let i = 0; i < 4; i++) evictOne(map, recent);
	assert.deepEqual([...map.keys()], ['a'], 'the touched one is the last standing');
});

test('a sweep where everything is in use still evicts, and takes the oldest it saw', () => {
	// Otherwise an insert into a fully hot map adds without removing, and the
	// bound this whole structure exists for stops holding.
	const { map, recent } = queue(['a', 'b', 'c'], ['a', 'b', 'c']);
	evictOne(map, recent);
	assert.equal(map.size, 2, 'something was evicted');
	assert.deepEqual([...map.keys()], ['b', 'c'], 'the oldest of the hot entries went, the rest keep their order');
	assert.deepEqual([...recent], [], 'every flag examined was spent');
});

test('an empty queue is not something an eviction can trip over', () => {
	const { map, recent } = queue([]);
	evictOne(map, recent);
	assert.equal(map.size, 0);
});

test('the sweep window is 32, which is the number the docs state', () => {
	// The README and the CHANGELOG both quote this figure, and prose cannot
	// import a constant. Changing SWEEP_LIMIT without changing them would leave
	// two documents quietly wrong with the whole suite green, so the literal is
	// pinned here rather than compared against the constant it is measuring.
	assert.equal(SWEEP_LIMIT, 32);
});

test('the mark map warns on its own first eviction, and only once', () => {
	// Each map warns for itself, which is what the README says and what an
	// operator needs: the counter warning cannot serve here, because a lost
	// mark costs a resume dedup floor rather than a restarted number, and
	// { seq: false } is no remedy for a map only an explicit seq can fill.
	// The latch is module-level and one-shot, so this is the only test in this
	// file that fills the mark map - anything earlier would spend the warning.
	const real = console.warn;
	/** @type {string[]} */
	const seen = [];
	console.warn = (/** @type {unknown} */ m) => seen.push(String(m));
	try {
		for (let i = 0; i <= MAX_SEQ_TOPICS; i++) notePublishedSeq(`m:${i}`, i + 1, true);
		assert.equal(seen.length, 1, 'one warning, however many topics arrive');
		assert.match(seen[0], /explicit seq/, 'names the lane that fills this map');
		assert.match(seen[0], /resume/, 'and the thing an evicted mark costs');
		for (let i = 0; i < 50; i++) notePublishedSeq(`more:${i}`, 1, true);
		assert.equal(seen.length, 1, 'and it does not repeat');
	} finally {
		console.warn = real;
		reset();
	}
});

test('one eviction examines a bounded window, however hot the queue is', () => {
	// Without the bound, a single insert into a map where everything is in use
	// does work proportional to the whole map - and it would do it on every
	// insert, since the requeue keeps the flags coming.
	const keys = Array.from({ length: SWEEP_LIMIT + 40 }, (_, i) => `k${i}`);
	const { map, recent } = queue(keys, keys);
	evictOne(map, recent);
	assert.equal(map.has('k0'), false, 'the oldest of the examined window went');
	assert.equal(
		[...map.keys()][0],
		`k${SWEEP_LIMIT}`,
		'and only the window was requeued - the first entry past it is now at the front'
	);
	assert.equal(recent.size, keys.length - SWEEP_LIMIT, 'flags outside the window are untouched');
});

test('the recency flag is only set while something can be evicted', () => {
	// Below the cap nothing is ever evicted, so a flag there is pure cost on
	// the hottest primitive in the adapter.
	try {
		for (let i = 0; i < 50; i++) stampSeqValue(undefined, `t:${i}`);
		for (let i = 0; i < 50; i++) stampSeqValue(undefined, `t:${i}`);
		assert.equal(topicSeqsRecent.size, 0, 'no flags below the cap');
	} finally {
		reset();
	}
});

test('a flag set at its bound is dropped only when a NEW key would grow it', () => {
	// Re-flagging a key already in the set cannot grow it, so clearing there
	// would throw away every earned flag for nothing - and the next eviction
	// would take a topic published to moments earlier.
	const recent = new Set();
	for (let i = 0; i < MAX_SEQ_TOPICS; i++) recent.add(`k${i}`);
	noteRecentlyUsed(recent, 'k0');
	assert.equal(recent.size, MAX_SEQ_TOPICS, 'a key already flagged keeps the set intact');
	noteRecentlyUsed(recent, 'brand-new');
	assert.equal(recent.size, 1, 'a key that would grow it past the bound resets it');
	assert.deepEqual([...recent], ['brand-new']);
});

test('the seq reset clears the recency flags, not just the maps', () => {
	// A flag surviving a reset spares a re-created topic an eviction it never
	// earned, which is a determinism hazard and a test-order dependency.
	try {
		topicSeqsRecent.add('ghost');
		stampSeqValue(undefined, 'ghost');
		resetSeqState();
		assert.equal(topicSeqs.size, 0);
		assert.equal(topicSeqsRecent.size, 0);
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
	// The three-argument arity is the one an app reaches for first, and it was
	// executed nowhere: every fixture and test site passed an options object,
	// so the default had no coverage in either direction.
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
