import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// A fractional authPathRateLimitWindow is a valid option, and Retry-After takes
// an integer delay: the jittered refusal rounds the window up to whole seconds
// before spreading it, so it never writes a header like "2.2". Its own file
// because the window is read once, when the auth module loads.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowedOrigins: 'same-origin',
	authPathRateLimit: 1,
	authPathRateLimitWindow: 1.2
}).options;

const { tryAuthEndpoint } = await import('../../src/runtime/handler/auth.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { authRateLimiter } = await import('../../src/runtime/handler/rate-limit.js');
const { resetRuntimeEnv, setRuntimeEnv } = await import('../../src/runtime/runtime.js');

function post() {
	const req = new Request('https://app.example/__ws/auth', {
		method: 'POST',
		headers: { host: 'app.example', 'x-requested-with': 'XMLHttpRequest' }
	});
	return tryAuthEndpoint(req, { requestIP: () => ({ address: '203.0.113.7' }) }, '/__ws/auth');
}

test('a fractional window still refuses with a whole-second Retry-After', async () => {
	__setHooks({ authenticate: () => undefined });
	try {
		// ceil(1.2) = 2 - not round(1.2) = 1 - and the band is never narrower than 2.
		for (const [draw, expected] of [[0, '2'], [0.999, '3']]) {
			setRuntimeEnv({ rng: { float: () => draw } });
			authRateLimiter._resetForSim();
			await post();
			const refused = await post();
			assert.equal(refused.status, 429);
			assert.equal(refused.headers.get('retry-after'), expected, `draw ${draw}`);
		}
	} finally {
		resetRuntimeEnv();
	}
});
