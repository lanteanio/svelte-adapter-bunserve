import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUpgradeOriginAllowed } from '../../src/runtime/utils/ws-origin.js';

const SELF = 'https://app.example';

test('same-origin allows the server own origin and denies a foreign one', () => {
	assert.equal(isUpgradeOriginAllowed('https://app.example', SELF, 'same-origin'), true);
	assert.equal(isUpgradeOriginAllowed('https://evil.example', SELF, 'same-origin'), false);
});

test('same-origin is scheme- and port-sensitive', () => {
	// http:// and https:// on the same host are different origins, and so is a
	// different port - a downgrade or a neighbouring dev server must not pass.
	assert.equal(isUpgradeOriginAllowed('http://app.example', SELF, 'same-origin'), false);
	assert.equal(isUpgradeOriginAllowed('https://app.example:8443', SELF, 'same-origin'), false);
});

test('a subdomain is not the same origin', () => {
	assert.equal(isUpgradeOriginAllowed('https://evil.app.example', SELF, 'same-origin'), false);
	assert.equal(isUpgradeOriginAllowed('https://app.example.evil.com', SELF, 'same-origin'), false);
});

test('a missing Origin is allowed (non-browser clients)', () => {
	// The header is only trustworthy because browsers set it and refuse to let
	// script forge it. Anything that can omit it can also forge it, so denying
	// on absence breaks curl and native clients for no security gain.
	assert.equal(isUpgradeOriginAllowed(null, SELF, 'same-origin'), true);
	assert.equal(isUpgradeOriginAllowed(undefined, SELF, 'same-origin'), true);
});

test('an EMPTY Origin is not absence, and is denied', () => {
	// Absence means the header was never sent. Empty means something sent it
	// and put nothing in it - which no browser does, since an opaque origin
	// serialises to the string "null". Reachable from a misbehaving proxy, and
	// "present but empty" is not evidence of a trusted non-browser client.
	assert.equal(isUpgradeOriginAllowed('', SELF, 'same-origin'), false);
	assert.equal(isUpgradeOriginAllowed('   ', SELF, 'same-origin'), false);
	assert.equal(isUpgradeOriginAllowed('', SELF, ['https://a.example']), false);
	assert.equal(isUpgradeOriginAllowed('', SELF, 'any'), true, 'unless the check is off');
});

test('the literal "null" origin is NOT treated as missing', () => {
	// A sandboxed iframe or a file:// page sends the four characters "null".
	assert.equal(isUpgradeOriginAllowed('null', SELF, 'same-origin'), false);
	assert.equal(isUpgradeOriginAllowed('null', SELF, ['https://a.example']), false);
	assert.equal(isUpgradeOriginAllowed('null', SELF, 'any'), true);
});

test("'any' disables the check entirely", () => {
	assert.equal(isUpgradeOriginAllowed('https://evil.example', SELF, 'any'), true);
	assert.equal(isUpgradeOriginAllowed(null, SELF, 'any'), true);
});

test("'*' is accepted as the family spelling of 'any'", () => {
	// The uWS-shaped names exist so one svelte.config.js moves across the
	// family, and '*' is what the rest of the family documents.
	assert.equal(isUpgradeOriginAllowed('https://evil.example', SELF, '*'), true);
	assert.equal(isUpgradeOriginAllowed(null, SELF, '*'), true);
});

test('an explicit list matches exactly, and self is not implicitly allowed', () => {
	const list = ['https://a.example', 'https://b.example'];
	assert.equal(isUpgradeOriginAllowed('https://a.example', SELF, list), true);
	assert.equal(isUpgradeOriginAllowed('https://b.example', SELF, list), true);
	assert.equal(isUpgradeOriginAllowed('https://c.example', SELF, list), false);
	// Opting into a list means the list is the whole answer: if the app also
	// wants its own origin it has to say so, rather than the check quietly
	// widening beyond what was configured.
	assert.equal(isUpgradeOriginAllowed(SELF, SELF, list), false);
});

test('comparison ignores case and a trailing slash', () => {
	// Browsers send neither, but hand-written config carries both.
	assert.equal(isUpgradeOriginAllowed('HTTPS://APP.EXAMPLE', SELF, 'same-origin'), true);
	assert.equal(isUpgradeOriginAllowed('https://app.example/', SELF, 'same-origin'), true);
	assert.equal(isUpgradeOriginAllowed('https://a.example', SELF, ['https://A.example/']), true);
});

test('an empty allow-list denies every present origin', () => {
	assert.equal(isUpgradeOriginAllowed('https://a.example', SELF, []), false);
	// Absence still passes: the list governs which origins are allowed, not
	// whether the header is mandatory.
	assert.equal(isUpgradeOriginAllowed(null, SELF, []), true);
});
