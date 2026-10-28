import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPosture } from '../../src/runtime/utils/pressure.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../../src/runtime/error-registry.js';

test('connection ceilings can escalate posture to siege', () => {
 const state = createPosture({ admission: { maxConnections: 2 } });
 for (let i = 0; i < 5; i++) state.tick({ active: true });
 assert.equal(state.level, 'elevated');
 for (let i = 0; i < 10; i++) {
  for (let j = 0; j < 4; j++) state.recordCapacityReject();
  state.tick({ active: true });
 }
 assert.equal(state.level, 'siege');
});

test('posture observer errors use the registered diagnostic and preserve transitions', () => {
	const calls = [];
	const original = console.error;
	console.error = (...args) => calls.push(args);
	try {
	const error = new Error('observer failed');
	const state = createPosture({
		admission: { maxConcurrent: 2 },
		onTransition() { throw error; }
	});
	for (let i = 0; i < 5; i++) state.tick({ active: true });
	assert.equal(state.level, 'elevated');
	assert.deepEqual(calls, [[adapterConsoleLine(ADAPTER_ERROR_IDS.POSTURE_OBSERVER), error]]);
	} finally { console.error = original; }
});
