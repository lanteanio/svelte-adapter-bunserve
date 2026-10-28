import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HANDSHAKE } from '../helpers/handshake.mjs';

// A request target with a fragment is refused 400 on every lane, as
// svelte-adapter-uws refuses it, and counted as a malformed handshake where
// that adapter's WebSocket route would have taken the request: a GET on the
// path, the fragment in the query, a key 24 characters long. The path is the
// one Bun hands on, with dot segments already resolved.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = { allowedOrigins: 'any', path: '/ws', handler: 'src/ws-handler.js' };

const { invalidRequestTarget } = await import('../../src/runtime/utils/request-target.js');
const { countRefusedHandshakeTarget } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeRejectionCounts } = await import('../../src/runtime/handler/ws-state.js');

test('a fragment anywhere in the target is refused, and nothing else Bun hands on is', () => {
	for (const url of [
		'http://h/healthz#frag',
		'http://h/test.txt#part',
		'http://h/p?x=1#y',
		'http://h/p#',
		'http://h/#'
	]) {
		assert.equal(invalidRequestTarget(url), true, url);
	}
	// What Bun makes of the bytes uws refuses: escapes indistinguishable from a
	// client's own, so they are served as those escapes would be.
	for (const url of [
		'http://h/p',
		'http://h/caf%C3%A9',
		'http://h/a%EF%BF%BDb',
		'http://h/a%7Fb',
		'http://h/a%23b',
		'http://h/p?x=%23'
	]) {
		assert.equal(invalidRequestTarget(url), false, url);
	}
});

/** @param {string} target @param {Record<string, string>} [headers] @param {string} [method] */
const request = (target, headers = HANDSHAKE, method = 'GET') =>
	new Request('http://127.0.0.1' + target, { method, headers });

/** How many malformed handshakes `fn` counted. */
function counted(fn) {
	const before = upgradeRejectionCounts().malformed_handshake;
	fn();
	return upgradeRejectionCounts().malformed_handshake - before;
}

test('a handshake whose query carries a fragment is counted, as uws counts it', () => {
	assert.equal(counted(() => countRefusedHandshakeTarget(request('/ws?x=1#y'))), 1);
	assert.equal(counted(() => countRefusedHandshakeTarget(request('/ws?#'))), 1);
});

test('nothing else refused for its target is counted', () => {
	const short = { ...HANDSHAKE, 'sec-websocket-key': 'abc' };
	const none = { upgrade: 'websocket', connection: 'Upgrade' };
	for (const [label, req] of [
		['a fragment in the path, which misses the WebSocket route', request('/ws#x')],
		['a fragment in the path with a query after it', request('/ws#x?y=1')],
		['another path', request('/other?x=1#y')],
		['a HEAD', request('/ws?x=1#y', HANDSHAKE, 'HEAD')],
		['a key that is not 24 characters', request('/ws?x=1#y', short)],
		['no key', request('/ws?x=1#y', none)],
		['a navigation', request('/ws?x=1#y', {})]
	]) {
		assert.equal(counted(() => countRefusedHandshakeTarget(req)), 0, label);
	}
	// A Host the URL parser cannot read reaches `req.url` too (Bun builds it
	// from the Host value): the count reads the path by position, so such a
	// request is still answered 400 rather than throwing.
	const unparsable = {
		method: 'GET',
		url: 'http://a b/ws?x=1#y',
		headers: new Headers(HANDSHAKE),
		signal: new AbortController().signal
	};
	assert.throws(() => new URL(unparsable.url), 'the URL parser refuses it');
	assert.equal(counted(() => countRefusedHandshakeTarget(/** @type {any} */ (unparsable))), 1);
	// The target is read past the Host Bun built `req.url` from, so a Host
	// carrying a `/`, `?` or `#` does not move it, and a relative `req.url`
	// (an empty Host) is read from its start.
	/** @param {string} url @param {string | null} host */
	const standIn = (url, host) => {
		const headers = new Headers(HANDSHAKE);
		if (host !== null) headers.set('host', host);
		return /** @type {any} */ ({ method: 'GET', url, headers, signal: new AbortController().signal });
	};
	for (const [label, req, expected] of [
		['a Host spelling a path and a query in front of a target that is not the path', standIn('http://a/ws?/p#x', 'a/ws?'), 0],
		['a Host carrying a #, with the target the path and a plain query', standIn('http://a/#b/ws?x=1', 'a#b'), 0],
		['a relative url on the path', standIn('/ws?x=1#y', ''), 1],
		['a relative url on another path ending in the path', standIn('/x/ws?x=1#y', ''), 0],
		['a Host Bun rewrote (its default port dropped)', standIn('http://h/ws?x=1#y', 'h:80'), 1],
		['a Host Bun kept', standIn('http://h:8080/ws?x=1#y', 'h:8080'), 1]
	]) {
		assert.equal(counted(() => countRefusedHandshakeTarget(req)), expected, label);
	}
	// Two key lines, the first 24 characters long: uWS reads the first.
	const twoKeys = new Headers(HANDSHAKE);
	twoKeys.append('sec-websocket-key', 'abc');
	assert.equal(counted(() => countRefusedHandshakeTarget(request('/ws?x=1#y', twoKeys))), 1);
});

test('the target begins past the Host Bun built the URL from', async () => {
	const { targetStart } = await import('../../src/runtime/utils/request-target.js');
	const at = (url, host) => url.slice(targetStart(url, host));
	assert.equal(at('http://h/p?x=1', 'h'), '/p?x=1');
	assert.equal(at('http://a/healthz?/p', 'a/healthz?'), '/p', 'a Host carrying a path and a query');
	assert.equal(at('http://h/p', 'h:80'), '/p', 'a Host whose default port Bun dropped');
	assert.equal(at('http://example.com./p', 'EXAMPLE.com.'), '/p', 'a Host Bun lowered');
	assert.equal(at('/p?x', ''), '/p?x', 'no authority at all');
	assert.equal(at('/p?x', null), '/p?x');
	assert.equal(at('http://other.test/abs', 'h.test'), '/abs', 'an absolute-form target');
	assert.equal(at('http://h', 'h'), '', 'nothing after the authority');
});
