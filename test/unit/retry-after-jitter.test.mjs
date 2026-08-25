import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

// The refusal backoff arithmetic, pinned deterministically. The numbers are a
// family contract: svelte-adapter-uws decided them and this adapter answers
// the same ones, so every pin here is a pin against cross-adapter drift, not
// just against a local regression. The RNG is injected through the runtime
// seam because the property under test is the shape of the band - which
// values are reachable and which are not - and no number of real draws can
// prove an edge exists.

const { jitterRetryAfter, REFUSAL_RETRY_AFTER_SECONDS } = await import(
	'../../src/runtime/utils/upgrade-admission.js'
);
const { resetRuntimeEnv, setRuntimeEnv } = await import('../../src/runtime/runtime.js');

/** @param {number} r */
function withDraw(r) {
	setRuntimeEnv({ rng: { float: () => r } });
}

afterEach(() => resetRuntimeEnv());

test('the shared base is the one uws refuses with', () => {
	assert.equal(REFUSAL_RETRY_AFTER_SECONDS, 2);
});

test('the band floor is always the base, at every posture spread', () => {
	// uws's postures pass 0.5 (normal), 1.0 (elevated), 1.5 (siege). The
	// minimum a refused client is told to wait never moves with the posture.
	withDraw(0);
	for (const spread of [0.5, 1.0, 1.5]) {
		assert.equal(jitterRetryAfter(2, spread), 2);
		assert.equal(jitterRetryAfter(4, spread), 4);
	}
});

test('the top of each posture band matches the numbers uws recorded', () => {
	// Base 2: normal 2..3, elevated 2..3, siege 2..4. The two-value floor is
	// what makes normal a band at all - ceil(2 * 0.5) is 1, and a one-value
	// band is the constant the fleet used to herd on.
	withDraw(0.999);
	assert.equal(jitterRetryAfter(2, 0.5), 3);
	assert.equal(jitterRetryAfter(2, 1.0), 3);
	assert.equal(jitterRetryAfter(2, 1.5), 4);
});

test('above the floor the band still grows with the spread', () => {
	// At base 4 the floor no longer binds for the wider postures, and the
	// growth has to be monotone: a widened posture may never narrow the wait.
	withDraw(0.999);
	assert.equal(jitterRetryAfter(4, 0.5), 5);
	assert.equal(jitterRetryAfter(4, 1.0), 7);
	assert.equal(jitterRetryAfter(4, 1.5), 9);
});

test('a draw in the middle lands inside the band, not on an edge', () => {
	withDraw(0.5);
	assert.equal(jitterRetryAfter(2, 1.5), 3, 'floor(0.5 * 3) is 1');
});

test('an absent or unusable spread is the default half-base band', () => {
	// The callers here pass no spread today - this adapter has no posture
	// machine - so the default IS the shipped behaviour, and a nonsense value
	// must not turn the band into NaN arithmetic.
	withDraw(0.999);
	for (const spread of [undefined, 0, -1, NaN]) {
		assert.equal(jitterRetryAfter(2, spread), 3);
	}
});

test('every value in a band is reachable and nothing outside it is', () => {
	// Sweep the whole unit interval at base 2, siege spread: the answers must
	// cover exactly {2, 3, 4}. A band with an unreachable middle would spread
	// a fleet worse than the arithmetic promises.
	const seen = new Set();
	for (let r = 0; r < 1; r += 0.001) {
		withDraw(r);
		seen.add(jitterRetryAfter(2, 1.5));
	}
	assert.deepEqual([...seen].sort(), [2, 3, 4]);
});
