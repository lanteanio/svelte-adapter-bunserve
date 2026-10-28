import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A static file whose name a browser percent-encodes - a space, a non-ASCII
// letter - served for that spelling, as svelte-adapter-uws and SvelteKit's
// Node adapter serve it. Bun hands a target on with every byte outside ASCII
// escaped, so without this such a file is reached by no spelling at all. The
// index and lookup the runtime uses, over a directory of names the fixture
// cannot carry portably.

globalThis.PRECOMPRESS = false;
globalThis.STATIC_CACHE_MAX = 1024 * 1024;
globalThis.STATIC_DOTFILES = false;
globalThis.ENV_PREFIX = '';

const { cacheDir, encodedStaticEntry } = await import('../../src/runtime/handler/static-assets.js');
const { staticCache, prerenderedDirStyle } = await import('../../src/runtime/handler/state.js');

const COMBINING_DIAERESIS = String.fromCharCode(0x308);
const U_UMLAUT = String.fromCharCode(0xdc);
const KELVIN = String.fromCharCode(0x212a);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-encoded-name-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

fs.writeFileSync(path.join(tmp, 'My Report.txt'), 'spaced');
fs.mkdirSync(path.join(tmp, 'My'));
fs.writeFileSync(path.join(tmp, 'My', 'Report.txt'), 'nested');
fs.writeFileSync(path.join(tmp, 'U' + COMBINING_DIAERESIS + 'bersicht.txt'), 'decomposed');
cacheDir(tmp, '/encoded-probe', false);

/** @param {string} pathname */
const body = (pathname) => encodedStaticEntry(pathname)?.buffer.toString();

test('is found for its encoded spelling, in either Unicode form', () => {
	assert.equal(body('/encoded-probe/My%20Report.txt'), 'spaced');
	assert.equal(body('/encoded-probe/%C3%9Cbersicht.txt'), 'decomposed', 'the composed spelling a browser sends');
	assert.equal(body('/encoded-probe/U%CC%88bersicht.txt'), 'decomposed', 'the name as written');
	assert.equal(body('/encoded-probe/my%20report.txt'), undefined, 'names are matched exactly');
	assert.equal(encodedStaticEntry('/encoded-probe/My%2'), undefined, 'an escape nothing can decode');
	assert.equal(encodedStaticEntry('/encoded-probe/My%20Report.txt%'), undefined);
});

test('does not read an encoded separator into a directory that holds the name', () => {
	assert.equal(body('/encoded-probe/My%2FReport.txt'), undefined);
	assert.equal(body('/encoded-probe/My/Report%2Etxt'), 'nested', 'the directory is there to be found');
});

test('is not asked for a target that is the name as sent', () => {
	// The fast path already looked that spelling up; a target that decodes to
	// itself is not a second spelling of anything.
	assert.equal(encodedStaticEntry('/encoded-probe/My/Report.txt'), undefined);
});

test('never lets a composed alias shadow a file of that name, in either walk order', () => {
	// One directory per form: some file systems cannot hold both in one.
	const composed = U_UMLAUT + 'ber.txt';
	const decomposed = 'U' + COMBINING_DIAERESIS + 'ber.txt';
	for (const [prefix, order] of [['/alias-first', [decomposed, composed]], ['/alias-second', [composed, decomposed]]]) {
		for (const name of order) {
			const dir = fs.mkdtempSync(path.join(tmp, 'walk-'));
			fs.writeFileSync(path.join(dir, name), name === composed ? 'composed' : 'decomposed');
			cacheDir(dir, prefix, false);
		}
		assert.equal(staticCache.get(`${prefix}/${composed}`).buffer.toString(), 'composed', prefix);
		assert.equal(staticCache.get(`${prefix}/${decomposed}`).buffer.toString(), 'decomposed', prefix);
	}
});

test('registers no alias that composes to plain ASCII', () => {
	// A Kelvin sign composes to `K`: the file is reached by its own encoded
	// name, never by a target that is not its name.
	const dir = fs.mkdtempSync(path.join(tmp, 'kelvin-'));
	fs.writeFileSync(path.join(dir, KELVIN + 'ey.txt'), 'kelvin');
	cacheDir(dir, '/kelvin-probe', false);
	assert.equal(staticCache.get('/kelvin-probe/Key.txt'), undefined);
	assert.equal(body('/kelvin-probe/%E2%84%AAey.txt'), 'kelvin');
});


test('prerendered clean paths have NFC aliases without shadowing real names', () => {
 const decomposed = 'U' + COMBINING_DIAERESIS + 'ber';
 const composed = U_UMLAUT + 'ber';
 for (const directory of [false, true]) {
  const prefix = '/clean-' + directory;
  const dir = fs.mkdtempSync(path.join(tmp, 'clean-'));
  const file = directory ? path.join(dir, decomposed, 'index.html') : path.join(dir, decomposed + '.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'page');
  cacheDir(dir, prefix, false);
  const suffix = directory ? '/' : '';
  assert.equal(staticCache.get(prefix + '/' + composed + suffix)?.buffer.toString(), 'page');
  assert.equal(prerenderedDirStyle.has(prefix + '/' + composed), directory);
  const real = fs.mkdtempSync(path.join(tmp, 'real-'));
  fs.writeFileSync(path.join(real, composed), 'real');
  cacheDir(real, prefix, false);
  assert.equal(staticCache.get(prefix + '/' + composed)?.buffer.toString(), 'real');
  assert.equal(prerenderedDirStyle.has(prefix + '/' + composed), false);
  if (directory) assert.equal(staticCache.has(prefix + '/' + composed + '/'), false);
 }
});
