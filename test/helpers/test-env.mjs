// The family's test mode: a framework assertion (src/runtime/utils/assertions.js)
// throws instead of only logging, so a test that drives the runtime into a
// broken invariant fails where it happened rather than passing beside a log
// line. The assertions module reads the mode once at load, so on Node this is a
// preload (`--import`) rather than a line in each file; the Bun lane sets the
// same variable when it spawns `bun test` (scripts/bun-test-lane.mjs). Set
// unconditionally on both, so an exported NODE_ENV cannot change what a run
// proves.
process.env.NODE_ENV = 'test';
