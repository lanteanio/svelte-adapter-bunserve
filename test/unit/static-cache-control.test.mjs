import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeStaticCacheControl } from '../../src/build-config.js';
import { resolveStaticCacheControl } from '../../src/runtime/utils/static-headers.js';
import { unknownOptionWarnings } from '../../src/adapter-options.js';
import adapter from '../../src/index.js';

test('cache policies normalize independently and select the longest literal path', () => {
	for (const input of [undefined, null, []]) assert.equal(normalizeStaticCacheControl(input), null);
	const input = [
		{ pattern: '/tree/', cacheControl: ' public, max-age=60 ' },
		{ pattern: '/tree/deep/item.txt', cacheControl: 'no-store' },
		{ pattern: '/tree/deep/', cacheControl: 'private, max-age=20' }
	];
	const rules = normalizeStaticCacheControl(input);
	assert.equal(input[0].cacheControl, ' public, max-age=60 ');
	assert.notEqual(rules[2], input[0]);
	assert.equal(resolveStaticCacheControl('tree/item.txt', rules), 'public, max-age=60');
	assert.equal(resolveStaticCacheControl('/tree/deep/item.txt', rules), 'no-store');
	assert.equal(resolveStaticCacheControl('tree/deep/other.txt', rules), 'private, max-age=20');
	assert.equal(resolveStaticCacheControl('treehouse/item.txt', rules), '');
	assert.equal(resolveStaticCacheControl('tree/deep/item.txt.gz', rules), 'private, max-age=20');
	assert.deepEqual(unknownOptionWarnings({ staticCacheControl: input }), []);
	assert.doesNotThrow(() => adapter({ staticCacheControl: input }));
});

test('malformed cache policies fail at adapter creation', () => {
	const invalid = [false, {}, 'no-store', [null], [[]], [{ pattern: '/x', cacheControl: 'no-store', extra: true }],
		...['', 'x', '/x?y', '/x#y', '/x*', '/x\\y', '/a/../b', '/./a', '/a\0'].map(pattern => [{ pattern, cacheControl: 'no-store' }]),
		...[null, 1, '', '  ', 'x\r\ny', 'x\t', 'x\u007f'].map(cacheControl => [{ pattern: '/x', cacheControl }]),
		[{ pattern: '/x', cacheControl: 'no-store' }, { pattern: '/x', cacheControl: 'no-cache' }]];
	for (const input of invalid) assert.throws(() => adapter({ staticCacheControl: input }), /staticCacheControl/);
});

globalThis.PRECOMPRESS = true;
globalThis.STATIC_CACHE_MAX = 512;
globalThis.STATIC_DOTFILES = false;
const { cacheDir, serveStatic } = await import('../../src/runtime/handler/static-assets.js');
const { staticCache } = await import('../../src/runtime/handler/state.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-cache-control-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const rules = normalizeStaticCacheControl([
	{ pattern: '/tree/', cacheControl: 'public, max-age=60' },
	{ pattern: '/tree/deep/item.txt', cacheControl: 'no-store' },
	{ pattern: '/tree/deep/', cacheControl: 'private, max-age=20' },
	{ pattern: '/_app/', cacheControl: 'no-store' }
]);

for (const [lane, size] of [['memory', 200], ['disk', 2048]]) {
	test(`${lane} cache policies survive coding and revalidation with base paths and immutable precedence`, () => {
		const laneDir = path.join(dir, lane);
		const files = new Map([
			['tree/item.txt', 'public, max-age=60'],
			['tree/deep/item.txt', 'no-store'],
			['tree/deep/other.txt', 'private, max-age=20'],
			['treehouse/item.txt', 'no-cache'],
			['_app/immutable/item.js', 'public, max-age=31536000, immutable']
		]);
		for (const name of files.keys()) {
			const target = path.join(laneDir, name); fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, 'a'.repeat(size)); fs.writeFileSync(target + '.br', 'br'); fs.writeFileSync(target + '.gz', 'gz');
		}
		cacheDir(laneDir, '/base/' + lane, true, { 'x-policy': 'retained', 'cache-control': 'ignored' }, rules);
		for (const [name, expected] of files) {
			const entry = staticCache.get(`/base/${lane}/${name}`);
			assert.equal(Boolean(entry.file), lane === 'disk');
			for (const coding of ['identity', 'br', 'gzip']) {
				const headers = new Headers({ 'accept-encoding': coding });
				const full = serveStatic(entry, headers, true);
				assert.equal(full.status, 200); assert.equal(full.headers.get('cache-control'), expected);
				assert.equal(full.headers.get('x-policy'), 'retained'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
				if (!name.includes('/immutable/')) assert.ok(full.headers.get('etag'));
				headers.set('if-none-match', full.headers.get('etag') || '*');
				const tagged = serveStatic(entry, headers, true);
				assert.equal(tagged.status, 304); assert.equal(tagged.headers.get('cache-control'), expected);
				assert.equal(tagged.headers.get('x-policy'), 'retained'); assert.equal(tagged.headers.get('content-type'), null);
			}
		}
		cacheDir(laneDir, '/prerender/' + lane, false, null, rules);
		assert.equal(new Headers(staticCache.get(`/prerender/${lane}/_app/immutable/item.js`).headers).get('cache-control'), 'no-store', 'immutable precedence applies only to the client index');
	});
}
