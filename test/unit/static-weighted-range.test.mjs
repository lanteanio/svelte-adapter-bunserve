import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStaticResponse } from '../../src/runtime/utils/static-plan.js';

const entry = { etag: 'W/"a"', brEtag: 'W/"a-br"', gzEtag: 'W/"a-gzip"', hasBr: true, hasGz: true, brSize: 10, gzSize: 20 };
for (const [accept, encoding] of [['gzip, br;q=0', 'gzip'], ['gzip;q=1, br;q=0.5', 'gzip'], ['*', 'br']]) {
	test(`range coordinates follow weighted negotiation: ${accept}`, () => {
		assert.deepEqual(planStaticResponse(entry, 100, 'bytes=0-3', '', '', accept), { status: 206, encoding, start: 0, end: 3 });
		assert.deepEqual(planStaticResponse(entry, 100, 'bytes=-0', '', '', accept), { status: 416, encoding });
		assert.deepEqual(planStaticResponse(entry, 100, 'bytes=0-3', '', encoding === 'br' ? entry.brEtag : entry.gzEtag, accept), { status: 304, encoding });
	});
}
