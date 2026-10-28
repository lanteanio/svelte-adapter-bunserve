import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { auditDeliveryScopes } from '../helpers/delivery-scope-audit.js';

it('preserves whole-call delivery scopes on production, testing and Vite', () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
	const files = ['src/testing.js', 'src/vite.js', ...readdirSync(path.join(root, 'src/runtime/handler')).filter(name => name.endsWith('.js')).map(name => 'src/runtime/handler/' + name)];
	const { unscoped, scopes } = auditDeliveryScopes(files.map(file => ({ file, source: readFileSync(path.join(root, file), 'utf8') })));
	// These callbacks are stored for one later invocation. The idle callback
	// runs inside the boundary's operation, and each cached topic call publishes once.
	const deferred = [
		'src/runtime/handler/ws.js:<module> -> setIdleHandler:callback',
		'src/runtime/handler/platform.js:platform.topic -> createTopicHelperCache:callback',
		'src/testing.js:platform.topic -> createTopicHelperCache:callback',
		'src/vite.js:platform.topic -> createTopicHelperCache:callback'
	];
	expect(unscoped.map(site => `${site.file}:${site.fn}:${site.kind}`).sort()).toEqual(deferred.sort());
	expect(Object.fromEntries([...scopes].filter(([, count]) => count > 0))).toEqual({
		'src/runtime/handler/coalesced.js': 1,
		'src/runtime/handler/platform.js': 8,
		'src/runtime/handler/resume-buffer.js': 1,
		'src/runtime/handler/ws.js': 1,
		'src/testing.js': 14,
		'src/vite.js': 11
	});
});
