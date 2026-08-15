import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// REFUSALS THAT ARE NOT CAPACITY, on a server with NO admission block at all.
//
// This fixture is the point of the file. The counters could have lived on the
// admission controller, next to the ceilings that produce most of the refusals,
// and that would have been wrong in a way nothing would report: the controller
// does not exist unless `websocket.upgradeAdmission` is configured, and an
// origin refusal has nothing to do with admission. The exporter that closes the
// metrics parity gap would then publish a confident zero for every server that
// never configured a ceiling - a number that exists and is wrong, which is
// worse than one that is missing.
//
// The reasons here are svelte-adapter-uws's labels for the same three refusals,
// so the same event reads as the same word on both adapters.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	// One allowed origin, so a foreign one is refused. No `upgradeAdmission`.
	allowedOrigins: ['https://allowed.example'],
	path: '/ws',
	handler: 'src/ws-handler.js'
};

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const {
	UPGRADE_REJECTION_REASONS,
	recordUpgradeRejection,
	upgradeRejectionCounts,
	wsCounters
} = await import('../../src/runtime/handler/ws-state.js');

const srv = { taken: 0, upgrade() { srv.taken++; return true; } };

/** @param {string} [origin] */
function upgradeRequest(origin) {
	const headers = { upgrade: 'websocket', connection: 'Upgrade' };
	if (origin) headers.origin = origin;
	return new Request('http://127.0.0.1/ws', { headers });
}

/** Swallow the refusal's own log line, which other tests already assert on. */
async function quietly(fn) {
	const warn = console.warn;
	const error = console.error;
	console.warn = () => {};
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.warn = warn;
		console.error = error;
	}
}

test('this fixture has no gate at all, which is the whole point of the file', () => {
	assert.equal(upgradeAdmission, null, 'no admission controller exists here');
	assert.equal(wsCounters.upgradeRejectedTotal, 0);
});

test('a refused origin is counted, with no admission block configured', async () => {
	const before = upgradeRejectionCounts();
	const res = await quietly(() => tryUpgrade(upgradeRequest('https://evil.example'), srv, '/ws'));
	assert.ok(res && res.status === 403, `the upgrade is refused, got ${res && res.status}`);

	const after = upgradeRejectionCounts();
	assert.equal(after.bad_origin, before.bad_origin + 1, 'counted as uws counts it');
	assert.equal(wsCounters.upgradeRejectedTotal, 1, 'and in the total');
	assert.equal(srv.taken, 0, 'nothing reached the runtime');
});

test('a hook that returns false is counted as an auth rejection', async () => {
	__setHooks({ upgrade: () => false });
	try {
		const before = upgradeRejectionCounts();
		const res = await quietly(() => tryUpgrade(upgradeRequest('https://allowed.example'), srv, '/ws'));
		assert.ok(res && res.status === 401, `the hook's refusal is answered 401, got ${res && res.status}`);
		const after = upgradeRejectionCounts();
		assert.equal(after.auth_rejected, before.auth_rejected + 1);
		assert.equal(after.bad_origin, before.bad_origin, 'and not as anything else');
	} finally {
		__setHooks({});
	}
});

test('a hook that throws is counted as a hook error', async () => {
	__setHooks({ upgrade: () => { throw new Error('the hook broke'); } });
	try {
		const before = upgradeRejectionCounts();
		const res = await quietly(() => tryUpgrade(upgradeRequest('https://allowed.example'), srv, '/ws'));
		assert.ok(res && res.status === 500, `a thrown hook is a 500, got ${res && res.status}`);
		assert.equal(upgradeRejectionCounts().hook_error, before.hook_error + 1);
	} finally {
		__setHooks({});
	}
});

test('an unusable handshake header from the hook is counted the same way', async () => {
	// uws reaches its own `hook_error` for this: there the unusable value throws
	// out of the response builder the app called, inside the hook. Same cause,
	// same answer, so the same label rather than a spelling only this adapter
	// uses.
	__setHooks({
		upgrade: (_req, { headers }) => {
			headers['x-user'] = 'name\r\nset-cookie: stolen=1';
			return {};
		}
	});
	try {
		const before = upgradeRejectionCounts();
		const res = await quietly(() => tryUpgrade(upgradeRequest('https://allowed.example'), srv, '/ws'));
		assert.ok(res && res.status === 500, `the header is refused, got ${res && res.status}`);
		assert.equal(upgradeRejectionCounts().hook_error, before.hook_error + 1);
		assert.equal(srv.taken, 0, 'and no socket was taken for it');
	} finally {
		__setHooks({});
	}
});

test('an unknown reason counts nowhere, and a snapshot is a copy', () => {
	const before = upgradeRejectionCounts();
	// A mistyped label must not invent a counter nobody reads, and inherited
	// keys are not labels: without a null-prototype bag, 'constructor' would
	// pass the membership check and then increment a function.
	recordUpgradeRejection('nonsense');
	recordUpgradeRejection('constructor');
	recordUpgradeRejection('__proto__');
	assert.deepEqual(upgradeRejectionCounts(), before, 'nothing moved');

	// Every reason is present from the start, so a reader never has to tell
	// "no refusals yet" from "that reason does not exist".
	for (const reason of UPGRADE_REJECTION_REASONS) {
		assert.equal(typeof before[reason], 'number', `${reason} is seeded`);
	}

	const snapshot = upgradeRejectionCounts();
	snapshot.bad_origin = 999;
	assert.notEqual(upgradeRejectionCounts().bad_origin, 999, 'a held copy cannot write back');
});
