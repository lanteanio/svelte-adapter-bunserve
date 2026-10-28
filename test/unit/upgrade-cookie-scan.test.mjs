import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSetCookieOnUpgrade } from '../../src/upgrade-cookie-scan.js';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';
test('empty handler names retain automatic discovery', () => {
 assert.equal(normalizeWsOptions({ handler: '' }).options.handler, '');
});
test('upgrade cookie scan finds literal response cookies within nested calls', () => {
 assert.equal(detectSetCookieOnUpgrade("upgradeResponse(user, { 'Set-Cookie': makeCookie(value) })"), true);
 assert.equal(detectSetCookieOnUpgrade("upgradeResponse({ value: nested(')') }, { \"set-cookie\": 'session=1' })"), true);
 assert.equal(detectSetCookieOnUpgrade("upgradeResponse(user, { 'x-test': 'value' }); fn('set-cookie')"), false);
 assert.equal(detectSetCookieOnUpgrade("new Response(body, { headers: { 'set-cookie': 'a=1' } })"), false);
});
