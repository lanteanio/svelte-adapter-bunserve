import { configureHttpTransportMetrics } from '../utils/http-transport-metrics.js';
import { monotonicNow } from '../runtime.js';
import { metricsInstrument } from './metrics.js';

configureHttpTransportMetrics(
 metricsInstrument('counter', 'http_requests_total'),
 metricsInstrument('histogram', 'http_request_duration_seconds'),
 monotonicNow
);

export { httpMetrics } from '../utils/http-transport-metrics.js';
