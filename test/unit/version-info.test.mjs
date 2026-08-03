import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	formatVersionBanner,
	parseProtocolRevision,
	versionInfo
} from '../../src/runtime/version-info.js';

test('the protocol revision comes from the schema $id, with the title as fallback', () => {
	assert.equal(
		parseProtocolRevision(JSON.stringify({ $id: 'urn:lantean-protocol:revision-1' })),
		1
	);
	assert.equal(
		parseProtocolRevision(JSON.stringify({ $id: 'urn:lantean-protocol:revision-12' })),
		12
	);
	assert.equal(
		parseProtocolRevision(JSON.stringify({ title: 'The Lantean protocol, revision 3' })),
		3,
		'the title answers when the $id does not'
	);
	assert.equal(parseProtocolRevision(JSON.stringify({ title: 'no revision here' })), null);
	assert.equal(parseProtocolRevision('not json at all'), null, 'garbage downgrades, never throws');
	assert.equal(parseProtocolRevision('{}'), null);
});

test('a source checkout reports the repository metadata', () => {
	// In the build output the same reads land on <out>/meta, which the build
	// step writes from these exact files - so asserting against the
	// repository copies here pins the CONTENT the deployed banner reports.
	const info = versionInfo();
	const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
	const schema = readFileSync(new URL('../../protocol.schema.json', import.meta.url), 'utf8');
	assert.equal(info.name, pkg.name);
	assert.equal(info.version, pkg.version);
	assert.equal(info.protocolRevision, parseProtocolRevision(schema));
	assert.notEqual(info.protocolRevision, null, 'the vendored schema declares a revision');
	assert.deepEqual(
		Object.keys(info.siblings),
		['svelte-realtime', 'svelte-adapter-uws-extensions'],
		'both family siblings are always reported, resolved or not'
	);
});

test('the banner names every part and never fabricates a version', () => {
	assert.equal(
		formatVersionBanner({
			name: 'svelte-adapter-bunserve',
			version: '0.0.1',
			protocolRevision: 1,
			siblings: { 'svelte-realtime': '0.4.2', 'svelte-adapter-uws-extensions': null }
		}),
		'svelte-adapter-bunserve 0.0.1 (protocol rev 1, svelte-realtime 0.4.2, ' +
			'svelte-adapter-uws-extensions not installed)'
	);
	// Degraded metadata degrades the LINE, never the boot: unknowns are
	// spelled out rather than guessed at.
	assert.equal(
		formatVersionBanner({ name: 'svelte-adapter-bunserve', version: null, protocolRevision: null, siblings: {} }),
		'svelte-adapter-bunserve unknown (protocol rev unknown)'
	);
});
