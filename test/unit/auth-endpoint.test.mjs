import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// The auth preflight endpoint: the POST a client makes before it opens a
// socket, so a session cookie can be refreshed on an ordinary HTTP response
// rather than on a 101 that strict edge proxies drop.
//
// Driven through the real entry point with a real `Request`, which is the whole
// surface: the endpoint is plain HTTP, so nothing here needs a socket, a
// simulated transport, or a build.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowedOrigins: 'same-origin',
	// OFF, for the reason the fixture's main build turns the upgrade limiter off:
	// every request in this file comes from one address, which is one client by
	// that measure. Left at the default of 30 per 10s, this file sits eight
	// requests below the ceiling - so the next assertion anyone adds turns into a
	// 429 reported as 'the auth endpoint is broken'.
	authPathRateLimit: 0
}).options;

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { tryAuthEndpoint, authEndpointMounted } = await import('../../src/runtime/handler/auth.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

const AUTH_PATH = '/__ws/auth';
const SELF = 'https://app.example';

/** Stands in for the Bun server, which the endpoint asks for the client address. */
const srv = { requestIP: () => ({ address: '203.0.113.7' }) };

/**
 * A preflight POST as the family client sends it: the `x-requested-with` header
 * is what a cross-origin page cannot forge without a CORS preflight this
 * endpoint never approves.
 */
function preflight(headers = {}, init = {}) {
	return new Request(SELF + AUTH_PATH, {
		method: 'POST',
		headers: { host: 'app.example', 'x-requested-with': 'XMLHttpRequest', ...headers },
		...init
	});
}

/** Run the endpoint the way the server does. */
function call(req) {
	return tryAuthEndpoint(req, srv, new URL(req.url).pathname);
}

test('nothing is mounted without an `authenticate` hook', async () => {
	__setHooks({});
	assert.equal(authEndpointMounted(), false);
	// null, not a 404: the request falls through to ordinary routing, so an app
	// that serves its own page at this path keeps serving it.
	assert.equal(call(preflight()), null);
});

test('a request for another path is not this endpoint', () => {
	__setHooks({ authenticate: () => undefined });
	assert.equal(tryAuthEndpoint(preflight(), srv, '/ws'), null);
	assert.equal(tryAuthEndpoint(preflight(), srv, '/'), null);
});

test('a wrong verb is answered, not left to the SSR catch-all', async () => {
	// Falling through would render the app shell at a URL that is not a page: a
	// 200 with a full HTML document where a client expects a preflight answer.
	__setHooks({ authenticate: () => undefined });
	for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
		const res = await call(new Request(SELF + AUTH_PATH, { method, headers: { host: 'app.example' } }));
		assert.equal(res.status, 405, method);
		assert.equal(res.headers.get('allow'), 'POST', method);
	}
});

test('a hook that answers nothing is a 204', async () => {
	let calls = 0;
	__setHooks({ authenticate: () => { calls++; } });
	const res = await call(preflight());
	assert.equal(res.status, 204);
	assert.equal(calls, 1);
	assert.equal(await res.text(), '');
});

test('`false` is a 401', async () => {
	__setHooks({ authenticate: () => false });
	const res = await call(preflight());
	assert.equal(res.status, 401);
	assert.match(await res.text(), /Unauthorized/);
});

test('a returned Response is the answer verbatim', async () => {
	__setHooks({
		authenticate: () => new Response(JSON.stringify({ user: 'ada' }), {
			status: 200,
			headers: { 'content-type': 'application/json', 'x-app': 'yes' }
		})
	});
	const res = await call(preflight());
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('x-app'), 'yes');
	assert.deepEqual(await res.json(), { user: 'ada' });
});

test('the hook may await, and reads the request it was given', async () => {
	__setHooks({
		authenticate: async (req) => {
			const body = await req.json();
			return body.token === 'good' ? undefined : false;
		}
	});
	const good = await call(preflight({ 'content-type': 'application/json' }, { body: '{"token":"good"}' }));
	assert.equal(good.status, 204);
	const bad = await call(preflight({ 'content-type': 'application/json' }, { body: '{"token":"no"}' }));
	assert.equal(bad.status, 401);
});

// - cookies -------------------------------------------------------------------

test('a cookie the hook sets goes out on the 204', async () => {
	// The whole reason this endpoint exists: the same Set-Cookie on a 101 is
	// silently dropped by Cloudflare Tunnel and other strict edge proxies.
	__setHooks({
		authenticate: (req, { cookies }) => { cookies.set('sid', 'fresh', { path: '/' }); }
	});
	const res = await call(preflight());
	assert.equal(res.status, 204);
	assert.deepEqual(res.headers.getSetCookie(), ['sid=fresh; Path=/; HttpOnly; Secure; SameSite=Lax']);
});

test('the hook reads the cookies the request carried', async () => {
	let seen = null;
	__setHooks({ authenticate: (req, { cookies }) => { seen = cookies.get('sid'); } });
	await call(preflight({ cookie: 'sid=existing; theme=dark' }));
	assert.equal(seen, 'existing');
});

test('cookies survive a rejection, so a stale session can be cleared', async () => {
	__setHooks({
		authenticate: (req, { cookies }) => {
			cookies.delete('sid', { path: '/' });
			return false;
		}
	});
	const res = await call(preflight({ cookie: 'sid=stale' }));
	assert.equal(res.status, 401);
	assert.match(res.headers.getSetCookie()[0], /^sid=; Path=\/;/);
});

test('a returned Response keeps its own cookies AND gets the jar\'s', async () => {
	// Both APIs work together rather than one silently winning.
	__setHooks({
		authenticate: (req, { cookies }) => {
			cookies.set('sid', 'fresh', { path: '/' });
			return new Response(null, { status: 200, headers: { 'set-cookie': 'own=1; Path=/' } });
		}
	});
	const res = await call(preflight());
	const set = res.headers.getSetCookie();
	assert.equal(set.length, 2, JSON.stringify(set));
	assert.ok(set.some((c) => c.startsWith('own=1')));
	assert.ok(set.some((c) => c.startsWith('sid=fresh')));
});

// - the CSRF guard ------------------------------------------------------------

test('`x-requested-with` alone is accepted', async () => {
	__setHooks({ authenticate: () => undefined });
	const res = await call(preflight({}, {}));
	assert.equal(res.status, 204);
});

test('`sec-fetch-site: same-origin` alone is accepted', async () => {
	__setHooks({ authenticate: () => undefined });
	const req = new Request(SELF + AUTH_PATH, {
		method: 'POST',
		headers: { host: 'app.example', 'sec-fetch-site': 'same-origin' }
	});
	assert.equal((await call(req)).status, 204);
});

test('a matching Origin alone is accepted', async () => {
	__setHooks({ authenticate: () => undefined });
	const req = new Request(SELF + AUTH_PATH, {
		method: 'POST',
		// No ORIGIN env is set here, so the server's own origin is derived from
		// the request - which is the zero-config path a dev server takes.
		headers: { host: 'app.example', 'x-forwarded-proto': 'https', origin: 'http://app.example' }
	});
	assert.equal((await call(req)).status, 204);
});

test('a foreign origin is refused before the hook runs', async () => {
	// The hook is a credential check that may hit a database, refresh a cookie,
	// or spend a per-user budget. A page on another origin must not be able to
	// drive any of that with the visitor's cookie riding along.
	let calls = 0;
	__setHooks({ authenticate: () => { calls++; } });
	const req = new Request(SELF + AUTH_PATH, {
		method: 'POST',
		headers: { host: 'app.example', origin: 'https://evil.example' }
	});
	const res = await call(req);
	assert.equal(res.status, 403);
	assert.equal(calls, 0, 'the hook never ran');
	assert.match(await res.text(), /Origin not allowed/);
});

test('a request with no evidence at all is refused', async () => {
	// Absence is refused HERE where the upgrade door allows it: that door has the
	// app's `upgrade` hook behind it to authenticate a non-browser client, and
	// this endpoint IS the authentication.
	let calls = 0;
	__setHooks({ authenticate: () => { calls++; } });
	const req = new Request(SELF + AUTH_PATH, { method: 'POST', headers: { host: 'app.example' } });
	assert.equal((await call(req)).status, 403);
	assert.equal(calls, 0);
});

test('`authPathRequireOrigin: false` accepts the native client', async () => {
	const previous = globalThis.WS_OPTIONS.authPathRequireOrigin;
	globalThis.WS_OPTIONS.authPathRequireOrigin = false;
	try {
		__setHooks({ authenticate: () => undefined });
		const req = new Request(SELF + AUTH_PATH, { method: 'POST', headers: { host: 'app.example' } });
		assert.equal((await call(req)).status, 204);
	} finally {
		globalThis.WS_OPTIONS.authPathRequireOrigin = previous;
	}
});

// - what the hook is handed ---------------------------------------------------

test('the context carries a per-request platform identity', async () => {
	/** @type {any} */
	let ctx = null;
	__setHooks({ authenticate: (req, c) => { ctx = c; } });
	await call(preflight({ 'x-request-id': 'req-42' }));
	assert.equal(ctx.platform.requestId, 'req-42');
	assert.equal(typeof ctx.platform.publish, 'function', 'and the whole platform behind it');

	await call(preflight());
	assert.match(ctx.platform.requestId, /^[0-9a-f-]{36}$/, 'one is minted when the header is absent');
});

test('an unusable request id is replaced rather than carried into the logs', async () => {
	// requestId flows into structured logs, so the header is a single printable
	// token or it is not used. The CR/LF form cannot even be constructed here -
	// the runtime refuses it at the Request - so what is left to check is
	// everything else the whitelist covers.
	/** @type {any} */
	let ctx = null;
	__setHooks({ authenticate: (req, c) => { ctx = c; } });
	for (const smuggled of ['x'.repeat(200), 'has a space', 'tab\there']) {
		await call(preflight({ 'x-request-id': smuggled }));
		assert.notEqual(ctx.platform.requestId, smuggled, JSON.stringify(smuggled));
		assert.match(ctx.platform.requestId, /^[0-9a-f-]{36}$/);
	}
});

test('the context resolves the client address', async () => {
	let address = null;
	__setHooks({ authenticate: (req, { getClientAddress }) => { address = getClientAddress(); } });
	await call(preflight());
	assert.equal(address, '203.0.113.7');
});

// - refusals that are not the app's -------------------------------------------

test('a declared body past the cap is refused before the hook', async () => {
	let calls = 0;
	__setHooks({ authenticate: () => { calls++; } });
	const res = await call(preflight({ 'content-length': String(64 * 1024 + 1) }, { body: 'x' }));
	assert.equal(res.status, 413);
	assert.equal(calls, 0);
});

test('a throwing hook is a 500, and the error does not escape', async () => {
	__setHooks({ authenticate: () => { throw new Error('boom'); } });
	const res = await call(preflight());
	assert.equal(res.status, 500);
	assert.match(await res.text(), /Internal Server Error/);
});

test('a hook that rejects asynchronously is the same 500', async () => {
	__setHooks({ authenticate: async () => { throw new Error('boom'); } });
	assert.equal((await call(preflight())).status, 500);
});
