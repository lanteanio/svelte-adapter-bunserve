import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCanonicalHostAliases } from '../../src/runtime/utils/canonical-host.js';

test('canonical aliases are disabled without requiring an origin', () => {
	assert.deepEqual(parseCanonicalHostAliases(' ', undefined), []);
});

test('canonical aliases preserve explicit ports and deduplicate case-insensitively', () => {
	assert.deepEqual(parseCanonicalHostAliases(' Old.Example,old.example,old.example:80,[::1]:8080 ', 'https://canonical.example'), ['old.example', 'old.example:80', '[::1]:8080']);
});

test('canonical aliases refuse invalid origins and equivalent self aliases', () => {
	for (const origin of [undefined, 'ftp://canonical.example', 'https://user:pass@canonical.example', 'https://canonical.example/path', 'https://canonical.example/?q=1', 'https://canonical.example/#x']) {
		assert.throws(() => parseCanonicalHostAliases('old.example', origin), /requires ORIGIN/);
	}
	for (const alias of ['canonical.example', 'CANONICAL.EXAMPLE:443']) {
		assert.throws(() => parseCanonicalHostAliases(alias, 'https://canonical.example'), /canonical ORIGIN/);
	}
});

test('canonical aliases refuse malformed authorities', () => {
	for (const alias of ['old.example,', 'user@old.example', 'old.example/path', 'old.example:', 'old.example:99999', '[not-ipv6]']) {
		assert.throws(() => parseCanonicalHostAliases(alias, 'https://canonical.example'), /host authorities/);
	}
});
