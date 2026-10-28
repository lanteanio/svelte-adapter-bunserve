import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The production branch of the framework assertions: a violation is logged and
// counted and never thrown by the check, a fatal one schedules exit 78, and
// devAssert does nothing at all - plus what the code behind each check does in
// that branch. This process runs in test mode, where the same calls throw, and
// the mode is read once when the module loads - so the production side runs in
// a child process with NODE_ENV=production (test/helpers/production-mode.mjs)
// and reports back what it observed. Node and Bun both take `--conditions=`, so
// the child runs on whichever runtime runs this file.

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env, NODE_ENV: 'production' };
delete env.VITEST;
// An inherited preload could put the child back into test mode.
delete env.NODE_OPTIONS;
const child = spawnSync(
	process.execPath,
	['--conditions=bunserve-test', 'test/helpers/production-mode.mjs'],
	{ cwd: root, env, encoding: 'utf8', timeout: 30_000 }
);

/** @returns {any} */
function observed() {
	assert.equal(child.status, 0, `the production-mode script failed:\n${child.stderr}`);
	const last = child.stdout.trim().split('\n').at(-1);
	return JSON.parse(last ?? '');
}

const LINE = /^\[lantean\/diagnostic source=svelte-adapter-bunserve component=runtime\.assertion event=invariant\.violated severity=(warn|fatal)\] ([a-z.-]+) (\{.*\})$/;

/** The diagnostic lines logged for one category, parsed. */
function linesFor(/** @type {string} */ category) {
	return observed().lines
		.map((/** @type {string} */ line) => LINE.exec(line))
		.filter((/** @type {RegExpExecArray | null} */ m) => m !== null && m[2] === category)
		.map((/** @type {RegExpExecArray} */ m) => ({ severity: m[1], record: JSON.parse(m[3]) }));
}

test('a connection whose request id did not arrive still opens, with a minted id', () => {
	const seen = observed();
	assert.deepEqual(seen.carryOpen, {}, 'the open completed without throwing');
	assert.match(seen.mintedId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('and the missing id is counted and logged rather than thrown', () => {
	assert.equal(observed().counts['ws.request-id-carry'], 1);
	const logged = linesFor('ws.request-id-carry');
	assert.equal(logged.length, 1);
	assert.equal(logged[0].severity, 'warn');
	assert.deepEqual(logged[0].record, {
		schemaVersion: 1,
		occurredAt: null,
		source: 'svelte-adapter-bunserve',
		component: 'runtime.assertion',
		event: 'invariant.violated',
		severity: 'warn',
		level: 'warn',
		dataClass: 'operational',
		message: 'ws.request-id-carry',
		attributes: { category: 'ws.request-id-carry', context: null }
	});
});

test('a socket that opens without its permit is left unbuilt until the exit', () => {
	const seen = observed();
	assert.deepEqual(seen.strayOpen, {}, 'the check itself does not throw');
	assert.deepEqual(seen.stray, { platform: false, subscriptions: false, sent: 0, registered: false });
	assert.equal(seen.counts['ws.connection-permit-carrier'], 1);
	assert.deepEqual(linesFor('ws.connection-permit-carrier').map((l) => l.severity), ['fatal']);
});

test('a broken subscription set is answered on each lane that reads it, never thrown out of one', () => {
	const seen = observed();
	assert.deepEqual(seen.subscribe, { value: null }, 'subscribe');
	assert.deepEqual(seen.unsubscribe, { value: false }, 'unsubscribe');
	assert.deepEqual(seen.batch, {}, 'a subscribe-batch frame');
	// CLOSED is the answer that sends nothing: the entry is not acked as held.
	assert.deepEqual(seen.batchFrames, [], 'and the batch acked nothing');
	assert.equal(seen.counts['subs.shape'], 2, 'the subscribe and the batch entry it reached');
	assert.equal(seen.counts['subs.shape-unsubscribe'], 1);
	assert.equal(seen.counts['subs.shape-batch'], 1);
});

test('and its close still runs the whole teardown', () => {
	const seen = observed();
	assert.deepEqual(seen.close, {}, 'the close handler did not throw');
	assert.equal(seen.totalAfterClose, 0, 'the subscription total stayed a number');
	assert.equal(seen.detachedAfterClose, true, 'the teardown reached its last step');
	assert.equal(seen.permitsAfterClose, 1, 'its permit came back; the other socket still holds one');
});

test('each fatal violation schedules exactly one exit, with code 78', () => {
	// The permit, the subscribe, and the subscribe the batch entry reached.
	assert.deepEqual(observed().exits, [78, 78, 78]);
});

test('a release with no install behind it clamps the total at zero and says so', () => {
	const seen = observed();
	assert.equal(seen.totalAfter, 0, 'clamped, not negative');
	assert.equal(seen.counts['subs.total-negative'], 1);
	assert.deepEqual(linesFor('subs.total-negative')[0].record.attributes, {
		category: 'subs.total-negative',
		context: { totalSubscriptions: -3 }
	});
});

test('devAssert does nothing in production: no throw, no line, no count', () => {
	const seen = observed();
	assert.deepEqual(seen.devAssert, {});
	assert.equal(seen.counts['development.assertion'], undefined);
	assert.ok(!seen.lines.some((/** @type {string} */ l) => l.includes('development.assertion')));
});

test('nothing else was reported on the way', () => {
	assert.deepEqual(observed().counts, {
		'ws.request-id-carry': 1,
		'ws.connection-permit-carrier': 1,
		'subs.shape': 2,
		'subs.shape-unsubscribe': 1,
		'subs.shape-batch': 1,
		'subs.total-negative': 1
	});
});

test('the metrics document carries each violation by category and severity', () => {
	assert.deepEqual(observed().metrics.sort(), [
		'framework_assertion_violations_total{category="subs.shape",severity="fatal"} 2',
		'framework_assertion_violations_total{category="subs.shape-batch",severity="soft"} 1',
		'framework_assertion_violations_total{category="subs.shape-unsubscribe",severity="soft"} 1',
		'framework_assertion_violations_total{category="subs.total-negative",severity="soft"} 1',
		'framework_assertion_violations_total{category="ws.connection-permit-carrier",severity="fatal"} 1',
		'framework_assertion_violations_total{category="ws.request-id-carry",severity="soft"} 1'
	]);
});
