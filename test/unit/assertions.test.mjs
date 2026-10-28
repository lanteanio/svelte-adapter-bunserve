import '../helpers/configured-metrics.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The framework assertions themselves (src/runtime/utils/assertions.js), in the
// test mode this suite runs in (test/helpers/test-env.mjs): a violation throws
// after it is recorded. The production branch, where it is only logged and
// counted, runs in assertions-production.test.mjs.
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = null;

const {
	assert: frameworkAssert,
	devAssert,
	fatal,
	readAssertionCounts,
	readAssertionViolations,
	resetFatalSink,
	setFatalSink,
	_resetAssertionCountsForTest
} = await import('../../src/runtime/utils/assertions.js');
const { httpPlatform, platform, requestPlatform } = await import('../../src/runtime/handler/platform.js');
const { metricsRegistry, metricsSnapshot } = await import('../../src/runtime/handler/metrics.js');

/** assert/fatal throw in test mode; the violation is recorded before the throw. */
const swallow = (/** @type {() => void} */ fn) => {
	try {
		fn();
	} catch {
		// expected: the test-mode throw
	}
};

/** Run `fn` with console.error captured, and hand back what it logged. */
function capturingErrors(/** @type {() => void} */ fn) {
	/** @type {string[]} */
	const lines = [];
	const real = console.error;
	console.error = (...args) => {
		lines.push(args.map(String).join(' '));
	};
	try {
		fn();
	} finally {
		console.error = real;
	}
	return lines;
}

const PREFIX = '[lantean/diagnostic source=svelte-adapter-bunserve component=runtime.assertion event=invariant.violated';

beforeEach(() => {
	_resetAssertionCountsForTest();
});

// - assert -------------------------------------------------------------------

test('assert passes silently on any truthy condition and counts nothing', () => {
	frameworkAssert(true, 'test.passes');
	frameworkAssert(1, 'test.passes');
	frameworkAssert('non-empty', 'test.passes');
	frameworkAssert({}, 'test.passes');
	assert.equal(readAssertionCounts().size, 0);
});

test('assert throws in test mode on every falsy condition, naming the category', () => {
	assert.throws(() => frameworkAssert(false, 'test.fails'), { message: 'adapter-bunserve assert: test.fails' });
	assert.throws(() => frameworkAssert(0, 'test.zero'), { message: 'adapter-bunserve assert: test.zero' });
	assert.throws(() => frameworkAssert(null, 'test.null'), { message: 'adapter-bunserve assert: test.null' });
	assert.throws(() => frameworkAssert(undefined, 'test.undef'), { message: 'adapter-bunserve assert: test.undef' });
});

test('the thrown error carries the context', () => {
	assert.throws(
		() => frameworkAssert(false, 'test.context', { foo: 'bar', topic: 'chat' }),
		(/** @type {any} */ err) => {
			assert.deepEqual(err.context, { foo: 'bar', topic: 'chat' });
			return true;
		}
	);
	assert.throws(
		() => frameworkAssert(false, 'test.no-context'),
		(/** @type {any} */ err) => err.context === null
	);
});

test('each violation increments its category', () => {
	swallow(() => frameworkAssert(false, 'test.counter-a'));
	swallow(() => frameworkAssert(false, 'test.counter-a'));
	swallow(() => frameworkAssert(false, 'test.counter-b'));
	assert.equal(readAssertionCounts().get('test.counter-a'), 2);
	assert.equal(readAssertionCounts().get('test.counter-b'), 1);
});

test('readAssertionCounts hands back the live Map, not a snapshot', () => {
	const a = readAssertionCounts();
	assert.equal(readAssertionCounts(), a);
	swallow(() => frameworkAssert(false, 'test.live'));
	assert.equal(a.get('test.live'), 1);
});

// - fatal --------------------------------------------------------------------

test('fatal passes silently on a truthy condition', () => {
	fatal(true, 'test.passes');
	assert.equal(readAssertionCounts().size, 0);
});

test('fatal throws in test mode and attaches the context', () => {
	capturingErrors(() => {
		assert.throws(
			() => fatal(false, 'test.fatal-context', { topic: 'chat' }),
			(/** @type {any} */ err) => {
				assert.equal(err.message, 'adapter-bunserve fatal: test.fatal-context');
				assert.deepEqual(err.context, { topic: 'chat' });
				return true;
			}
		);
	});
});

test('fatal counts in the SAME Map as assert: one namespace', () => {
	capturingErrors(() => {
		swallow(() => frameworkAssert(false, 'test.shared'));
		swallow(() => fatal(false, 'test.shared'));
	});
	assert.equal(readAssertionCounts().get('test.shared'), 2);
});

test('fatal logs one structured line with severity fatal, before it throws', () => {
	const lines = capturingErrors(() => swallow(() => fatal(false, 'test.fatal-log', { a: 1 })));
	assert.equal(lines.length, 1);
	const [line] = lines;
	assert.ok(line.startsWith(PREFIX + ' severity=fatal] test.fatal-log {'), line);
	assert.deepEqual(JSON.parse(line.slice(line.indexOf('{'))), {
		schemaVersion: 1,
		occurredAt: null,
		source: 'svelte-adapter-bunserve',
		component: 'runtime.assertion',
		event: 'invariant.violated',
		severity: 'fatal',
		level: 'fatal',
		dataClass: 'operational',
		message: 'test.fatal-log',
		attributes: { category: 'test.fatal-log', context: { a: 1 } }
	});
});

test('a context the line cannot serialize is dropped, and the line says so', () => {
	const cyclic = { /** @type {any} */ self: null };
	cyclic.self = cyclic;
	const lines = capturingErrors(() => {
		swallow(() => fatal(false, 'test.cyclic', cyclic));
		swallow(() => fatal(false, 'test.bigint', { n: 1n }));
	});
	assert.equal(lines.length, 2, 'each violation still logs a line');
	for (const [i, category] of ['test.cyclic', 'test.bigint'].entries()) {
		const record = JSON.parse(lines[i].slice(lines[i].indexOf('{')));
		assert.deepEqual(record.attributes, { category, context: null, contextSerializationFailed: true });
	}
});

test('setFatalSink refuses a sink without an exit function', () => {
	assert.throws(() => setFatalSink(/** @type {any} */ (null)), /exit/);
	assert.throws(() => setFatalSink(/** @type {any} */ ({})), /exit/);
});

test('in production, fatal defers exit(78) through the sink rather than throwing', async () => {
	const exits = [];
	const originalNodeEnv = process.env.NODE_ENV;
	const originalVitest = process.env.VITEST;
	try {
		// Out of the test-mode branch, which fatal re-reads on every call.
		process.env.NODE_ENV = 'production';
		delete process.env.VITEST;
		setFatalSink({ exit: (code) => exits.push(code) });
		const lines = capturingErrors(() => {
			fatal(false, 'test.fatal-defer', { topic: 'room' });
		});
		assert.deepEqual(exits, [], 'not synchronously');
		assert.equal(readAssertionCounts().get('test.fatal-defer'), 1, 'counted first');
		assert.equal(lines.length, 1, 'and logged first');
		// On a microtask: after the current frame, before anything else runs.
		await Promise.resolve();
		assert.deepEqual(exits, [78]);
	} finally {
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		if (originalVitest !== undefined) process.env.VITEST = originalVitest;
		resetFatalSink();
	}
});

// - devAssert ----------------------------------------------------------------

test('devAssert passes silently on a truthy condition', () => {
	devAssert(true, 'should not fire');
	devAssert({ a: 1 }, 'should not fire');
	assert.equal(readAssertionCounts().size, 0);
});

test('devAssert throws outside production with its message and context, and is not counted', () => {
	const lines = capturingErrors(() => {
		assert.throws(
			() => devAssert(false, 'dev shape', { which: 'thing' }),
			(/** @type {any} */ err) => {
				assert.equal(err.message, 'adapter-bunserve devAssert: dev shape');
				assert.deepEqual(err.context, { which: 'thing' });
				return true;
			}
		);
	});
	assert.equal(lines.length, 1);
	assert.ok(lines[0].startsWith(PREFIX + ' severity=error] dev shape {'), lines[0]);
	assert.equal(readAssertionCounts().size, 0, 'a development check is not a production violation');
});

// - what reads the counts ----------------------------------------------------

test('the violations are also kept by severity, for the metrics document', () => {
	capturingErrors(() => {
		swallow(() => frameworkAssert(false, 'test.split'));
		swallow(() => frameworkAssert(false, 'test.split'));
		swallow(() => fatal(false, 'test.split'));
	});
	const { soft, fatal: hard } = readAssertionViolations();
	assert.equal(soft.get('test.split'), 2);
	assert.equal(hard.get('test.split'), 1);
	assert.equal(readAssertionCounts().get('test.split'), 3, 'the category total is both');
});

test('framework assertion metadata registers without inventing a violation sample', async () => {
	metricsRegistry.reset();
	const text = await metricsSnapshot();
	assert.match(text, /^# TYPE framework_assertion_violations_total counter$/m);
	assert.doesNotMatch(text, /^framework_assertion_violations_total(?:\{| )/m);
});

test('framework_assertion_violations_total carries each category by severity', async () => {
	metricsRegistry.reset();
	capturingErrors(() => {
		swallow(() => frameworkAssert(false, 'metric.soft'));
		swallow(() => frameworkAssert(false, 'metric.soft'));
		swallow(() => fatal(false, 'metric.fatal'));
	});
	frameworkAssert(true, 'metric.passes');
	const series = (await metricsSnapshot())
		.split('\n')
		.filter((line) => line.startsWith('framework_assertion_violations_total'))
		.sort();
	assert.deepEqual(series, [
		'framework_assertion_violations_total{category="metric.fatal",severity="fatal"} 1',
		'framework_assertion_violations_total{category="metric.soft",severity="soft"} 2'
	]);
});

test('platform.assertions is the live Map, on every build', () => {
	assert.equal(platform.assertions, readAssertionCounts());
	assert.equal(httpPlatform.assertions, readAssertionCounts());
	// One getter, shared: the realtime platform takes it from the members every
	// build has rather than declaring a copy.
	assert.equal(
		Object.getOwnPropertyDescriptor(platform, 'assertions')?.get,
		Object.getOwnPropertyDescriptor(httpPlatform, 'assertions')?.get
	);
	// This file builds no realtime tier, so a request platform links to the
	// members every build has - and a health route reading the Map still works.
	const reqPlatform = requestPlatform('r-1');
	assert.equal(reqPlatform.assertions, readAssertionCounts());
	swallow(() => frameworkAssert(false, 'test.on-request'));
	assert.deepEqual([...reqPlatform.assertions], [['test.on-request', 1]]);
});
