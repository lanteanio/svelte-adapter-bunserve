import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entersExactMount, shadowsExactMount } from '../../src/runtime/utils/exact-mount.js';

// svelte-adapter-uws's reading of a target against the adapter's exact mounts,
// with the mounts handed in. The cases are that adapter's own; `/probe` stands
// for a probe path, `/probe.json` for a mount with a dot in its name.

const mounts = new Set(['/probe', '/probe.json', '/']);
const enters = (path, raw, query) => entersExactMount(mounts, path, raw, query);

test('holds a reading of the target that lands on an exact mount it does not spell', () => {
	assert.equal(enters('/probe', '/x/../probe'), true);
	assert.equal(enters('/probe', '/%70robe'), true);
	assert.equal(enters('/probe.json', '/x/../probe.json'), true);
});

test('never holds the direct spelling, which reaches the app only for a method the mount does not answer', () => {
	assert.equal(enters('/probe', '/probe'), false);
	assert.equal(enters('/probe.json', '/probe.json'), false);
});

test('reads a data or route-resolution request as the path in front of its suffix', () => {
	assert.equal(enters('/probe/__data.json', '/probe/__data.json'), true);
	assert.equal(enters('/probe/__route.js', '/probe/__route.js'), true);
	assert.equal(enters('/__data.json', '/__data.json'), true, 'the root page');
	assert.equal(enters('/other/__data.json', '/other/__data.json'), false);
	assert.equal(enters('/probe.html__data.json', '/probe.html__data.json'), false, 'reads as /probe.html');
});

test('reads a trailing slash as the page\'s own, as SvelteKit rebuilds it', () => {
	assert.equal(enters('/probe/', '/probe/'), false);
	assert.equal(enters('/probe//__data.json', '/probe//__data.json'), false);
	assert.equal(enters('/probe//__route.js', '/probe//__route.js'), false);
	assert.equal(enters('/probe/__data.json', '/probe/__data.json', 'x-sveltekit-trailing-slash=1'), false);
	assert.equal(enters('/probe/__data.json', '/probe/__data.json', 'x-sveltekit-invalidated=01&x-sveltekit-trailing-slash=%31'), false,
		'decoded as URLSearchParams decodes');
	assert.equal(enters('/probe/__data.json', '/probe/__data.json', 'x-sveltekit-invalidated=01'), true);
	assert.equal(enters('/probe/__data.json', '/probe/__data.json', 'xx-sveltekit-trailing-slash=1'), true, 'another parameter');
	assert.equal(enters('/probe/__data.json', '/probe/__data.json', '?x-sveltekit-trailing-slash=1'), true,
		'a second `?` belongs to the name');
	const slashed = new Set(['/slashed/']);
	assert.equal(entersExactMount(slashed, '/slashed/__data.json', '/slashed/__data.json', 'x-sveltekit-trailing-slash=1'), true,
		'a mount spelled with its slash');
	assert.equal(entersExactMount(slashed, '/slashed/__data.json', '/slashed/__data.json'), false);
});

test('judges the spellings Bun hands on: an escape and SvelteKit\'s suffixes', () => {
	const probes = new Set(['/healthz', '/readyz']);
	const shadows = (pathname, search = '') => shadowsExactMount(probes, pathname, search);
	assert.equal(shadows('/%68ealthz'), true);
	assert.equal(shadows('/%68EALTHZ'), false, 'decoded, it is another path');
	assert.equal(shadows('/HEALTHZ'), false);
	assert.equal(shadows('/healthz/__data.json'), true);
	assert.equal(shadows('/healthz/__data.json', '?x-sveltekit-invalidated=01'), true);
	assert.equal(shadows('/healthz/__data.json', '??x-sveltekit-trailing-slash=1'), true);
	assert.equal(shadows('/healthz/__data.json', '?x-sveltekit-trailing-slash=1'), false, 'the slashed page is the app\'s');
	assert.equal(shadows('/readyz/__route.js'), true);
	assert.equal(shadows('/%68ealthz/__data.json'), true);
	assert.equal(shadows('/healthz'), false, 'the mount itself, for a method it does not answer');
	assert.equal(shadows('/healthz/'), false);
	assert.equal(shadows('/about'), false);
	// Escapes with a letter for a digit, in either case.
	assert.equal(shadows('/health%7A'), true);
	assert.equal(shadows('/health%7a'), true);
	assert.equal(shadows('/hea%6Cthz'), true);
	assert.equal(shadows('/hea%6cthz/__data.json'), true);
	assert.equal(shadows('/caf%C3%A9'), false, 'an escape outside ASCII spells no mount');
	// Not even one named outside ASCII, which no target reaches as sent:
	// only escapes of ASCII characters are decoded.
	const named = new Set(['/caf' + String.fromCharCode(0xe9)]);
	assert.equal(shadowsExactMount(named, '/caf%C3%A9', ''), false);
	// Only escapes of ASCII characters are decoded: a decoder for the whole of
	// UTF-8 throws on this one, where the request has to reach the app.
	assert.equal(shadows('/%E0%A4%A'), false);
	assert.equal(shadows('/%68ealthz%E0%A4'), false, 'decoded around an escape nothing can read');
});

test('the mount set is the probes that are on, a mounted auth path and a limited WebSocket path', async () => {
	const { ownExactMounts } = await import('../../src/runtime/utils/exact-mount.js');
	const all = { healthPath: '/healthz', readinessPath: '/readyz', authPath: '/__ws/auth', wsPath: '/ws' };
	assert.deepEqual([...ownExactMounts(all)].sort(), ['/__ws/auth', '/healthz', '/readyz', '/ws']);
	assert.deepEqual([...ownExactMounts({ ...all, healthPath: false, readinessPath: false })].sort(), ['/__ws/auth', '/ws'],
		'probes turned off');
	assert.deepEqual([...ownExactMounts({ ...all, authPath: null, wsPath: null })].sort(), ['/healthz', '/readyz'],
		'no authenticate export, no admission limit');
	assert.equal(ownExactMounts({ healthPath: false, readinessPath: false, authPath: null, wsPath: null }).size, 0);
});

test('refuses other spellings of a mount written with escapes, and never the written one', async () => {
	const { splitExactMounts } = await import('../../src/runtime/utils/exact-mount.js');
	const { plain, escaped } = splitExactMounts(new Set(['/files/x%20y', '/gesundheit-pr%C3%BCfung', '/a%22b', '/odd%25zz', '/status:ready', '/healthz']));
	assert.deepEqual([...plain].sort(), ['/healthz', '/status:ready'], 'a mount with an escape is kept out of the plain set');
	assert.equal(escaped.get('/gesundheit-pr' + String.fromCharCode(0xfc) + 'fung'), '/gesundheit-pr%C3%BCfung');
	const enters = (path, raw, query) => entersExactMount(plain, path, raw, query, escaped);
	const shadows = (pathname, search = '') => shadowsExactMount(plain, pathname, search, escaped);

	// Another spelling of the same decoded path, and never the mount's own.
	assert.equal(enters('/gesundheit-pr%c3%bcfung', '/gesundheit-pr%c3%bcfung'), true, 'lowercase hex');
	assert.equal(enters('/a"b', '/a"b'), true, 'the raw character, no escape at all');
	assert.equal(enters('/gesundheit-pr%C3%BCfung/__data.json', '/gesundheit-pr%C3%BCfung/__data.json'), true, 'its data');
	assert.equal(enters('/gesundheit-pr%C3%BCfung', '/gesundheit-pr%C3%BCfung'), false);
	assert.equal(enters('/files/x%20y', '/files/x%20y'), false);
	assert.equal(shadows('/gesundheit-pr%C3%BCfung'), false, 'the mount itself, for a method it does not answer');
	assert.equal(shadows('/gesundheit-pr%C3%bcfung'), true, 'mixed case');
	assert.equal(shadows('/%67esundheit-pr%C3%BCfung'), true, 'an escaped letter beside the mount\'s own escapes');
	assert.equal(shadows('/gesundheit-pr%c3%bcfung/__route.js'), true);
	assert.equal(shadows('/gesundheit-pr%C3%BCfung/__data.json', '?x-sveltekit-trailing-slash=1'), true,
		'a data request carries the slash only for a page the plain set holds');
	assert.equal(shadows('/status%3Aready'), true);
	assert.equal(shadows('/status:ready/__data.json'), true);
	assert.equal(enters('/status:ready', '/x/../status:ready'), true, 'a colon inside a segment is part of a plain mount');
	assert.equal(shadows('/gesundheit-pr%C3%BCfung/'), false, 'a page one slash further on stays the app\'s');
	assert.equal(shadows('/gesundheit-pr%C3%A9fung'), false, 'another path');

	// A path that only decodes to the mount's spelling is another path.
	assert.equal(enters('/files/x%2520y', '/files/x%2520y'), false);
	assert.equal(shadows('/files/x%2520y'), false);
	assert.equal(shadows('/gesundheit-pr%25C3%25BCfung'), false);

	// Each run of escapes is decoded on its own, so a malformed one does not
	// hide the rest, and none of it throws.
	assert.equal(enters('/odd%zz', '/odd%zz'), true, 'a target reading as the mount with its bad escape kept');
	assert.equal(shadows('/%E0%A4%A'), false);

	assert.equal(splitExactMounts(new Set(['/healthz', '/readyz'])).escaped.size, 0, 'empty unless a mount carries an escape');
	assert.equal(shadowsExactMount(new Set(), '/gesundheit-pr%c3%bcfung', '', escaped), true, 'an escaped mount alone is still guarded');
});
