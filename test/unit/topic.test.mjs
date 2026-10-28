import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemTopic, isValidWireTopic } from '../../src/runtime/utils/topic.js';

test('the system namespace is exactly a double underscore prefix', () => {
	assert.equal(isSystemTopic('__presence:room1'), true);
	assert.equal(isSystemTopic('__'), true);
	assert.equal(isSystemTopic('__x'), true);
	assert.equal(isSystemTopic('_presence'), false);
	assert.equal(isSystemTopic('_'), false);
	assert.equal(isSystemTopic(''), false);
	assert.equal(isSystemTopic('room:__presence'), false);
	assert.equal(isSystemTopic('x__'), false);
});

test('a one-character topic does not read past its end', () => {
	// charCodeAt(1) is NaN here. An `>= 95` style test, or one that coerced,
	// would claim this topic for the adapter namespace and refuse a legitimate
	// subscribe to "_".
	assert.equal(isSystemTopic('_'), false);
});

test('__proto__ is a system topic like any other double-underscore name', () => {
	// It reaches the batch verdict map as a key that cannot exist, so the
	// guard being true here is what keeps it off the wire path entirely.
	assert.equal(isSystemTopic('__proto__'), true);
});

test('non-ASCII wire topics require paired UTF-16 surrogates', () => {
	for (const value of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
		for (const suffix of ['', 'x']) assert.equal(isValidWireTopic('room-' + String.fromCharCode(value) + suffix, true), false);
	}
	assert.equal(isValidWireTopic('room-' + String.fromCodePoint(0x1f680), true), true);
	assert.equal(isValidWireTopic('room-' + String.fromCodePoint(0x1f680), false), false);
});

test('Unicode topic boundaries use paired surrogates and UTF-16 unit lengths', () => {
	const high = String.fromCharCode(0xd83d);
	const low = String.fromCharCode(0xde00);
	const pair = high + low;
	for (const topic of [high + 'chat', low + 'chat', 'chat:' + high + high, 'chat:' + low + high]) {
		assert.equal(isValidWireTopic(topic, true), false);
	}
	assert.equal(isValidWireTopic(pair, true), true);
	assert.equal(isValidWireTopic(pair.repeat(128), true), true);
	assert.equal(isValidWireTopic(pair.repeat(129), true), false);
	assert.equal(isValidWireTopic(high), false);
	assert.equal(isValidWireTopic(pair), false);
});
