import { createMetricProfile } from '../metric-profile.js';
import { ws_options } from './config.js';

// Build-time transport support, independent of enabled optional controllers or
// current samples. A build without a realtime tier has no WebSocket sources.
export const runtimeMetricProfile = createMetricProfile({
 sources: ws_options === null
  ? ['http', 'process-memory', 'framework-assertions']
  : ['http', 'upgrade', 'upgrade-rate-limit', 'upgrade-admission', 'upgrade-pacing',
   'websocket', 'subscriptions', 'publish', 'backpressure', 'drops', 'egress',
   'pressure', 'process-memory', 'os-pressure', 'framework-assertions'],
 droppedFrameCoverage: ws_options === null ? 'unavailable' : 'direct-sends'
});
