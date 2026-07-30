import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrerendered } from '../../src/runtime/utils/prerendered-path.js';

/**
 * @param {string[]} pages - paths listed in builder.prerendered.paths
 * @param {string[]} dirStyle - of those, the ones written as dir/index.html
 * @param {string[]} cached - paths present in the static cache
 */
function tables(pages, dirStyle, cached) {
	return {
		prerendered: new Set(pages),
		dirStyle: new Set(dirStyle),
		hasEntry: (p) => new Set(cached).has(p)
	};
}

test('file-style page: bare path is canonical and is served', () => {
	const t = tables(['/about'], [], ['/about']);
	assert.deepEqual(resolvePrerendered('/about', '', t), { kind: 'serve', path: '/about' });
});

test('file-style page: trailing-slash request redirects to the bare path', () => {
	const t = tables(['/about'], [], ['/about']);
	assert.deepEqual(resolvePrerendered('/about/', '', t), { kind: 'redirect', location: '/about' });
});

test('directory-style page: bare path redirects to the trailing-slash form', () => {
	const t = tables(['/about'], ['/about'], ['/about/']);
	assert.deepEqual(resolvePrerendered('/about', '', t), { kind: 'redirect', location: '/about/' });
});

test('directory-style page: trailing-slash request is served, not redirected', () => {
	const t = tables(['/about'], ['/about'], ['/about/']);
	assert.deepEqual(resolvePrerendered('/about/', '', t), { kind: 'serve', path: '/about/' });
});

test('query string rides along on every redirect', () => {
	const fileStyle = tables(['/about'], [], ['/about']);
	assert.deepEqual(
		resolvePrerendered('/about/', '?q=1&x=2', fileStyle),
		{ kind: 'redirect', location: '/about?q=1&x=2' }
	);
	const dirStyleTables = tables(['/about'], ['/about'], ['/about/']);
	assert.deepEqual(
		resolvePrerendered('/about', '?q=1', dirStyleTables),
		{ kind: 'redirect', location: '/about/?q=1' }
	);
});

test('unknown path is a miss so the request continues to SSR', () => {
	const t = tables(['/about'], [], ['/about']);
	assert.deepEqual(resolvePrerendered('/nope', '', t), { kind: 'miss' });
	assert.deepEqual(resolvePrerendered('/nope/', '', t), { kind: 'miss' });
});

test('listed but uncached: falls through to the alternate form rather than claiming the request', () => {
	// Listed as prerendered, absent from the cache, and no alternate exists
	const orphan = tables(['/about'], [], []);
	assert.deepEqual(resolvePrerendered('/about', '', orphan), { kind: 'miss' });
});

test('directory-style page with nothing cached never emits a redirect loop', () => {
	// dirStyle says the trailing-slash form is canonical, but nothing is cached
	// under it. Redirecting /about/ to /about would bounce straight back, since
	// the bare path of a directory-style page redirects to the slash form.
	const t = tables(['/about'], ['/about'], []);
	assert.deepEqual(resolvePrerendered('/about/', '', t), { kind: 'miss' });

	// The other half of the would-be loop still redirects, which is correct:
	// it is the canonical direction and terminates at the miss above.
	assert.deepEqual(resolvePrerendered('/about', '', t), { kind: 'redirect', location: '/about/' });
});

test('site root is served directly', () => {
	const t = tables(['/'], [], ['/']);
	assert.deepEqual(resolvePrerendered('/', '', t), { kind: 'serve', path: '/' });
});

test('every serve decision names a path the cache actually holds', () => {
	// Guards the contract tryPrerendered relies on: it dereferences
	// staticCache.get(decision.path) without a null check.
	const cases = [
		{ t: tables(['/about'], [], ['/about']), path: '/about' },
		{ t: tables(['/about'], ['/about'], ['/about/']), path: '/about/' },
		{ t: tables(['/'], [], ['/']), path: '/' }
	];
	for (const { t, path } of cases) {
		const d = resolvePrerendered(path, '', t);
		if (d.kind === 'serve') assert.ok(t.hasEntry(d.path), `cache holds ${d.path}`);
	}
});
