import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogThrottle, shouldLogOccurrence } from '../../src/runtime/utils/log-throttle.js';

test('the first nine occurrences all log', () => {
	// A real fault must be visible immediately, not after a threshold.
	for (let i = 1; i < 10; i++) {
		assert.equal(shouldLogOccurrence(i), true, `occurrence ${i}`);
	}
});

test('after that only powers of ten log', () => {
	assert.equal(shouldLogOccurrence(10), true);
	assert.equal(shouldLogOccurrence(11), false);
	assert.equal(shouldLogOccurrence(99), false);
	assert.equal(shouldLogOccurrence(100), true);
	assert.equal(shouldLogOccurrence(101), false);
	assert.equal(shouldLogOccurrence(1000), true);
	assert.equal(shouldLogOccurrence(1_000_000), true);
});

test('the volume is logarithmic in the attacker effort', () => {
	// The point of the throttle: a client looping a frame that makes the app's
	// hook throw must not be able to drive stderr linearly.
	let logged = 0;
	for (let i = 1; i <= 100_000; i++) if (shouldLogOccurrence(i)) logged++;
	assert.equal(logged, 14, '9 singles + 10/100/1k/10k/100k');
});

test('a nonsense count never logs', () => {
	assert.equal(shouldLogOccurrence(0), false);
	assert.equal(shouldLogOccurrence(-1), false);
	assert.equal(shouldLogOccurrence(NaN), false);
	assert.equal(shouldLogOccurrence(Infinity), false);
});

test('the throttle decays, so an ongoing problem stays visible', () => {
	// A monotonic counter that never resets is evidence suppression: ~100k cheap
	// frames push the next log line out to occurrence 1,000,000, and the
	// counters are per-category, so one attacker silences the category for every
	// other connection.
	let now = 0;
	const throttle = createLogThrottle(() => now);
	let logged = 0;
	for (let i = 0; i < 100_000; i++) if (throttle().log) logged++;
	assert.equal(logged, 14, 'a burst still collapses');

	// A quiet minute, then the same problem recurs.
	now += 61_000;
	assert.equal(throttle().log, true, 'the schedule restarts');
	assert.equal(throttle().log, true);
});

test('the decay does not fire inside a sustained burst', () => {
	let now = 0;
	const throttle = createLogThrottle(() => now);
	let logged = 0;
	for (let i = 0; i < 1000; i++) {
		now += 50; // 50ms apart: sustained, never quiet for a minute
		if (throttle().log) logged++;
	}
	assert.equal(logged, 12, '9 singles + 10 + 100 + 1000');
});
