import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// `XFF_DEPTH` is read once at module load, so the values that must be REFUSED
// there can only be exercised by a file that imports the module fresh per case.
// The query suffix is what makes each import a fresh module instance; `env()`
// reads `process.env` at call time, so each one sees the value set just above
// it.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js'
}).options;

/**
 * Import `config.js` fresh with `XFF_DEPTH` set to `value`.
 *
 * @param {string} value
 * @param {string} tag unique per call, so the module is not served from cache
 */
function bootWith(value, tag) {
	process.env.XFF_DEPTH = value;
	return import(`../../src/runtime/handler/config.js?xff=${tag}`);
}

// Every one of these reaches `addresses[addresses.length - xff_depth]` as
// `undefined` at request time, because `NaN > n` and `0 > n` and `-1 > n` are
// all false. Before the boot guard the failure was a 500 with a stack for every
// SSR request AND every WebSocket handshake on the server.
for (const [value, tag] of [
	['0', 'zero'],
	['-1', 'negative'],
	['abc', 'words'],
	['', 'empty']
]) {
	test(`XFF_DEPTH='${value}' is refused at boot`, async () => {
		await assert.rejects(
			() => bootWith(value, tag),
			(err) => {
				assert.match(String(err.message), /Invalid XFF_DEPTH/);
				assert.match(String(err.message), /positive integer/);
				return true;
			}
		);
	});
}

test('a valid depth boots and is read as a number', async () => {
	const config = await bootWith('3', 'valid');
	assert.equal(config.xff_depth, 3);
});

test('the default is 1 when the variable is unset', async () => {
	delete process.env.XFF_DEPTH;
	const config = await import('../../src/runtime/handler/config.js?xff=default');
	assert.equal(config.xff_depth, 1);
});
