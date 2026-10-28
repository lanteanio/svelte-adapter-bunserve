import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { legacyDiagnosticPrefixes, parseDiagnostic } from '../../src/runtime/diagnostic.js';

const published = readFileSync(new URL('../../docs/legacy-diagnostic-prefixes.v1.json', import.meta.url));

test('the parser applies the published family-wide legacy prefix contract', () => {
	const contract = JSON.parse(published);
	assert.deepEqual(legacyDiagnosticPrefixes(), contract);
	assert.equal(new Set(contract.prefixes.map(row => row.prefix)).size, contract.prefixes.length);
	for (const row of contract.prefixes) {
		const { record } = parseDiagnostic(`[${row.prefix}] listener failed`);
		for (const key of ['source', 'component', 'event', 'severity']) assert.equal(record[key], row[key], row.prefix);
	}
	const families = [
		['svelte-adapter-uws/runtime.listener', 'svelte-adapter-uws', 'runtime.listener'],
		['svelte-adapter-bunserve/runtime.listener', 'svelte-adapter-bunserve', 'runtime.listener'],
		['svelte-adapter-ws/runtime.listener', 'svelte-adapter-ws', 'runtime.listener'],
		['worker 7', 'svelte-adapter-uws', 'runtime.worker'],
		['group lobby', 'svelte-adapter-uws', 'plugins.groups'],
		['postgres/notify', 'svelte-adapter-uws-extensions', 'runtime.postgres.notify']
	];
	assert.equal(families.length, contract.families.length);
	for (const [prefix, source, component] of families) {
		const { record } = parseDiagnostic(`[${prefix}] listener failed`, { defaultSeverity: 'error' });
		assert.equal(record.source, source);
		assert.equal(record.component, component);
		assert.equal(record.severity, 'error');
	}
	for (const prefix of ['adapter-wsx', 'svelte-adapter-ws/', 'svelte-adapter-ws/bad component']) {
		assert.equal(parseDiagnostic(`[${prefix}] listener failed`), null);
	}
});

test('the installed lead legacy prefix table matches byte for byte', { skip: !process.env.UWS_REPO }, () => {
	const lead = readFileSync(resolve(process.env.UWS_REPO, 'docs/legacy-diagnostic-prefixes.v1.json'));
	assert.deepEqual(published, lead);
});
