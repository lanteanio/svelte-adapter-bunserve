import { test, after } from 'node:test';
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

// The suite forks per file, so this only matters if that ever changes - but a
// file that leaves `XFF_DEPTH=abc` behind would break every neighbour that
// depends on the default depth of 1, and the cost of not finding out that way
// is one line.
after(() => {
	delete process.env.XFF_DEPTH;
	delete process.env.ADDRESS_HEADER;
});

/**
 * Import `config.js` fresh with `XFF_DEPTH` set to `value`, and with or without
 * an `ADDRESS_HEADER` - which is what decides whether the depth is read at all.
 *
 * @param {string} value
 * @param {string} tag unique per call, so the module is not served from cache
 * @param {boolean} [withHeader]
 */
function bootWith(value, tag, withHeader = true) {
	process.env.XFF_DEPTH = value;
	if (withHeader) process.env.ADDRESS_HEADER = 'x-forwarded-for';
	else delete process.env.ADDRESS_HEADER;
	return import(`../../src/runtime/handler/config.js?xff=${tag}`);
}

/** Capture stderr across an import, since a boot warning has no later moment. */
async function warningsFrom(fn) {
	const real = console.warn;
	/** @type {string[]} */
	const lines = [];
	console.warn = (...args) => { lines.push(args.join(' ')); };
	try {
		await fn();
	} finally {
		console.warn = real;
	}
	return lines.join('\n');
}

// Every one of these reaches `addresses[addresses.length - xff_depth]` as
// `undefined` at request time, because `NaN > n`, `0 > n` and `-1 > n` are all
// false. Before the guard the failure was a 500 with a stack for every SSR
// request AND every WebSocket handshake on the server.
//
// The last three are the ones `parseInt` would have accepted as 2, 3 and 1 -
// depths the operator did not write, under a message promising an integer.
for (const [value, tag] of [
	['0', 'zero'],
	['-1', 'negative'],
	['abc', 'words'],
	['', 'empty'],
	['2.9', 'fraction'],
	['3junk', 'trailing'],
	['1e3', 'exponent']
]) {
	test(`XFF_DEPTH='${value}' is refused where it would be read`, async () => {
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

test('and only warned about where nothing reads it', async () => {
	// Both readers return the socket peer before touching the depth when no
	// ADDRESS_HEADER is set, so the value is dead on such a server. Refusing
	// anyway would stop a process booting over a variable it never reads - and
	// `XFF_DEPTH=` with an empty value is one `ENV XFF_DEPTH=` in a Dockerfile
	// away.
	let config;
	const warned = await warningsFrom(async () => {
		config = await bootWith('', 'empty-no-header', false);
	});
	assert.match(warned, /Invalid XFF_DEPTH/);
	assert.match(warned, /It is ignored on this server/);
	assert.match(warned, /ADDRESS_HEADER/);
	assert.ok(Number.isNaN(config.xff_depth), 'the value is still what it parsed to');
});

test('a valid depth boots and is read as a number', async () => {
	const config = await bootWith('3', 'valid');
	assert.equal(config.xff_depth, 3);
});

test('and says nothing when it is valid', async () => {
	assert.equal(await warningsFrom(() => bootWith('2', 'quiet', false)), '');
});

test('the default is 1 when the variable is unset', async () => {
	delete process.env.XFF_DEPTH;
	const config = await import('../../src/runtime/handler/config.js?xff=default');
	assert.equal(config.xff_depth, 1);
});
