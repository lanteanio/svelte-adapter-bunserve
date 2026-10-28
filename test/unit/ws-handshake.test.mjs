import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	WEBSOCKET_VERSION,
	isWebSocketUpgradeAttempt,
	readHandshake,
	webSocketHandshakeRefusal
} from '../../src/runtime/utils/ws-handshake.js';

// svelte-adapter-uws's handshake rule, over the Headers a Bun fetch handler is
// given. `Headers#append` joins a repeated line with ", " exactly as Bun's
// server does (probe/bun-api-facts.report.md, repeated-headers), so these are
// the values the rule meets in production.

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
/** @type {Array<[string, string]>} */
const NORMAL = [
	['Connection', 'keep-alive, UpGrAdE'],
	['Upgrade', 'WebSocket'],
	['Sec-WebSocket-Version', '13'],
	['Sec-WebSocket-Key', KEY]
];
const without = (name) => NORMAL.filter(([k]) => k !== name);
const replaced = (name, value) => NORMAL.map(([k, v]) => [k, k === name ? value : v]);
const repeated = (name) => [...NORMAL, NORMAL.find(([k]) => k === name)];

/** @param {Array<[string, string]>} lines */
function read(lines) {
	const headers = new Headers();
	for (const [name, value] of lines) headers.append(name, value);
	return readHandshake(headers);
}

/** svelte-adapter-uws's raw-socket set, with the answers that adapter gives. */
const CASES = [
	['a complete handshake', NORMAL, null],
	['no Upgrade', without('Upgrade'), 400],
	['no Connection', without('Connection'), 400],
	['no key', without('Sec-WebSocket-Key'), 400],
	['an Upgrade naming another protocol', replaced('Upgrade', 'not-websocket'), 400],
	['a Connection without upgrade', replaced('Connection', 'keep-alive'), 400],
	['a 24-character key that is not base64', replaced('Sec-WebSocket-Key', '!'.repeat(24)), 400],
	['a short key', replaced('Sec-WebSocket-Key', 'a'), 400],
	['a key with its unused bits set', replaced('Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZR=='), 400],
	['Upgrade twice', repeated('Upgrade'), 400],
	['the key twice', repeated('Sec-WebSocket-Key'), 400],
	['the version twice', repeated('Sec-WebSocket-Version'), 400],
	['version 12', replaced('Sec-WebSocket-Version', '12'), 426],
	['a version that is not a number', replaced('Sec-WebSocket-Version', '13a'), 426],
	['upgrade listed on a second Connection line', [...without('Connection'), ['Connection', 'keep-alive'], ['Connection', 'Upgrade']], null],
	['no version', without('Sec-WebSocket-Version'), 426],
	['a websocket Upgrade with no key', [['Connection', 'Upgrade'], ['Upgrade', 'websocket']], 400]
];

test('answers each of svelte-adapter-uws\'s handshake cases as that adapter does', () => {
	for (const [name, lines, expected] of CASES) {
		assert.equal(webSocketHandshakeRefusal(read(lines)), expected, name);
	}
});

test('counts a repeated line, which Bun hands over joined, as two', () => {
	assert.equal(webSocketHandshakeRefusal(read(repeated('Sec-WebSocket-Version'))), 400, 'two version lines, even equal ones');
	// An empty line is still a line: Bun keeps it as an empty value, and joins
	// it to its neighbour with the same separator.
	assert.equal(webSocketHandshakeRefusal(read([...NORMAL, ['Sec-WebSocket-Version', '']])), 400);
	assert.equal(webSocketHandshakeRefusal(read([['Sec-WebSocket-Version', ''], ...without('Sec-WebSocket-Version'), ['Sec-WebSocket-Version', '13']])), 400);
	assert.equal(webSocketHandshakeRefusal(read(replaced('Connection', 'keep-alive, upgraded'))), 400);
});

test('reads one line listing several values as several lines, the two readings uws gives otherwise', () => {
	// uws answers 426 to one version line `13, 8`; that line and two version
	// lines arrive here as the same value.
	assert.equal(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Version', '13, 8'))), 400);
	// uws treats one Upgrade line `websocket, h2c` with no key as a request that
	// is not a handshake; here it reads as two Upgrade lines, the first websocket.
	assert.equal(isWebSocketUpgradeAttempt(read([['Upgrade', 'websocket, h2c']])), true);
	assert.equal(isWebSocketUpgradeAttempt(read([['Upgrade', 'h2c, websocket']])), false);
});

test('accepts only the canonical encoding of 16 octets as a key', () => {
	for (const last of 'AQgw') {
		assert.equal(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Key', 'A'.repeat(21) + last + '=='))), null, last);
	}
	for (const last of 'BRhx') {
		assert.equal(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Key', 'A'.repeat(21) + last + '=='))), 400, last);
	}
	assert.equal(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Key', 'A'.repeat(24)))), 400);
});

test('answers 426 for any single version but 13, and only for an otherwise complete handshake', () => {
	assert.equal(WEBSOCKET_VERSION, '13');
	for (const version of ['8', '12', '13a', 'thirteen', '']) {
		assert.equal(webSocketHandshakeRefusal(read(replaced('Sec-WebSocket-Version', version))), 426, version);
	}
	assert.equal(webSocketHandshakeRefusal(read(without('Sec-WebSocket-Version'))), 426);
	assert.equal(
		webSocketHandshakeRefusal(read([...without('Upgrade').filter(([k]) => k !== 'Sec-WebSocket-Version'), ['Sec-WebSocket-Version', '8']])),
		400,
		'a missing Upgrade answers first'
	);
});

test('folds case and trims in ASCII only', () => {
	assert.equal(webSocketHandshakeRefusal(read(replaced('Upgrade', 'WEBSOCKET'))), null);
	assert.equal(webSocketHandshakeRefusal(read(replaced('Connection', 'keep-alive,\tUPGRADE '))), null);
	// A Kelvin sign lowers to `k` under Unicode case mapping; it is not an
	// ASCII letter to uWS, and not here. Handed the character itself, with
	// `websocket`'s length so the comparison has to fold it to answer:
	const KELVIN = 'websoc' + String.fromCharCode(0x212a) + 'et';
	const kelvin = { ...read(NORMAL), upgrade: KELVIN };
	assert.equal(KELVIN.toLowerCase(), 'websocket', 'the case a Unicode fold would accept');
	assert.equal(webSocketHandshakeRefusal(kelvin), 400);
	// What Bun actually hands over: the header's bytes, one character each.
	// No Latin-1 character lowers onto an ASCII letter, so this reading is
	// refused on its length before folding could matter.
	assert.equal(webSocketHandshakeRefusal(read(replaced('Upgrade', 'websoc' + String.fromCharCode(0xe2, 0x84, 0xaa) + 'et'))), 400);
	// A vertical tab is whitespace to String#trim and not to uWS. Bun and uWS
	// both refuse one in a header value with 400 in their parsers, before any
	// handler runs; the rule refuses it too where it is handed one.
	assert.equal(webSocketHandshakeRefusal(read(replaced('Connection', 'keep-alive,\u000bupgrade'))), 400);
});

test('counts a websocket Upgrade or any key as an attempt, and nothing else', () => {
	assert.equal(isWebSocketUpgradeAttempt(read([['Upgrade', 'WebSocket']])), true);
	assert.equal(isWebSocketUpgradeAttempt(read([['Sec-WebSocket-Key', '']])), true);
	assert.equal(isWebSocketUpgradeAttempt(read([['Connection', 'Upgrade'], ['Upgrade', 'h2c']])), false);
	assert.equal(isWebSocketUpgradeAttempt(read([])), false);
	assert.equal(isWebSocketUpgradeAttempt(read([['Upgrade', 'websocket'], ['Upgrade', 'websocket']])), true, 'two websocket lines');
});
