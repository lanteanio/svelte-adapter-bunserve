import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attribution, connectionSessionId } from 'svelte-adapter-bunserve/connection';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

test('connection helpers read the settled attribution and session inside the open hook', () => {
	let resolved = 0;
	let connection;
	let observed;
	__setHooks({
		attribution(user) { resolved++; return { tenantId: user.tenant }; },
		open(ws) {
			connection = ws;
			observed = { attribution: attribution(ws), session: connectionSessionId(ws) };
		}
	});
	const raw = {
		data: upgradeData({ tenant: 'team' }), readyState: 1,
		send(payload) { return payload.length; }, getBufferedAmount() { return 0; },
		cork(fn) { fn(); }, subscribe() { return true; }, unsubscribe() { return true; }
	};
	try {
		websocketHandlers.open(raw);
		assert.equal(resolved, 1);
		assert.equal(observed.attribution.tenantId, 'team');
		assert.equal(Object.isFrozen(observed.attribution), true);
		assert.match(observed.session, /^[0-9a-f-]{36}$/);
		assert.equal(attribution(connection), attribution(connection));
		websocketHandlers.close(raw, 1000, '');
		assert.equal(attribution(connection), null);
		assert.equal(connectionSessionId(connection), undefined);
	} finally { __setHooks({}); }
});

test('connection helpers tolerate absent metadata and closed handles without a runtime import', () => {
	for (const connection of [{ getUserData: () => ({}) }, { getUserData() { throw new Error('closed'); } }]) {
		assert.equal(attribution(connection), null);
		assert.equal(connectionSessionId(connection), undefined);
	}
	assert.doesNotMatch(readFileSync(new URL('../../src/connection.js', import.meta.url), 'utf8'), /^import\s/m);
});
