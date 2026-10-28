import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originFromHeaders, OriginHeaderError, refusedHeaderSetting } from '../../src/runtime/utils/request-origin.js';
import { requestTarget } from '../../src/runtime/utils/request-target.js';

const direct = { isTls: false, hostHeader: '', protocolHeader: '', portHeader: '' };
const proxy = { isTls: false, hostHeader: 'x-host', protocolHeader: 'x-proto', portHeader: 'x-port' };

test('origin uses the family authority grammar and validates proxy components', () => {
	assert.equal(originFromHeaders(new Headers({ host: '[::1]:80' }), direct), 'http://[::1]:80');
	assert.equal(originFromHeaders(new Headers({ host: 'local', 'x-host': 'example.test:', 'x-proto': 'https', 'x-port': '443' }), proxy), 'https://example.test:443');
	for (const host of ['', 'a/path', 'a?query', 'a#fragment', 'u@h', 'a\\b', 'a b', 'a:80:80']) {
		assert.throws(() => originFromHeaders(new Headers({ host }), direct), OriginHeaderError, host);
	}
	for (const [name, value] of [['x-port', '-1'], ['x-port', '1e3'], ['x-port', '2.5'], ['x-proto', '%'], ['x-proto', 'ftp']]) {
		assert.throws(() => originFromHeaders(new Headers({ host: 'h', [name]: value }), proxy), OriginHeaderError);
	}
	assert.equal(refusedHeaderSetting('x-host', proxy, 'APP_'), 'APP_HOST_HEADER');
	assert.equal(refusedHeaderSetting('host', proxy, ''), null);
});

test('Host path, query and fragment never become the routed target', () => {
	for (const [url, host, expected] of [
		['http://a/healthz?/p', 'a/healthz?', '/p'],
		['http://a/#b/p?q=1', 'a#b', '/p?q=1'],
		['http://a/b/p', 'a\\b', '/p'],
		['http://host.example/p', 'host', '/p'],
		['http://h/p', 'h:80', '/p'],
		['/healthz', '', '/healthz']
	]) {
		assert.equal(requestTarget({ url, headers: new Headers({ host }) }), expected, host);
	}
});
