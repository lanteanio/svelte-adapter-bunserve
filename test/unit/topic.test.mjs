import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemTopic } from '../../src/runtime/utils/topic.js';

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
