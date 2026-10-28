# Reference queries

Generated from the adapter's signal manifest by `scripts/generate-observability.js`.
Do not edit by hand - a test regenerates this file and fails if it differs, so a new
metric cannot ship without an entry here.

These describe the family signal inventory. See the [metrics documentation](../../README.md#metrics)
for signals exposed by this runtime. Scrape each Bun server instance separately;
`platform.metricsSnapshot()` reports that instance, not a cross-process merge.
Add the scrape target label `adapter="svelte-adapter-bunserve"` and preserve job,
instance, cluster and other external labels. A global `sum()` would combine independent deployments.
The cross-worker laws below describe aggregation within one deployment; they do not imply a built-in merger.

| Metric | Type | Unit | Query | Cross-worker law |
| --- | --- | --- | --- | --- |
| `http_requests_total` | counter | count | `rate(http_requests_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `http_request_duration_seconds` | histogram | seconds | `histogram_quantile(0.95, sum without (method, outcome) (rate(http_request_duration_seconds_bucket{adapter="svelte-adapter-bunserve"}[5m])))` | Sum across workers in one deployment. (not always registered) |
| `upgrade_admitted_total` | counter | count | `rate(upgrade_admitted_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `upgrade_rejected_total` | counter | count | `rate(upgrade_rejected_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `upgrade_duration_seconds` | histogram | seconds | `histogram_quantile(0.95, sum without (outcome) (rate(upgrade_duration_seconds_bucket{adapter="svelte-adapter-bunserve"}[5m])))` | Sum across workers in one deployment. (not always registered) |
| `upgrade_rate_map_evicted_total` | counter | count | `rate(upgrade_rate_map_evicted_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `upgrade_inflight` | gauge | count | `upgrade_inflight{adapter="svelte-adapter-bunserve"}` | Sum across workers in one deployment. |
| `upgrade_deferred_depth` | gauge | count | `upgrade_deferred_depth{adapter="svelte-adapter-bunserve"}` | Sum across workers in one deployment. |
| `upgrade_deferred_oldest_age_seconds` | gauge | seconds | `upgrade_deferred_oldest_age_seconds{adapter="svelte-adapter-bunserve"}` | Take the maximum across workers in one deployment. |
| `upgrade_deferred_rejected_total` | counter | count | `rate(upgrade_deferred_rejected_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `ws_connection_headroom` | gauge | count | `ws_connection_headroom{adapter="svelte-adapter-bunserve"}` | Sum across workers in one deployment. (not always registered) |
| `waiting_room_queue_depth` | gauge | count | `waiting_room_queue_depth{adapter="svelte-adapter-bunserve"}` | Sum across workers in one deployment. |
| `protection_posture_transitions_total` | counter | count | `rate(protection_posture_transitions_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `protection_posture_state` | gauge | enumerated state (see the description) | `protection_posture_state{adapter="svelte-adapter-bunserve"}` | Take the maximum across workers in one deployment. |
| `ws_connections` | gauge | count | `ws_connections{adapter="svelte-adapter-bunserve"}` | Sum across workers in one deployment. |
| `ws_connection_duration_seconds` | histogram | seconds | `histogram_quantile(0.95, sum without (outcome) (rate(ws_connection_duration_seconds_bucket{adapter="svelte-adapter-bunserve"}[5m])))` | Sum across workers in one deployment. (not always registered) |
| `ws_messages_total` | counter | count | `rate(ws_messages_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `ws_message_admission_rejected_total` | counter | count | `rate(ws_message_admission_rejected_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `ws_message_duration_seconds` | histogram | seconds | `histogram_quantile(0.95, sum without (kind, outcome) (rate(ws_message_duration_seconds_bucket{adapter="svelte-adapter-bunserve"}[5m])))` | Sum across workers in one deployment. (not always registered) |
| `ws_subscriptions` | gauge | count | `ws_subscriptions{adapter="svelte-adapter-bunserve"}` | Sum across workers in one deployment. |
| `ws_publishes_total` | counter | count | `rate(ws_publishes_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `ws_publish_outcomes_total` | counter | count | `rate(ws_publish_outcomes_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `ws_backpressure_max_bytes` | gauge | bytes | `ws_backpressure_max_bytes{adapter="svelte-adapter-bunserve"}` | Take the maximum across workers in one deployment. |
| `ws_backpressure_connections` | gauge | count | `ws_backpressure_connections{adapter="svelte-adapter-bunserve"}` | Sum across workers in one deployment. |
| `ws_dropped_frames_total` | counter | count | `rate(ws_dropped_frames_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `ws_dropped_bytes_total` | counter | bytes | `rate(ws_dropped_bytes_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `egress_refused_total` | counter | count | `rate(egress_refused_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `egress_window_evicted_total` | counter | count | `rate(egress_window_evicted_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `pressure_saturation` | gauge | ratio | `pressure_saturation{adapter="svelte-adapter-bunserve"}` | Take the maximum across workers in one deployment. |
| `pressure_reason` | gauge | enumerated state (see the description) | `pressure_reason{adapter="svelte-adapter-bunserve"}` | Take the maximum across workers in one deployment. |
| `pressure_reason_transitions_total` | counter | count | `rate(pressure_reason_transitions_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `pressure_sample_timestamp_seconds` | gauge | seconds | `pressure_sample_timestamp_seconds{adapter="svelte-adapter-bunserve"}` | Take the minimum across workers to retain the stalest sample. |
| `resident_memory_bytes` | gauge | bytes | `resident_memory_bytes{adapter="svelte-adapter-bunserve"}` | Whole-process value. Take the maximum across workers in one process; never sum it. |
| `heap_used_ratio` | gauge | ratio | `heap_used_ratio{adapter="svelte-adapter-bunserve"}` | Take the maximum across workers in one deployment. (not always registered) |
| `psi_cpu_some_avg10` | gauge | percent | `psi_cpu_some_avg10{adapter="svelte-adapter-bunserve"}` | Whole-process value. Take the maximum across workers in one process; never sum it. (not always registered) |
| `psi_memory_full_avg10` | gauge | percent | `psi_memory_full_avg10{adapter="svelte-adapter-bunserve"}` | Whole-process value. Take the maximum across workers in one process; never sum it. (not always registered) |
| `psi_io_full_avg10` | gauge | percent | `psi_io_full_avg10{adapter="svelte-adapter-bunserve"}` | Whole-process value. Take the maximum across workers in one process; never sum it. (not always registered) |
| `cpu_throttled_ratio` | gauge | ratio | `cpu_throttled_ratio{adapter="svelte-adapter-bunserve"}` | Whole-process value. Take the maximum across workers in one process; never sum it. (not always registered) |
| `open_fds` | gauge | count | `open_fds{adapter="svelte-adapter-bunserve"}` | Whole-process value. Take the maximum across workers in one process; never sum it. (not always registered) |
| `fd_soft_limit` | gauge | count | `fd_soft_limit{adapter="svelte-adapter-bunserve"}` | Whole-process value. Take the maximum across workers in one process; never sum it. (not always registered) |
| `state_divergence_total` | counter | count | `rate(state_divergence_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `relay_gap_frames_total` | counter | count | `rate(relay_gap_frames_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `relay_spill_quarantines_total` | counter | count | `rate(relay_spill_quarantines_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `relay_spill_dropped_bytes_total` | counter | bytes | `rate(relay_spill_dropped_bytes_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `relay_spill_pending_age_seconds` | gauge | seconds | `relay_spill_pending_age_seconds{adapter="svelte-adapter-bunserve"}` | Take the maximum across workers in one deployment. |
| `relay_frame_refused_total` | counter | count | `rate(relay_frame_refused_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `relay_frame_oversized_total` | counter | count | `rate(relay_frame_oversized_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `framework_assertion_violations_total` | counter | count | `rate(framework_assertion_violations_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. |
| `framework_resource_growth_suspected_total` | counter | count | `rate(framework_resource_growth_suspected_total{adapter="svelte-adapter-bunserve"}[5m])` | Sum across workers in one deployment. (not always registered) |
| `metrics_snapshot_workers_expected` | gauge | count | `metrics_snapshot_workers_expected{adapter="svelte-adapter-bunserve"}` | Merge-owned signal; no worker registers it. |
| `metrics_snapshot_workers_reporting` | gauge | count | `metrics_snapshot_workers_reporting{adapter="svelte-adapter-bunserve"}` | Merge-owned signal; no worker registers it. |
| `metrics_snapshot_degraded` | gauge | count | `metrics_snapshot_degraded{adapter="svelte-adapter-bunserve"}` | Merge-owned signal; no worker registers it. |

## Derived quantities

These combine two metrics and are the ones most often written wrongly by hand.

```promql
# Subscriber ratio. Exported as numerator and denominator on purpose: averaging
# per-worker ratios is NOT the cluster ratio.
ws_subscriptions{adapter="svelte-adapter-bunserve"} / clamp_min(ws_connections{adapter="svelte-adapter-bunserve"}, 1)

# Descriptor headroom. Both sides are whole-process maxima, so this is already
# the process-wide truth - summing either side would multiply it by the worker count.
open_fds{adapter="svelte-adapter-bunserve"} / clamp_min(fd_soft_limit{adapter="svelte-adapter-bunserve"}, 1)

# Share of upgrade attempts refused. Attempts the adapter never saw (a client that
# disconnects mid-handshake) are in neither term, so this can read below a load
# balancer's own refusal rate.
(
  sum without (reason) (rate(upgrade_rejected_total{adapter="svelte-adapter-bunserve"}[5m]))
    or (0 * rate(upgrade_admitted_total{adapter="svelte-adapter-bunserve"}[5m]))
)
  /
(
  rate(upgrade_admitted_total{adapter="svelte-adapter-bunserve"}[5m])
    +
    (
      sum without (reason) (rate(upgrade_rejected_total{adapter="svelte-adapter-bunserve"}[5m]))
        or (0 * rate(upgrade_admitted_total{adapter="svelte-adapter-bunserve"}[5m]))
    )
)

# Age of the pressure sample every gauge above was written from. The sampling timer
# is unref'd; if it stops, those gauges keep serving their last value while the
# target still reports up. This is the only thing that tells you.
time() - pressure_sample_timestamp_seconds{adapter="svelte-adapter-bunserve"}
```

All four ship as recording rules in `rules.yml` - `adapter:subscriber_ratio`,
`adapter:fd_headroom_ratio`, `adapter:upgrade_reject_ratio:rate5m` and
`adapter:pressure_sample_age_seconds` - alongside the transport SLO series
`adapter:http_error_ratio:rate5m`, `adapter:ws_message_error_ratio:rate5m`,
`adapter:http_request_duration_seconds:p95_5m`,
`adapter:http_request_duration_seconds:p95_by_method_5m` and
`adapter:ws_message_duration_seconds:p95_5m`. Chart and alert on the recorded
names; the dashboard already does.
