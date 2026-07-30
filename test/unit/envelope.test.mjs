import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelopePrefix, completeEnvelope } from '../../src/runtime/utils/envelope.js';
import {
	esc,
	isValidWireTopic,
	createScopedTopic,
	createTopicHelperCache
} from '../../src/runtime/utils/topic.js';

test('an envelope is valid JSON the client can parse', () => {
	const frame = completeEnvelope(buildEnvelopePrefix('chat', 'created'), { text: 'hi' });
	assert.equal(frame, '{"topic":"chat","event":"created","data":{"text":"hi"}}');
	assert.deepEqual(JSON.parse(frame), { topic: 'chat', event: 'created', data: { text: 'hi' } });
});

test('seq and jitter are appended in the documented order', () => {
	const prefix = buildEnvelopePrefix('t', 'e');
	assert.equal(completeEnvelope(prefix, 1, 7), '{"topic":"t","event":"e","data":1,"seq":7}');
	assert.equal(completeEnvelope(prefix, 1, null, 50), '{"topic":"t","event":"e","data":1,"j":50}');
	assert.equal(completeEnvelope(prefix, 1, 7, 50), '{"topic":"t","event":"e","data":1,"seq":7,"j":50}');
});

test('undefined data becomes null rather than the string "undefined"', () => {
	// JSON.stringify(undefined) is undefined, which would concatenate as the
	// literal text "undefined" and break every client-side JSON.parse.
	const frame = completeEnvelope(buildEnvelopePrefix('t', 'e'), undefined);
	assert.equal(frame, '{"topic":"t","event":"e","data":null}');
	assert.doesNotThrow(() => JSON.parse(frame));
});

test('data needing escapes is serialized by JSON.stringify, not concatenated raw', () => {
	const frame = completeEnvelope(buildEnvelopePrefix('t', 'e'), 'he said "hi"\\');
	assert.deepEqual(JSON.parse(frame).data, 'he said "hi"\\');
});

test('a zero-length envelope is impossible - every frame carries its prefix', () => {
	// The send sites assert non-empty because a zero-length frame is
	// unrecoverable framing corruption on the wire.
	assert.ok(completeEnvelope(buildEnvelopePrefix('t', 'e'), null).length > 0);
});

test('esc rejects the characters that would corrupt a frame', () => {
	assert.equal(esc('chat'), '"chat"');
	assert.throws(() => esc('ch"at'), /invalid character at index 2/);
	assert.throws(() => esc('ch\\at'), /invalid character/);
	assert.throws(() => esc('ch\nat'), /invalid character/);
});

test('the wire accept check and the envelope writer reject the same set', () => {
	// Lockstep invariant: anything isValidWireTopic accepts must be safe to
	// embed later, or a subscribe could plant a topic that corrupts every
	// subsequent publish to it.
	for (const candidate of ['a"b', 'a\\b', 'a\nb']) {
		assert.equal(isValidWireTopic(candidate, true), false);
		assert.throws(() => esc(candidate));
	}
	for (const candidate of ['chat', 'room:1', 'a-b_c.d', '__system', 'a b']) {
		assert.equal(isValidWireTopic(candidate, false), true);
		assert.doesNotThrow(() => esc(candidate));
	}
});

test('topic length and emptiness bounds', () => {
	assert.equal(isValidWireTopic('', false), false);
	assert.equal(isValidWireTopic('a'.repeat(256), false), true);
	assert.equal(isValidWireTopic('a'.repeat(257), false), false);
	assert.equal(isValidWireTopic(null, false), false);
	assert.equal(isValidWireTopic(42, false), false);
});

test('non-ASCII topics are rejected unless explicitly allowed', () => {
	// U+2028, U+202E and U+FEFF survive the wire intact and then surprise
	// whatever renders a topic name back to a human. Built with fromCharCode
	// rather than written literally: this file stays plain ASCII, and the
	// invisible ones would be unreviewable as raw source bytes.
	const candidates = [
		'caf' + String.fromCharCode(0xe9),       // e-acute, an ordinary letter
		'a' + String.fromCharCode(0x2028) + 'b', // line separator
		'a' + String.fromCharCode(0x202e) + 'b', // right-to-left override
		'a' + String.fromCharCode(0xfeff) + 'b'  // byte-order mark
	];
	for (const candidate of candidates) {
		assert.equal(isValidWireTopic(candidate, false), false);
		assert.equal(isValidWireTopic(candidate, true), true);
	}
});

test('scoped topic helpers bind the topic and forward the event name', () => {
	/** @type {any[]} */
	const calls = [];
	const t = createScopedTopic((topic, event, data) => calls.push([topic, event, data]), 'chat');
	t.created({ id: 1 });
	t.updated({ id: 2 });
	t.deleted({ id: 3 });
	t.set(9);
	t.increment();
	t.decrement(5);
	t.publish('custom', 'x');
	assert.deepEqual(calls, [
		['chat', 'created', { id: 1 }],
		['chat', 'updated', { id: 2 }],
		['chat', 'deleted', { id: 3 }],
		['chat', 'set', 9],
		['chat', 'increment', 1],
		['chat', 'decrement', 5],
		['chat', 'custom', 'x']
	]);
});

test('the helper cache returns one stable object per topic', () => {
	const cache = createTopicHelperCache(() => {});
	assert.equal(cache('chat'), cache('chat'));
	assert.notEqual(cache('chat'), cache('other'));
});

test('the helper cache evicts least-recently-used past its cap', () => {
	const cache = createTopicHelperCache(() => {}, 2);
	const a = cache('a');
	const b = cache('b');
	cache('a'); // 'a' becomes most-recent, so 'b' is the eviction candidate
	cache('c'); // over cap: evicts 'b'
	assert.equal(cache('a'), a, 'recently used entry survived');
	assert.notEqual(cache('b'), b, 'least-recently-used entry was evicted and rebuilt');
});

test('two caches bound to different publishers never share helpers', () => {
	// Module-global caching keyed on name alone would hand one server's helper
	// to another server's topic.
	/** @type {string[]} */
	const first = [];
	/** @type {string[]} */
	const second = [];
	const a = createTopicHelperCache((t, e) => first.push(t + '/' + e));
	const b = createTopicHelperCache((t, e) => second.push(t + '/' + e));
	a('chat').created(null);
	b('chat').created(null);
	assert.deepEqual(first, ['chat/created']);
	assert.deepEqual(second, ['chat/created']);
});
