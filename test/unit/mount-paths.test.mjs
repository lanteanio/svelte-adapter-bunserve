// Every path the adapter mounts is matched on the request target exactly as a
// client sends it. A configured mount that no client sends as spelled, or two
// mounts claiming the same requests, is refused where the config is read: the
// adapter factory and the dev plugin here, createTestServer in
// test/public-native/mount-paths-real.test.js.
//
// What the rule must admit is decided by real clients against a real Bun
// server, in the native test: a spelling is admissible exactly when fetch and
// node:http, each handed the path a person would write, reach it as written.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../src/index.js';
import uws from '../../src/vite.js';
import { mountPathProblem } from '../../src/runtime/utils/mount-path.js';

const BACKSLASH = String.fromCharCode(92);

describe('mount path refusals', () => {
	for (const [value, why] of [
		['/gesundheit-prüfung', /"ü" \(U\+00FC\), which clients send percent-encoded; write the path as "\/gesundheit-pr%C3%BCfung"/],
		['/a b', /U\+0020.*write the path as "\/a%20b"/],
		['/a#b', /"#".*"\/a%23b"/],
		['/a?b', /"\?".*"\/a%3Fb"/],
		['/pr%c3%bcfung', /lowercase hex.*"\/pr%C3%BCfung"/],
		['/%70ath', /escapes a character clients send as it is; write the path as "\/path"/],
		['/a%2Fb', /"%2F", an encoded "\/"/],
		['/a%zzb', /starts no two-digit escape/],
		['/a%FFb', /do not decode to UTF-8/],
		['/a%09b', /contains a tab, which the URL parser removes from every path, so no client can request it/],
		['/a%0Ab', /contains a line feed/],
		['/a%0Db', /contains a carriage return/],
		['/a' + String.fromCharCode(9) + 'b', /contains a tab/],
		['/a/../b', /"\.\." segment/],
		['/a/%2E/b', /"\." segment/],
		['/a' + BACKSLASH + 'b', /"\\", which browsers send as "\/"/],
		['/a%5Cb', /"%5C", an encoded "\\"/],
		['/:id', /segment starting with ":"/],
		['/x/*', /segment starting with "\*"/],
		['/%3Aid', /segment starting with ":"/],
		['healthz', /starting with '\/'/]
	]) {
		test(`refuses ${JSON.stringify(value)} and says why`, () => {
			assert.match(mountPathProblem(value) ?? '', why);
		});
	}

	test('admits a literal percent sign only as %25', () => {
		assert.equal(mountPathProblem('/a%25b'), null);
		assert.equal(mountPathProblem('/a%2525'), null);
		assert.match(mountPathProblem('/a%b') ?? '', /starts no two-digit escape/);
	});

	test('admits router syntax inside a segment, uppercase escapes and the defaults', () => {
		for (const value of [
			'/healthz', '/readyz', '/ws', '/__ws/auth', '/__realtime', '/__waiting-room', '/__admit-check', '/__uws/dashboard',
			'/status:live', '/ops:1', '/ops*', '/v1/things:batchGet', '/gesundheit-pr%C3%BCfung', '/a%20b', '/a%3Fb',
			'/a/b/', '/a//b', "/~u/it's(1);a=b@c", '/a|b'
		]) {
			assert.equal(mountPathProblem(value), null, value);
		}
	});

	test('names the plain ASCII a prefix mount may use instead of an escaped spelling', () => {
		assert.equal(mountPathProblem('/__ops', { prefix: true }), null);
		assert.match(mountPathProblem('/ops%C3%BC', { prefix: true }) ?? '', /prefix mount is spelled in plain ASCII \(letters, digits/);
		for (const value of ['/betrieb-übersicht', '/a b', '/a"b', '/a<b>', '/a^b', '/a`b', '/a{b}', '/a#b', '/a?b']) {
			const problem = mountPathProblem(value, { prefix: true }) ?? '';
			assert.match(problem, /a prefix mount takes no escapes; spell it in plain ASCII \(letters, digits/, value);
			assert.doesNotMatch(problem, /write the path as/, value);
		}
	});
});

describe('adapter options', () => {
	const refusal = (opts) => {
		try {
			adapter(opts);
		} catch (error) {
			return /** @type {Error} */ (error).message;
		}
		return null;
	};

	for (const [option, opts] of [
		['healthCheckPath', { healthCheckPath: '/gesundheit-prüfung' }],
		['readinessCheckPath', { readinessCheckPath: '/ready?' }],
		['websocket.path', { websocket: { path: '/w s' } }],
		['websocket.authPath', { websocket: { authPath: '/auth%2F' } }],
		['websocket.adminPath', { websocket: { adminPath: '/:ops' } }],
		['websocket.adminPath', { websocket: { adminPath: '/ops%C3%BC' } }],
		['websocket.upgradeAdmission.waitingRoom.path', { websocket: { upgradeAdmission: { maxConcurrent: 10, waitingRoom: { path: '/warte#raum' } } } }],
		['websocket.upgradeAdmission.waitingRoom.admitCheckPath', { websocket: { upgradeAdmission: { perTickBudget: 8, waitingRoom: { admitCheckPath: '/a/../check' } } } }]
	]) {
		test(`refuses an unreachable ${option} (${JSON.stringify(opts)})`, () => {
			const message = refusal(opts) ?? '';
			assert.ok(message.includes(option + ' '), message);
			assert.ok(message.includes('matched on the request target exactly as a client sends it'), message);
		});
	}

	test('admits the spellings the router matches', () => {
		assert.equal(refusal({ healthCheckPath: '/status:live', readinessCheckPath: '/gesundheit-pr%C3%BCfung', websocket: { adminPath: '/ops:1' } }), null);
		assert.equal(refusal({ websocket: { upgradeAdmission: { maxConcurrent: 4, waitingRoom: { path: '/warte%20raum' } } } }), null);
	});

	test('refuses two mounts on one path and an exact mount under the admin prefix', () => {
		assert.match(refusal({ healthCheckPath: '/ws', websocket: true }) ?? '', /healthCheckPath \("\/ws"\) must differ from websocket\.path/);
		assert.match(refusal({ websocket: { adminPath: '/__ops', authPath: '/__ops/auth' } }) ?? '', /websocket\.authPath \("\/__ops\/auth"\) sits at or under websocket\.adminPath/);
		assert.match(refusal({ healthCheckPath: '/__realtime/health', websocket: true }) ?? '', /sits at or under websocket\.adminPath/);
		assert.match(refusal({ websocket: { upgradeAdmission: { maxConnections: 5, waitingRoom: { admitCheckPath: '/readyz' } } } }) ?? '',
			/admitCheckPath \("\/readyz"\) must differ from readinessCheckPath/);
	});

	test('accepts nested and trailing-slash exact mounts, and ignores what an inactive feature would mount', () => {
		assert.equal(refusal({ healthCheckPath: '/health', readinessCheckPath: '/health/ready', websocket: true }), null);
		// The router routes /healthz and /healthz/ separately.
		assert.equal(refusal({ healthCheckPath: '/healthz', readinessCheckPath: '/healthz/' }), null);
		assert.equal(refusal({ healthCheckPath: '/ws', websocket: false }), null);
		assert.equal(refusal({ healthCheckPath: '/__realtime/health', websocket: { adminPath: false } }), null);
		assert.equal(refusal({ healthCheckPath: '/__admit-check', websocket: true }), null);
		assert.equal(refusal({ healthCheckPath: '/__admit-check', websocket: { upgradeAdmission: { maxConcurrent: 1, waitingRoom: false } } }), null);
	});

	test('keeps null and an empty healthCheckPath meaning no liveness route', () => {
		assert.equal(refusal({ healthCheckPath: null }), null);
		assert.equal(refusal({ healthCheckPath: '' }), null);
		assert.equal(refusal({ healthCheckPath: '', readinessCheckPath: '/healthz' }), null);
	});

	test('describes a value JSON cannot render without throwing', () => {
		const circular = {};
		circular.self = circular;
		assert.match(refusal({ healthCheckPath: 10n }) ?? '', /healthCheckPath.* - got 10n\./);
		assert.match(refusal({ readinessCheckPath: '/r', healthCheckPath: circular }) ?? '', /got \[object Object\]\./);
	});
});

describe('dev plugin options', () => {
	test('refuses an unreachable endpoint or dashboard path', () => {
		assert.throws(() => uws({ handler: '/x', path: '/w s' }), /websocket\.path contains U\+0020/);
		assert.throws(() => uws({ handler: '/x', authPath: '/auth?x' }), /websocket\.authPath contains "\?"/);
		assert.throws(() => uws({ handler: '/x', dashboard: { path: '/diagnose-übersicht' } }), /dashboard\.path contains "ü"/);
		assert.throws(() => uws({ handler: '/x', dashboard: { path: '/diagnose-%C3%BCbersicht' } }), /dashboard\.path contains an escape/);
	});

	test('refuses an endpoint the dashboard prefix would answer', () => {
		assert.throws(() => uws({ handler: '/x', authPath: '/__diag/auth', dashboard: { path: '/__diag' } }),
			/websocket\.authPath \("\/__diag\/auth"\) sits at or under the uws\(\) dev plugin option dashboard\.path/);
		// The dashboard beneath an exact endpoint answers paths the endpoint never does.
		assert.doesNotThrow(() => uws({ handler: '/x', authPath: '/__diag', dashboard: { path: '/__diag/board' } }));
	});

	const kitConfig = (adapterFields) => ({
		root: process.cwd(),
		build: { ssr: true },
		plugins: [{
			name: 'vite-plugin-sveltekit-setup',
			api: { options: { kit: { adapter: { name: 'adapter-bunserve', websocketHandler: null, websocketPath: null, websocketAuthPath: null, ...adapterFields } } } }
		}]
	});

	test('checks the adapter-declared endpoints once it reads them', async () => {
		await assert.rejects(uws({ dashboard: { path: '/__ws' } }).configResolved(kitConfig({})),
			/websocket\.authPath \("\/__ws\/auth"\) sits at or under the uws\(\) dev plugin option dashboard\.path/);
		await assert.rejects(uws().configResolved(kitConfig({ websocketPath: '/w s' })), /websocket\.path contains U\+0020/);
		await assert.rejects(uws().configResolved(kitConfig({ websocketAuthPath: '/auth%c3%bc' })),
			/websocket\.authPath writes an escape in lowercase hex/);
	});
});
