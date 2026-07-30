import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createByteBudget } from '../../src/runtime/utils/egress-budget.js';

/** A clock the test drives by hand. */
function fakeClock(start = 0) {
	let now = start;
	const clock = () => now;
	clock.advance = (ms) => {
		now += ms;
	};
	return clock;
}

test('a budget grants up to and including its limit, then refuses', () => {
	const clock = fakeClock();
	const charge = createByteBudget(100, 1000, clock);
	assert.equal(charge(60), true);
	// Exactly the allowance is still within it.
	assert.equal(charge(40), true);
	assert.equal(charge(1), false);
});

test('a single charge larger than the whole window is refused', () => {
	const charge = createByteBudget(100, 1000, fakeClock());
	assert.equal(charge(101), false);
});

test('a refused charge still counts, so smaller retries cannot walk past the limit', () => {
	const charge = createByteBudget(100, 1000, fakeClock());
	assert.equal(charge(200), false);
	// Were the refused 200 not recorded, this would read as 1 of 100 and pass.
	assert.equal(charge(1), false);
});

test('the window restarts once it has elapsed', () => {
	const clock = fakeClock();
	const charge = createByteBudget(100, 1000, clock);
	assert.equal(charge(100), true);
	assert.equal(charge(1), false);
	clock.advance(1001);
	assert.equal(charge(100), true);
});

test('the window does not restart at exactly its length', () => {
	const clock = fakeClock();
	const charge = createByteBudget(100, 1000, clock);
	assert.equal(charge(100), true);
	// A window is over when it has been EXCEEDED. Restarting at exactly the
	// boundary would hand out two full allowances in one window's worth of time
	// to a client that paces its frames on the window length.
	clock.advance(1000);
	assert.equal(charge(1), false);
	clock.advance(1);
	assert.equal(charge(1), true);
});

test('the first charge opens a window rather than inheriting one', () => {
	const clock = fakeClock(5_000_000);
	const charge = createByteBudget(100, 1000, clock);
	assert.equal(charge(100), true);
	assert.equal(charge(1), false);
});

test('budgets are independent of one another', () => {
	const clock = fakeClock();
	const a = createByteBudget(100, 1000, clock);
	const b = createByteBudget(100, 1000, clock);
	assert.equal(a(100), true);
	assert.equal(a(1), false);
	assert.equal(b(100), true);
});
