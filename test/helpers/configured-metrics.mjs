import { createMetricRegistry } from '../../src/runtime/utils/metrics.js';

// Stand in for an operator-owned registry loaded by the build-generated entry.
globalThis.__bunserveExternalMetrics = createMetricRegistry();
