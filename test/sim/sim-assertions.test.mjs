import { test } from 'node:test';
import assert from 'node:assert/strict';

// A framework assertion that fires during a run is a violation of that run, even
// when a boundary contains it - the upgrade's catch, an app hook's - and the
// throw never reaches the scheduler. Without that, a golden corpus could verify
// clean over a run that broke an invariant, because nothing it fingerprints
// would have moved.

const { runSim } = await import('../../src/sim.js');
const { WS_COALESCED, adjustTotalSubscriptions } = await import('../../src/runtime/handler/ws-state.js');
const { flushCoalescedFor } = await import('../../src/runtime/handler/coalesced.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');

test('a contained framework assertion is recorded as a violation of the run', async () => {
	const result = await runSim({
		clients: 0,
		scenario: async (api) => {
			// Contained here, the way a hook boundary contains a throw: nothing
			// reaches the scheduler, and the run carries on.
			try {
				adjustTotalSubscriptions(-1);
			} catch {
				// test mode throws; the count has already moved
			}
			await api.advance();
		}
	});
	assert.deepEqual(result.schedulerUncaught, [], 'the throw was contained');
	assert.deepEqual(
		result.invariantViolations.filter((v) => v.category === 'subs.total-negative'),
		[{ category: 'subs.total-negative', context: { assertions: 1 } }]
	);
});

test('several categories are recorded by name, not in the order the process first saw them', async () => {
	// This run fires `subs.total-negative` first, so the process-wide counts
	// Map lists it first, as it would after any earlier seed that fired it. The
	// run must still record the two in name order, or the same seed would
	// record a different list in a swarm than replayed alone.
	const raw = {
		data: { [WS_COALESCED]: { size: 1 } },
		readyState: 1,
		send: () => 1,
		getBufferedAmount: () => 0
	};
	const result = await runSim({
		clients: 0,
		scenario: async (api) => {
			for (const fire of [() => adjustTotalSubscriptions(-1), () => flushCoalescedFor(wsFacade(raw))]) {
				try {
					fire();
				} catch {
					// contained, as before
				}
			}
			await api.advance();
		}
	});
	assert.deepEqual(result.invariantViolations, [
		{ category: 'coalesce.pending-type', context: { assertions: 1 } },
		{ category: 'subs.total-negative', context: { assertions: 1 } }
	]);
});

test('a run that trips nothing records nothing from the assertions', async () => {
	const result = await runSim({ clients: 2 });
	assert.deepEqual(result.schedulerUncaught, []);
	assert.deepEqual(result.invariantViolations, []);
});

test('framework assertions during handler installation belong to the run', async () => {
	const { assert: frameworkAssert } = await import('../../src/runtime/utils/assertions.js');
	const result = await runSim({
		clients: 0,
		handler: {
			get open() {
				try { frameworkAssert(false, 'sim.initialization'); } catch {}
				return undefined;
			}
		}
	});
	assert.deepEqual(result.invariantViolations, [
		{ category: 'sim.initialization', context: { assertions: 1 } }
	]);
});
