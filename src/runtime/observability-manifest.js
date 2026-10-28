// The runtime and public API share one signal vocabulary and HELP text.
export * from './public-observability-manifest.js';
export const SECONDS = 'seconds';
export const SNAPSHOT_SIGNALS = Object.freeze({
 metrics_snapshot_workers_expected: 1,
 metrics_snapshot_workers_reporting: 1,
 metrics_snapshot_degraded: 0
});
