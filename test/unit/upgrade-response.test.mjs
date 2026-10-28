import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeResponse } from '../../src/upgrade-response.js';
import { snapshotUpgradeHeaders, warnSetCookieOnUpgradeOnce } from '../../src/runtime/utils/upgrade-headers.js';

test('upgradeResponse preserves data and optional headers', () => {
	const data = { user: 'test' };
	assert.deepEqual(upgradeResponse(data), { __upgradeResponse: true, userData: data, headers: undefined });
	const headers = { 'set-cookie': ['first=1', 'second=2'], 'x-value': 'a\tb\u00e9' };
	assert.equal(upgradeResponse(data, headers).headers, headers);
	assert.doesNotThrow(() => upgradeResponse(data, { 'sec-websocket-version': '13', 'content-length': '0', 'transfer-encoding': 'chunked' }));
});

for (const headers of [
	{ connection: 'upgrade' }, { Date: 'Mon, 01 Jan 2001 00:00:00 GMT' }, { upgrade: 'websocket' }, { 'Sec-WebSocket-Accept': 'wrong' },
	{ 'sec-websocket-extensions': 'none' }, { 'sec-websocket-protocol': 'v1' },
	{ 'bad name': 'value' }, { 'x-value': 'bad\r\nsplit' }, { 'x-value': '\x00' },
	{ 'x-value': '\x7f' }, { 'x-value': '\u0100' }, { 'x-value': 3 },
	{ 'set-cookie': ['safe=1', 3] }, ['value'], 'value'
]) {
	test(`refuses unsafe upgrade headers ${JSON.stringify(headers)}`, () => {
		assert.throws(() => upgradeResponse({}, headers), TypeError);
		assert.throws(() => snapshotUpgradeHeaders(headers), TypeError);
	});
}

test('snapshots arrays once before later getters can mutate them', () => {
	const cookies = ['first=1', 'second=2'];
	const headers = { 'set-cookie': cookies, get later() { cookies[0] = 'bad\r\nsplit'; return 'value'; } };
	assert.deepEqual(snapshotUpgradeHeaders(headers)['set-cookie'], ['first=1', 'second=2']);
});

test('array snapshots do not call application iterators or slice', () => {
	const cookies = ['first=1', 'second=2'];
	cookies[Symbol.iterator] = () => { throw Error('iterator'); };
	cookies.slice = () => { throw Error('slice'); };
	assert.deepEqual(snapshotUpgradeHeaders({ 'set-cookie': cookies })['set-cookie'], ['first=1', 'second=2']);
});

test('Set-Cookie advisory is case-insensitive and emitted once per worker', () => {
	const previous = console.warn;
	const warnings = [];
	console.warn = message => warnings.push(message);
	try {
		warnSetCookieOnUpgradeOnce({ 'x-test': 'value' });
		assert.equal(warnings.length, 0);
		warnSetCookieOnUpgradeOnce({ 'Set-Cookie': 'one=1' });
		warnSetCookieOnUpgradeOnce({ 'set-cookie': ['two=2'] });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /Cloudflare Tunnel/);
		assert.match(warnings[0], /authenticate/);
	} finally { console.warn = previous; }
});
