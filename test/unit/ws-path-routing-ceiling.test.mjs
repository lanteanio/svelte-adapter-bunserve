import { test } from 'node:test';
import assert from 'node:assert/strict';

// A GET ON THE WEBSOCKET PATH THAT IS NOT A HANDSHAKE, under an admission
// ceiling. svelte-adapter-uws answers it on the path's GET route: Upgrade
// Required while there is room, and at capacity or under siege the refusal a
// shed upgrade gets, as the accessible page for a browser navigation. Every
// other method is still the app's.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	upgradeAdmission: { maxConnections: 1 }
};

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const { buildAccessibleCapacityRefusalPage } = await import('../../src/runtime/utils/upgrade-admission.js');
const { resetRuntimeEnv, setRuntimeEnv } = await import('../../src/runtime/runtime.js');

const srv = { upgrade() { throw new Error('no socket should be opened here'); } };

/** @param {Record<string, string>} [headers] */
const navigate = (headers) => tryUpgrade(new Request('http://127.0.0.1/ws', { headers }), srv, '/ws');

/** Hold the one connection permit for the length of `fn`. */
async function atCapacity(fn) {
	assert.equal(upgradeAdmission.tryAcquireConnection(), true);
	try {
		return await fn();
	} finally {
		upgradeAdmission.releaseConnection();
	}
}

/** Pin the posture for the length of `fn`; the posture machine reads only `level` here. */
async function underPosture(level, fn) {
	wsCounters.activePosture = /** @type {any} */ ({ level, tick() {} });
	try {
		return await fn();
	} finally {
		wsCounters.activePosture = null;
	}
}

test('the ceiling is live for this fixture, so the checks below can fail', () => {
	assert.notEqual(upgradeAdmission, null);
	assert.equal(upgradeAdmission.hasCapacity(), true);
});

test('with room, it is told to upgrade, and nothing else', async () => {
	const res = await navigate();
	assert.equal(res.status, 426);
	assert.equal(await res.text(), 'WebSocket upgrade required');
	assert.deepEqual([...res.headers], [['content-type', 'text/plain'], ['upgrade', 'websocket']]);
	// An upgrade to another protocol is not a WebSocket handshake either.
	assert.equal((await navigate({ upgrade: 'h2c', connection: 'Upgrade' })).status, 426);
});

test('at capacity, a navigation gets the accessible page with a jittered Retry-After', async () => {
	const res = await atCapacity(() => navigate({ accept: 'text/html,application/xhtml+xml;q=0.9' }));
	assert.equal(res.status, 503);
	assert.equal(await res.text(), buildAccessibleCapacityRefusalPage());
	assert.deepEqual(
		[...res.headers.keys()].sort(),
		['cache-control', 'content-language', 'content-type', 'retry-after'],
		'no vary: the page is the same in every language'
	);
	assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
	assert.equal(res.headers.get('cache-control'), 'no-store');
	assert.equal(res.headers.get('content-language'), 'en');
	const retryAfter = Number(res.headers.get('retry-after'));
	assert.ok(retryAfter >= 2 && retryAfter <= 3, `got ${res.headers.get('retry-after')}`);
});

test('at capacity, a GET whose Upgrade lists websocket among others never gets HTML', async () => {
	// Not a handshake (the value is not `websocket` alone), so it is answered
	// here; and a request that names websocket at all is a client, not a page.
	const res = await atCapacity(() => navigate({ accept: 'text/html', upgrade: 'h2c, websocket', connection: 'Upgrade' }));
	assert.equal(res.status, 503);
	assert.equal(res.headers.get('content-type'), 'text/plain');
});

test('at capacity, a request that does not ask for HTML gets the bare 503', async () => {
	for (const accept of [undefined, 'application/json', 'text/html;q=0', '*/*']) {
		const res = await atCapacity(() => navigate(accept === undefined ? {} : { accept }));
		assert.equal(res.status, 503, String(accept));
		assert.equal(res.headers.get('content-type'), 'text/plain', String(accept));
		assert.equal(await res.text(), 'Server is at upgrade capacity, please retry');
		assert.ok(Number(res.headers.get('retry-after')) >= 2, String(accept));
	}
});

test('under siege it is refused even with room, and the band widens', async () => {
	assert.equal(upgradeAdmission.hasCapacity(), true);
	// The top of the draw, so the band edge is what is read: 2..4 under siege
	// where it is 2..3 at the normal posture.
	setRuntimeEnv({ rng: { float: () => 0.999 } });
	try {
		const page = await underPosture('siege', () => navigate({ accept: 'text/html' }));
		assert.equal(page.status, 503);
		assert.equal(page.headers.get('retry-after'), '4');
		const bare = await underPosture('siege', () => navigate());
		assert.equal(bare.status, 503);
		assert.equal(bare.headers.get('retry-after'), '4');
		const normal = await atCapacity(() => navigate({ accept: 'text/html' }));
		assert.equal(normal.headers.get('retry-after'), '3');
	} finally {
		resetRuntimeEnv();
	}
	// An elevated posture is not a refusal.
	assert.equal((await underPosture('elevated', () => navigate())).status, 426);
});

test('no answer here is counted as a refused upgrade, since none was attempted', async () => {
	await navigate();
	await atCapacity(() => navigate({ accept: 'text/html' }));
	await atCapacity(() => navigate());
	assert.equal(wsCounters.upgradeRejectedTotal, 0);
});

test('every method but GET is the app\'s, ceiling or not', async () => {
	for (const method of ['HEAD', 'POST', 'PUT']) {
		assert.equal(tryUpgrade(new Request('http://127.0.0.1/ws', { method }), srv, '/ws'), null, method);
		assert.equal(await atCapacity(() => tryUpgrade(new Request('http://127.0.0.1/ws', { method }), srv, '/ws')), null, method);
	}
});
