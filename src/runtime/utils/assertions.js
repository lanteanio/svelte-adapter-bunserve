import { microtask } from '../runtime.js';
import { formatDiagnostic } from '../diagnostic-format.js';

const SOURCE = 'svelte-adapter-bunserve';

function assertionDiagnostic(severity, category, context, message = category) {
	try {
		return formatDiagnostic({
			source: SOURCE,
			component: 'runtime.assertion',
			event: 'invariant.violated',
			severity,
			message,
			attributes: { category, context: context ?? null }
		});
	} catch {
		return formatDiagnostic({
			source: SOURCE,
			component: 'runtime.assertion',
			event: 'invariant.violated',
			severity,
			message,
			attributes: { category, context: null, contextSerializationFailed: true }
		});
	}
}

// - Framework-internal assertions ------------------------------------------
// Library-author defensive coding only. Apps do not call these - they read the
// `platform.assertions` Map for ops dashboards, the
// `framework_assertion_violations_total` family in the metrics document, and the
// structured `console.error` line for issue reports. Categories follow an
// `<area>.<thing>` convention (e.g. `'subs.shape'`, `'ws.platform-missing-in-close'`)
// and are svelte-adapter-uws's category for the same invariant, so a report reads
// the same on either adapter.
//
// Three tiers, distinguished by termination semantics (not by env):
// - assert() is the SOFT tier. In production it logs + increments the counter
//   but does NOT throw - a throw out of a socket callback abandons the rest of
//   that callback, and a close handler that stops halfway leaks every release
//   after the throw; the structured log + the queryable counter are enough for
//   ops to detect a regression and file an issue. In test mode
//   (`process.env.VITEST` set, or `NODE_ENV === 'test'`), assert() throws so
//   the runner fails loudly. The counter still increments either way.
// - fatal() is the HARD tier, for genuinely unrecoverable state. It shares the
//   same counter Map (one namespace; the severity rides the structured log,
//   labelled `severity: 'fatal'`), and in production schedules a DEFERRED
//   process exit with code 78 AFTER the current callback frame unwinds. In test
//   mode it throws instead of exiting so the runner sees it without dying. The
//   exit is injectable via setFatalSink so a test can see it scheduled.
// - devAssert is dev-time only: it throws in dev and test, and is a complete
//   no-op in production. Use it for cosmetic / DX-shape checks where the
//   runtime cost of the comparison is unwelcome in production.

const assertionCounts = new Map();

// The same violations split by severity, for the metrics document. Read at
// scrape time (handler/metrics.js) like every other adapter counter, so a
// violation costs two Map writes and no registry call.
const violationsBySeverity = { soft: new Map(), fatal: new Map() };

const isTestEnv = process.env.VITEST !== undefined ||
	process.env.NODE_ENV === 'test';
const isProdEnv = process.env.NODE_ENV === 'production';

// Per-call test-mode check for the hard tier. `assert`/`devAssert` read the
// module-load snapshot; `fatal` re-reads the env each call so a test can
// exercise the production deferred-exit branch by flipping the env without
// re-importing the module.
function isTestEnvNow() {
	return process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';
}

// Process exit code for a hard-tier invariant violation, svelte-adapter-uws's
// value. Distinct from a graceful shutdown (0) and an uncaught error (1), so a
// restart log can tell a crash-on-bad-state apart from either.
const FATAL_EXIT_CODE = 78;

// Injectable sink for the hard-tier termination. Defaults to the real
// process.exit; tests swap it to assert the exit was scheduled.
let fatalSink = { exit: (code) => process.exit(code) };

/**
 * @param {string} category
 * @param {'soft' | 'fatal'} severity
 */
function recordViolation(category, severity) {
	assertionCounts.set(category, (assertionCounts.get(category) || 0) + 1);
	const bySeverity = violationsBySeverity[severity];
	bySeverity.set(category, (bySeverity.get(category) || 0) + 1);
}

/**
 * Always-on framework invariant assertion. On violation: increments
 * `assertionCounts.get(category)`, logs a structured `console.error`,
 * and (in test mode only) throws so the test runner surfaces the failure.
 *
 * Hot-path safe: the success branch is one comparison, JIT-folded.
 *
 * @param {unknown} cond - any truthy expression
 * @param {string} category - dot-prefixed namespace (e.g. `'subs.shape'`)
 * @param {object | null} [context] - free-form context payload for logs / error
 */
export function assert(cond, category, context) {
	if (cond) return;
	recordViolation(category, 'soft');
	if (isTestEnv) {
		const err = new Error('adapter-bunserve assert: ' + category);
		// @ts-ignore augment with context for test diagnostics
		err.context = context ?? null;
		throw err;
	}
	console.error(assertionDiagnostic('warn', category, context));
}

/**
 * Hard-tier framework invariant, for genuinely unrecoverable process state.
 * On violation: increments the SAME `assertionCounts` map as `assert` (one
 * namespace; the severity rides the structured log as `severity: 'fatal'`),
 * logs a `[lantean/diagnostic source=svelte-adapter-bunserve component=runtime.assertion event=invariant.violated severity=fatal]`
 * line, and - in production only - schedules a DEFERRED process exit with
 * code 78. The exit is deferred to a microtask so the current callback frame
 * unwinds before the process goes down. In test mode it throws instead of
 * exiting so the runner sees the failure without dying.
 *
 * Hot-path safe: the success branch is one comparison, JIT-folded.
 *
 * @param {unknown} cond - any truthy expression
 * @param {string} category - dot-prefixed namespace (e.g. `'subs.shape'`)
 * @param {object | null} [context] - free-form context payload for logs / error
 */
export function fatal(cond, category, context) {
	if (cond) return;
	recordViolation(category, 'fatal');
	console.error(assertionDiagnostic('fatal', category, context));
	if (isTestEnvNow()) {
		const err = new Error('adapter-bunserve fatal: ' + category);
		// @ts-ignore augment with context for test diagnostics
		err.context = context ?? null;
		throw err;
	}
	// Production: defer the termination so the current callback frame completes
	// first. The counter + log above have already been written.
	microtask(() => { fatalSink.exit(FATAL_EXIT_CODE); });
}

/**
 * Install a custom hard-tier termination sink, so a test can assert an exit
 * was scheduled without killing the runner. Never call this from production
 * code.
 *
 * @param {{ exit(code: number): void }} sink
 */
export function setFatalSink(sink) {
	if (!sink || typeof sink.exit !== 'function') {
		throw new Error('setFatalSink: sink must expose an exit(code) function');
	}
	fatalSink = sink;
}

/**
 * Restore the default termination sink (`process.exit`). Test teardown.
 */
export function resetFatalSink() {
	fatalSink = { exit: (code) => process.exit(code) };
}

/**
 * Dev-time invariant. No-op in production (zero runtime cost when
 * `NODE_ENV === 'production'`); throws in dev / test so the violation
 * surfaces during development. Use for DX hints and cosmetic shape
 * checks that should not cost anything in shipped builds.
 *
 * @param {unknown} cond
 * @param {string} message
 * @param {object} [context]
 */
export function devAssert(cond, message, context) {
	if (cond) return;
	if (isProdEnv) return;
	const err = new Error('adapter-bunserve devAssert: ' + message);
	// @ts-ignore
	err.context = context ?? null;
	console.error(assertionDiagnostic('error', 'development.assertion', context, message));
	throw err;
}

/**
 * Read-only access to the per-category violation counts. The returned
 * Map is the live module-level instance - do not mutate. Surfaced via
 * `platform.assertions` for ops dashboards and integration tests.
 *
 * @returns {Map<string, number>}
 */
export function readAssertionCounts() {
	return assertionCounts;
}

/**
 * The violations split by severity, behind
 * `framework_assertion_violations_total{category,severity}`. Live Maps - do not
 * mutate. Cardinality is bounded by the categories the call sites declare (all
 * module-level constants, never input-driven) times the two severities.
 *
 * @returns {{ soft: Map<string, number>, fatal: Map<string, number> }}
 */
export function readAssertionViolations() {
	return violationsBySeverity;
}

/**
 * Reset the assertion counters and the termination sink. Test-only utility -
 * production code should never call this. Exists so unit tests can isolate
 * counters between cases.
 */
export function _resetAssertionCountsForTest() {
	assertionCounts.clear();
	violationsBySeverity.soft.clear();
	violationsBySeverity.fatal.clear();
	resetFatalSink();
}
