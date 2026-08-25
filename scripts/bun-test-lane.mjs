// Run a test lane under Bun, one process per file.
//
// `node --test` gives every test file its own process, and the suites lean on
// that: module-level registries, counters and singletons are reset per FILE by
// process death, not by teardown code. `bun test` runs every file it discovers
// in one process, so state written by one file is visible to the next and the
// batch fails on tests that pass alone. Until the whole suite owns its resets
// (or the floor reaches a Bun whose test runner isolates files), this runner
// restores the isolation the suites were written against by spawning one
// `bun test` per file.
//
// Usage: bun scripts/bun-test-lane.mjs unit|sim
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const LANES = {
	unit: { dir: 'test/unit', condition: 'bunserve-test' },
	sim: { dir: 'test/sim', condition: 'bunserve-sim' }
};

const lane = LANES[process.argv[2]];
if (!lane) {
	console.error('usage: bun scripts/bun-test-lane.mjs unit|sim');
	process.exit(2);
}

const files = readdirSync(lane.dir)
	.filter((f) => f.endsWith('.test.mjs'))
	.sort();
let failed = 0;
for (const f of files) {
	const path = `${lane.dir}/${f}`;
	const r = spawnSync(
		process.execPath,
		['test', `--conditions=${lane.condition}`, path],
		{ stdio: ['ignore', 'inherit', 'inherit'] }
	);
	if (r.status !== 0) {
		failed++;
		console.error(`FAIL ${path}`);
	}
}
console.log(`bun-test-lane ${process.argv[2]}: ${files.length - failed}/${files.length} files green`);
process.exit(failed === 0 ? 0 : 1);
