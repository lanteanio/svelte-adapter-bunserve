import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../src/index.js';
import { normalizeBodyLimits, requestBodyLimit, serializeBodyLimits } from '../../src/runtime/utils/body-limits.js';

const rules = normalizeBodyLimits([
 { path: '/base/avatar', bytes: 30 },
 { path: '/base/admin', prefix: true, bytes: 50, methods: ['POST', 'PUT'] },
 { path: '/base/admin/media', bytes: 100 }
]);
for (const path of ['/base/avatar', '/base/avatar/', '/base/%61vatar?x=1', '/base/x/../avatar', '/base//avatar', '//base/avatar', String.raw`/\base/avatar`, '//base//avatar/', String.raw`/\/base/avatar`]) {
 test(`canonical body budget: ${path}`, () => assert.equal(requestBodyLimit(rules, 'POST', path, 200), 30));
}
test('matching rules narrow the global ceiling and retain method/segment boundaries', () => {
 for (const [method, path, ceiling, result] of [
  ['POST', '/base/admin/media', 200, 50], ['POST', '/base/admin/media', 20, 20],
  ['PATCH', '/base/admin/media', 200, 100], ['POST', '/base/administrator', 200, 200],
  ['POST', '/avatar', 200, 200], ['POST', '/%broken', 200, 0]
 ]) assert.equal(requestBodyLimit(rules, method, path, ceiling), result);
 assert.equal(requestBodyLimit(normalizeBodyLimits([{ path: '/x', bytes: 0 }]), 'POST', '/x', Infinity), 0);
 assert.equal(requestBodyLimit(normalizeBodyLimits([{ path: '/', prefix: true, bytes: 2 }]), 'POST', '/anything', 5), 2);
});
test('build substitution remains valid inside its global declaration comment', () => {
 const rules = normalizeBodyLimits([{ path: '/a*/b', bytes: 1 }]);
 const text = serializeBodyLimits(rules);
 assert.deepEqual(new Function(`/* global ${text} */ return ${text};`)(), rules);
});
for (const value of [null, {}, [{ path: '/x', bytes: Infinity }], [{ path: '/x', bytes: -1 }],
 [{ path: '/x', bytes: 1.5 }], [{ path: '/x', bytes: 1, methods: [] }],
 [{ path: '/x', bytes: 1, methods: ['post'] }], [{ path: '/x', bytes: 1, prefix: 'yes' }],
 [{ path: '/x?query', bytes: 1 }], [{ path: '/x/../y', bytes: 1 }], [{ path: '/x', bytes: 1, extra: true }],
 ...[['GET'], ['HEAD'], ['POST', 'GET'], ['PUT', 'HEAD']].map(methods => [{ path: '/x', bytes: 1, methods }])]) {
 test(`invalid body rule ${JSON.stringify(value)}`, () => assert.throws(() => adapter({ bodyLimits: value }), /bodyLimits/));
}
test('adapter returns normalized metadata for its dev plugin', () => {
 assert.deepEqual(adapter({ bodyLimits: [{ path: '/x/', bytes: 5, methods: ['POST', 'POST'] }] }).bodyLimits,
 [{ path: '/x', prefix: false, bytes: 5, methods: ['POST'] }]);
});
