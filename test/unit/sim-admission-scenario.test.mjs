import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// WHAT THE COMMITTED ADMISSION CORPUS ACTUALLY DRIVES.
//
// The corpus is forty fingerprints, and a fingerprint says a run did the same
// thing as last time - not that it did anything worth doing. A scenario that
// quietly stopped producing refused sockets would keep matching its corpus
// forever, and the gate would go on reporting forty green seeds over a workload
// that had become a plain connect-and-publish.
//
// So the outcomes are asserted directly. Each of the three is a distinct branch
// of the upgrade path, and the reason the corpus exists at all:
//
//   - a socket the app closed from inside `open`, whose close callback runs
//     before `srv.upgrade()` has returned;
//   - a client that left while the app's `upgrade` hook still had it;
//   - a handshake the ceiling refused outright.
//
// The server here is the corpus's own, so what this file measures is the
// workload the gate runs - not a nearby one.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true,
	upgradeAdmission: { maxConcurrent: 3, maxConnections: 5 }
}).options;

const { runSim, SIM_SCENARIOS } = await import('../../src/sim.js');
const { wsCounters } = await import('../../src/runtime/handler/ws-state.js');

/** The corpus's own swarm knobs for this workload. */
const BASE = { clients: 8, topics: ['room', 'cursor'] };

/**
 * Run one seed of the committed workload and report what became of every client
 * it opened. The scenario is the exported one, reached through an `api` whose
 * only difference is that it remembers the facades it hands out.
 *
 * @param {string} seed
 */
async function runSeed(seed) {
	/** @type {any[]} */
	const clients = [];
	/** @type {Array<{ state: string, code: number | null, requestEnded: boolean }>} */
	let ended = [];
	/** @type {Record<string, number>} */
	let reasons = {};
	const result = await runSim({
		...BASE,
		seed,
		scenario: async (api, opts) => {
			await SIM_SCENARIOS.admission.scenario({
				...api,
				connect(o) {
					const c = api.connect(o);
					clients.push(c);
					return c;
				}
			}, opts);
			// Read HERE, at the end of the workload, rather than after runSim
			// returns: the run tears every surviving connection down on its way
			// out, so by then a client that stayed connected the whole time is
			// indistinguishable from one that was closed. This is also the moment
			// the run reads the ceiling for its steady-state hypothesis.
			ended = clients.map((c) => ({
				state: c.state,
				code: c.closeInfo ? c.closeInfo.code : null,
				requestEnded: c.requestEnded
			}));
			// Copied for the same reason, and it is the stronger one here: the
			// counters are module state that the NEXT run clears, so read after
			// runSim they would only ever describe whichever seed ran last.
			reasons = { ...wsCounters.upgradeRejectedByReason };
		}
	});
	return {
		result,
		reasons,
		// A refused socket and a refused handshake both end as "not connected",
		// so they are told apart by HOW: the app's close code, versus a client
		// whose own request ended, versus neither.
		refusedInOpen: ended.filter((c) => c.state === 'closed' && c.code === 4003).length,
		hungUp: ended.filter((c) => c.state === 'rejected' && c.requestEnded).length,
		shed: ended.filter((c) => c.state === 'rejected' && !c.requestEnded).length,
		open: ended.filter((c) => c.state === 'open').length,
		total: ended.length
	};
}

test('the committed workload drives all three orderings, and every client reaches one of them', async () => {
	const seeds = ['1', '2', '3', '4', '5', '6', '7', '8'];
	let refusedInOpen = 0;
	let hungUp = 0;
	let shed = 0;
	let open = 0;
	for (const seed of seeds) {
		const r = await runSeed(seed);
		assert.equal(r.total, BASE.clients, `seed ${seed} connected every client`);
		// No client may end in a state none of these describe. `connecting` here
		// would mean a handshake that never resolved, which the run would also
		// have failed to quiesce on.
		assert.equal(
			r.refusedInOpen + r.hungUp + r.shed + r.open,
			r.total,
			`seed ${seed} accounted for every client`
		);
		refusedInOpen += r.refusedInOpen;
		hungUp += r.hungUp;
		shed += r.shed;
		open += r.open;
	}
	assert.ok(refusedInOpen > 0, `some socket is closed inside \`open\` (saw ${refusedInOpen})`);
	assert.ok(hungUp > 0, `some client leaves mid-handshake (saw ${hungUp})`);
	assert.ok(shed > 0, `the ceiling refuses some handshake (saw ${shed})`);
	assert.ok(open > 0, `and connections still succeed (saw ${open})`);
});

test('both ceilings answer refusals, which is what the second wave is for', async () => {
	// The two ceilings are checked in order, so a workload that arrives in one
	// burst gets every refusal from whichever is lower and the other is never
	// reached. Losing that is invisible in a fingerprint - the corpus would stay
	// green over a workload half of it had stopped exercising.
	const seen = new Set();
	for (const seed of ['1', '2', '3', '4', '5', '6', '7', '8']) {
		const { reasons } = await runSeed(seed);
		for (const [reason, n] of Object.entries(reasons)) if (n > 0) seen.add(reason);
	}
	assert.ok(seen.has('over_capacity'), `the concurrent-upgrade ceiling refuses some handshake (saw ${[...seen]})`);
	assert.ok(seen.has('connection_capacity'), `the live-connection ceiling refuses some handshake (saw ${[...seen]})`);
});

test('a client that left is not counted as a refusal', async () => {
	// A hang-up is not capacity pressure, and counting it as such would report a
	// ceiling under strain that nobody ever reached. The workload produces both,
	// so the counters here are the ones a shed handshake left behind.
	let counted = 0;
	let hungUp = 0;
	for (const seed of ['1', '2', '3', '4', '5', '6', '7', '8']) {
		const r = await runSeed(seed);
		counted += Object.values(r.reasons).reduce((a, b) => a + b, 0);
		hungUp += r.hungUp;
		assert.equal(
			Object.values(r.reasons).reduce((a, b) => a + b, 0),
			r.shed,
			`seed ${seed} counted exactly the handshakes it refused`
		);
	}
	assert.ok(hungUp > 0, 'clients did leave mid-handshake');
	assert.ok(counted > 0, 'and refusals were counted separately');
});

test('the workload settles clean: no violations, and the ceiling comes back', async () => {
	// The corpus digest records zero violations for all forty seeds, which is
	// only meaningful if the hypotheses could have fired. This is the same
	// assertion at the level a reader can check by eye.
	for (const seed of ['1', '2', '3', '4']) {
		const { result } = await runSeed(seed);
		assert.deepEqual(
			result.invariantViolations,
			[],
			`seed ${seed} settled with no violations`
		);
		assert.deepEqual(result.schedulerUncaught, [], `seed ${seed} threw nothing`);
	}
});

test('the workload is not the default one wearing a different name', async () => {
	// Guards the corpus split: `adapter-single` stays byte-comparable with the
	// sibling adapter's, so anything adapter-specific has to be a DIFFERENT
	// workload rather than an addition to that one. Same seed, same knobs - if
	// these two ever agree, one of the corpora is pinning the other's behaviour.
	const admission = await runSeed('1');
	const plain = await runSim({ ...BASE, seed: '1' });
	assert.notDeepEqual(admission.result.finalState, plain.finalState);
});
