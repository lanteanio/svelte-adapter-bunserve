import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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


const { platform } = await import('../../src/runtime/handler/platform.js');
const {
	MAX_CONTROL_EGRESS_BYTES,
	MAX_SEQ_TOPICS,
	MAX_SUBSCRIPTIONS_PER_CONNECTION,
	SWEEP_LIMIT,
	evictOne,
	maxAuthoritativeSeq,
	notePublishedSeq,
	noteRecentlyUsed,
	processEpoch,
	resetProcessEpoch,
	resetTopicEpochs,
	topicEpochValue,
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
		assert.equal(stampSeqValue(Number.MAX_SAFE_INTEGER, 'room'), Number.MAX_SAFE_INTEGER, 'the top of the range passes through');
		assert.throws(() => stampSeqValue(2 ** 53, 'room'), /safe-integer range/, 'and one past it is refused, not rounded');
		assert.equal(stampSeqValue(undefined, 'room'), 1, 'the counter is untouched by the explicit lane');
	} finally {
		reset();
	}
});

test('the counter map warns on its own first eviction, and only once', () => {
	// The twin of the mark map's warning further down. Both are pinned because
	// the README and the CHANGELOG promise that EACH map warns for itself, and
	// a documented promise nothing asserts is one a refactor can delete while
	// the suite stays green.
	//
	// ORDERING CONSTRAINT: both latches are module-private and one-shot, so
	// this must be the first test here that evicts a counter - the bounded-map
	// test immediately below would otherwise spend the warning. The isolation
	// is per PROCESS, not per file: `node --test` runs one process per file
	// today, and --test-isolation=none would put every file's latches in one.
	const real = console.warn;
	/** @type {string[]} */
	const seen = [];
	console.warn = (/** @type {unknown} */ m) => seen.push(String(m));
	try {
		for (let i = 0; i <= MAX_SEQ_TOPICS; i++) stampSeqValue(undefined, `c:${i}`);
		assert.equal(seen.length, 1, 'the first eviction warns');
		assert.match(seen[0], /counter seq/, 'names the lane that fills this map');
		assert.match(seen[0], /backwards/, 'and what an evicted counter does to a client');
		for (let i = 0; i < 50; i++) stampSeqValue(undefined, `d:${i}`);
		assert.equal(seen.length, 1, 'and 50 more evictions add nothing');
	} finally {
		console.warn = real;
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

test('the bound and the sweep window are the numbers the docs state', () => {
	// The README and the CHANGELOG quote both figures, and prose cannot import
	// a constant. Changing either without changing them would leave those
	// documents quietly wrong with the whole suite green, so the literals are
	// pinned here rather than compared against the constants they measure -
	// every other test in this file uses the imported symbols, which is exactly
	// why nothing else would notice.
	assert.equal(SWEEP_LIMIT, 32);
	assert.equal(MAX_SEQ_TOPICS, 10_000);
	// Two bounds the README also quotes exist TWICE in source: once in the
	// DEFAULTS object and once as the `??` fallback beside the option read.
	// ws-options.test.mjs pins the DEFAULTS copy; these are the fallbacks,
	// pinned here because reaching them means loading ws-state.js, which this
	// file already does.
	//
	// WHICH COPY A SERVER ACTUALLY ENFORCES is the DEFAULTS one. The build
	// serializes the normalized options into the payload whenever there is a
	// WebSocket surface, and normalization derives these two from DEFAULTS
	// unconditionally, so both keys are present in every WS-enabled build and
	// the left side of each `??` wins. (Not a general rule about the injected
	// object: JSON.stringify drops an undefined-valued key, which is why one
	// build carries no `pressure` at all. It holds for these two because they
	// are always numbers.)
	//
	// A fallback resolves wherever its KEY is absent. This file reaches it the
	// blunt way, with WS_OPTIONS null at the top - the same shape as a build
	// with no WebSocket surface, where the bound gates nothing. A partial
	// WS_OPTIONS reaches it too, which is worth knowing before writing a test
	// that sets one and expects the documented number. Pinned anyway, because
	// two literals for one documented number drift apart silently and the
	// survivor of a refactor is whichever copy it keeps.
	assert.equal(MAX_SUBSCRIPTIONS_PER_CONNECTION, 65_536);
	assert.equal(MAX_CONTROL_EGRESS_BYTES, 4 * 1024 * 1024);
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
		assert.equal(seen.length, 1, 'the first eviction warns');
		assert.match(seen[0], /explicit seq/, 'names the lane that fills this map');
		assert.match(seen[0], /resume/, 'and the thing an evicted mark costs');
		for (let i = 0; i < 50; i++) notePublishedSeq(`more:${i}`, 1, true);
		assert.equal(seen.length, 1, 'and 50 more evictions add nothing');
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

// A SEQ THAT IS NOT ONE OF THE FOUR SPELLINGS. The rows above are what an app
// means to write; these are what it writes by accident, and they used to reach
// the counter lane through the same fallthrough that serves `{ seq: true }`.
// The counter is the one answer that is always wrong here: a '742' read off a
// JSON column was MEANT as the cluster seq, so drawing a local counter for it
// publishes a value from another sequence space, leaves the topic unmarked, and
// costs the client its resume dedup with nothing on the wire to notice it by.

test('a seq that is not a number, a boolean or null is refused by option name', () => {
	assert.throws(() => stampSeqValue('742', 'room'), /publish seq must be a positive integer number or bigint/);
	assert.throws(() => stampSeqValue({}, 'room'), /publish seq must be a positive integer number or bigint/);
	assert.throws(() => stampSeqValue([5], 'room'), /publish seq must be a positive integer number or bigint/);
	assert.throws(() => stampSeq({ seq: '742' }, 'room'), /publish seq must be a positive integer number or bigint/);
});

test('the refusal quotes the string it was given, so the log names the value', () => {
	assert.throws(
		() => stampSeqValue('742', 'room'),
		(err) => err instanceof TypeError && err.message.includes('"742"') && err.message.includes('room')
	);
});

test('a refused seq draws no counter value, so the topic is untouched', () => {
	try {
		assert.throws(() => stampSeqValue('742', 'quiet'));
		assert.equal(topicSeqs.has('quiet'), false, 'nothing was stamped for it');
		assert.equal(maxAuthoritativeSeq.has('quiet'), false, 'and nothing was marked');
	} finally {
		reset();
	}
});

test('null publishes without a seq, the way false does', () => {
	try {
		assert.equal(stampSeqValue(null, 'room'), null);
		assert.equal(topicSeqs.has('room'), false, 'and consumes no counter value');
	} finally {
		reset();
	}
});

test('platform.publish refuses a string seq instead of publishing a counter', () => {
	const srv = fakeServer();
	setServer(srv);
	try {
		assert.throws(
			() => platform.publish('room', 'said', { n: 1 }, { seq: '742' }),
			/publish seq must be a positive integer number or bigint/
		);
		assert.equal(srv.published.length, 0, 'refused before anything reached the socket');
	} finally {
		reset();
	}
});

test('platform.publish with { seq: null } sends the envelope without the field', () => {
	const srv = fakeServer();
	setServer(srv);
	try {
		platform.publish('room', 'said', { n: 1 }, { seq: null });
		const envelope = JSON.parse(srv.published[0].payload);
		assert.equal('seq' in envelope, false);
	} finally {
		reset();
	}
});

test('bigint is the second spelling of the explicit authority on every lane', () => {
	// One value, two spellings, so they cannot disagree about validity. A caller
	// reading an offset out of a store that hands back BigInt stops converting at
	// the call site, which is where the silent rounding used to happen.
	resetSeqState();
	try {
		assert.equal(stampSeqValue(7n, 'room'), 7, 'stamped as the number it projects to');
		assert.equal(stampSeq({ seq: 7n }, 'room'), 7, 'and through the options form');
		assert.equal(
			stampSeqValue(BigInt(Number.MAX_SAFE_INTEGER), 'room'),
			Number.MAX_SAFE_INTEGER,
			'the top of the range'
		);
		assert.throws(() => stampSeqValue(2n ** 53n, 'room'), /safe-integer range/);
		assert.throws(() => stampSeqValue(0n, 'room'), /positive integer number or bigint/);
		// The explicit lane, whichever spelling reached it, leaves the counter alone.
		assert.equal(stampSeqValue(undefined, 'room'), 1, 'the counter never advanced');
	} finally {
		resetSeqState();
	}
});

test('a batch-level bigint is refused exactly as a batch-level number is', () => {
	// One number cannot be the one-seq-per-entry publishWireBatch publishes, and
	// spelling it as a bigint does not make it N of them.
	resetSeqState();
	setServer({ publish: () => 0, subscriberCount: () => 0 });
	try {
		assert.throws(
			() => platform.publishWireBatch(
				'room', 'moved', [{ data: { x: 1 } }], { capability: 'x', schemaVersion: 1, encode: () => null },
				{ seq: 9n }
			),
			/one number cannot be the one-seq-per-entry/,
			'the bigint spelling reaches the same refusal'
		);
	} finally {
		resetSeqState();
		maxAuthoritativeSeq.clear();
	}
});

test('the send lanes carry an explicit gap-fill seq and draw no counter', () => {
	// A resume hook's only primitive for delivering replayed frames was
	// platform.send, and it emitted an envelope with no seq field at all - so a
	// hook could report "I delivered up to 22" while the client received nothing
	// it could key its next watermark off. The seq now rides the frame.
	resetSeqState();
	const sent = [];
	const ws = { getUserData: () => ({}), send: (p) => { sent.push(p); return 1; } };
	try {
		platform.send(ws, 'room', 'moved', { x: 1 }, { seq: 21 });
		assert.match(sent[0], /"seq":21/, 'the replayed frame carries its own seq');
		platform.send(ws, 'room', 'moved', { x: 2 }, { seq: 22n });
		assert.match(sent[1], /"seq":22/, 'bigint is the same authority');

		// Absent, false and null are the historical shape, byte-identical.
		platform.send(ws, 'room', 'moved', { x: 3 });
		platform.send(ws, 'room', 'moved', { x: 3 }, { seq: false });
		platform.send(ws, 'room', 'moved', { x: 3 }, { seq: null });
		assert.equal(sent[2].includes('"seq"'), false, 'absent stamps nothing');
		assert.deepEqual([sent[3], sent[4]], [sent[2], sent[2]], 'false and null match it exactly');

		// `true` has no meaning here: gap-fill replays history that is ALREADY
		// accounted, so there is no counter for this lane to draw.
		assert.throws(() => platform.send(ws, 'room', 'moved', {}, { seq: true }),
			/never draw the in-memory counter/);
		assert.throws(() => platform.send(ws, 'room', 'moved', {}, { seq: '21' }),
			/must be an explicit positive integer number or bigint/);
		assert.throws(() => platform.send(ws, 'room', 'moved', {}, { seq: 2 ** 53 }),
			/safe-integer range/);

		// The whole point of the lane: it touches no shared state.
		assert.equal(topicSeqs.get('room'), undefined, 'no counter advanced');
		assert.equal(maxAuthoritativeSeq.get('room'), undefined, 'and no topic was marked');
	} finally {
		resetSeqState();
		maxAuthoritativeSeq.clear();
	}
});

test('an invalid send seq is refused whatever the socket is doing', () => {
	// The refusal is about the CALL, not the connection, so it resolves before
	// the freed-handle guard - a closed socket must not turn a caller's bug into
	// a silent DROPPED.
	const dead = { getUserData: () => { throw new Error('freed'); }, send: () => { throw new Error('freed'); } };
	assert.throws(() => platform.send(dead, 'room', 'moved', {}, { seq: '9' }), TypeError);
	assert.throws(() => platform.sendWire(dead, 'room', 'moved', {}, { capability: 'x', schemaVersion: 1, encode: () => null }, { seq: true }), TypeError);
});

test('the generation token is one lazily-latched draw in the u32 domain', () => {
	// The family contract: an OPAQUE per-process generation token, equality-only,
	// never a timestamp. Both adapters draw a random uint32, so a client written
	// against one reads the other unchanged - and a boot-time value would have
	// handed every unauthenticated client the process start time.
	resetProcessEpoch();
	const first = processEpoch();
	assert.ok(Number.isInteger(first) && first >= 0 && first <= 0xffffffff,
		`inside the u32 domain: ${first}`);
	assert.equal(processEpoch(), first, 'latched: every read of one process agrees');

	// LAZY, not at module import. A simulation that seeds the RNG has to be able
	// to latch a reproducible value afterwards, which an import-time draw has
	// already spent bytes ahead of.
	resetProcessEpoch();
	assert.equal(processEpoch(), processEpoch(), 're-latched once on first read');

	// A harness may pin a specific generation, squeezed into the same domain, so
	// an epoch-ms input cannot smuggle a wider value onto the wire.
	resetProcessEpoch(7);
	assert.equal(processEpoch(), 7);
	resetProcessEpoch(1700000000000);
	assert.equal(processEpoch(), 1700000000000 >>> 0, 'squeezed into u32, not carried whole');
	assert.ok(processEpoch() <= 0xffffffff);
	resetProcessEpoch();
});

test('the subscribed ack is the single emit site for the generation token', () => {
	// One latch, one field. A second source would let two acks on one connection
	// disagree about the seq space, which is the one thing the token is for.
	const src = readFileSync(new URL('../../src/runtime/handler/ws.js', import.meta.url), 'utf8');
	const emits = src.match(/topicEpochValue\(|processEpoch\(/g) || [];
	assert.equal(emits.length, 1, 'exactly one emit site in the demux');
	assert.match(src, /subscribedFrame\(topic, ref, topicEpochValue\(topic\)\)/,
		'and it is the subscribed ack, reading the topic-layered authority');
	// Nothing anywhere interprets the value beyond equality: no date rendering,
	// no ordering, no arithmetic on it.
	for (const file of ['../../src/runtime/handler/ws.js', '../../src/runtime/handler/ws-state.js']) {
		const text = readFileSync(new URL(file, import.meta.url), 'utf8');
		assert.doesNotMatch(text, /new Date\((?:[A-Za-z_$][\w$]*)?[Ee]poch/,
			`${file} does not render the token as a date`);
	}
});

test('a topic epoch is the process generation until something mints one', () => {
	resetProcessEpoch();
	resetTopicEpochs();
	try {
		const base = processEpoch();
		assert.equal(topicEpochValue('room:1'), base, 'no override: the process generation');
		assert.equal(topicEpochValue('room:2'), base, 'one token describes every counter');

		// The explicit-seq lane is single-authority per topic. An app that
		// CHANGES a topic's authority has to repudiate the offsets clients
		// recorded under the old one, because the max-seen mark is monotone and
		// no seq carries the identity of the counter that issued it.
		const minted = platform.bumpTopicEpoch('room:1');
		assert.notEqual(minted, base, 'a mint that equals what it replaces repudiates nothing');
		assert.equal(topicEpochValue('room:1'), minted, 'the override is what the topic reads');
		assert.equal(platform.topicEpoch('room:1'), minted, 'and the platform agrees');
		assert.equal(topicEpochValue('room:2'), base, 'other topics are untouched');
		assert.ok(minted >= 0 && minted <= 0xffffffff, 'still inside the u32 domain');

		// Bumping again re-rolls off the CURRENT value, not the process one.
		const second = platform.bumpTopicEpoch('room:1');
		assert.notEqual(second, minted);
		assert.equal(topicEpochValue('room:1'), second);
	} finally {
		resetTopicEpochs();
		resetProcessEpoch();
	}
});

test('the topic-epoch override map is bounded and evicts the least recently minted', () => {
	// Authority changes are rare, but nothing grows without a ceiling: a topic
	// namespace is client-named, so an unbounded map is an unbounded map.
	resetProcessEpoch();
	resetTopicEpochs();
	try {
		const base = processEpoch();
		const CAP = 4096;
		for (let i = 0; i < CAP; i++) platform.bumpTopicEpoch('t' + i);
		assert.notEqual(topicEpochValue('t0'), base, 'the first override is still held at the cap');

		// Refresh t0's recency, then push one past the cap: the victim must be
		// the longest-undisturbed entry (t1), never the one just re-minted.
		platform.bumpTopicEpoch('t0');
		platform.bumpTopicEpoch('overflow');
		assert.notEqual(topicEpochValue('t0'), base, 're-minting refreshed its recency');
		assert.equal(topicEpochValue('t1'), base, 'the longest-undisturbed override was dropped');
		assert.notEqual(topicEpochValue('overflow'), base);

		// A dropped override degrades to the process generation rather than to
		// anything invented.
		assert.equal(topicEpochValue('t1'), processEpoch());
	} finally {
		resetTopicEpochs();
		resetProcessEpoch();
	}
});
