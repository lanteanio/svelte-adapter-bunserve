import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainCoalesced } from '../../src/runtime/utils/backpressure.js';

for (const result of [0, 2]) {
	test(`a replacement made during send survives result ${result}`, () => {
		const old = {}, latest = {};
		const pending = new Map([['key', old]]);
		let calls = 0;
		drainCoalesced(pending, (value, key) => {
			assert.equal(value, old);
			assert.equal(key, 'key');
			calls++;
			pending.set(key, latest);
			return result;
		});
		assert.equal(calls, 1);
		assert.equal(pending.get('key'), latest);
	});
}

test('a superseded value gets one immediate retry before yielding', () => {
	const pending = new Map([['key', 0]]);
	const seen = [];
	assert.equal(drainCoalesced(pending, (value, key) => {
		seen.push(value);
		pending.set(key, value + 1);
		return 1;
	}), true);
	assert.deepEqual(seen, [0, 1]);
	assert.equal(pending.get('key'), 2);
	drainCoalesced(pending, (value) => { seen.push(value); return 1; });
	assert.deepEqual(seen, [0, 1, 2]);
	assert.equal(pending.size, 0);
});

test('new keys added while draining share a finite pass budget', () => {
	const pending = new Map([[0, 0]]);
	const seen = [];
	assert.equal(drainCoalesced(pending, (value) => {
		seen.push(value);
		pending.set(value + 1, value + 1);
		return 1;
	}), true);
	assert.deepEqual(seen, [0, 1]);
	assert.deepEqual([...pending], [[2, 2]]);
});

test('nested drains cannot re-enter an active ancestor queue', () => {
	const first = new Map([['a', 1]]), second = new Map([['b', 2]]);
	const seen = [];
	drainCoalesced(first, (value) => {
		seen.push(value);
		drainCoalesced(second, (other) => {
			seen.push(other);
			drainCoalesced(first, () => { throw new Error('ancestor re-entered'); });
			return 1;
		});
		return 1;
	});
	assert.deepEqual(seen, [1, 2]);
	assert.equal(first.size + second.size, 0);
});

test('a throwing drain callback releases its re-entry guard', () => {
	const pending = new Map([['key', NaN]]);
	const failure = new Error('callback');
	assert.throws(() => drainCoalesced(pending, () => { throw failure; }), (err) => err === failure);
	drainCoalesced(pending, () => 1);
	assert.equal(pending.size, 0, 'Object.is also recognizes an unchanged NaN');
});
