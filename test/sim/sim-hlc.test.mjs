import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runSim } = await import('../../src/sim.js');

async function stampsAt(seed) {
	const seen = [];
	await runSim({
		seed, clients: 2, steps: 2000,
		handler: {
			open(_ws, { platform }) {
				seen.push({ stamp: platform.hlc(), uuid: platform.random.uuid() });
			}
		}
	});
	return seen;
}

test('a seed whose hooks stamp with platform.hlc() reproduces in one process', async () => {
	const first = await stampsAt('hlc-reproduces');
	assert.ok(first.length > 0, 'the open hook ran');
	await stampsAt('hlc-other-seed');
	assert.deepEqual(await stampsAt('hlc-reproduces'), first);
});
