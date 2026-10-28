# Transport availability

## Metric sources

A runtime declares its measurement sources before collecting data. Use
`createMetricProfile({ sources, droppedFrameCoverage })` from
`svelte-adapter-bunserve/observability`; the generated
[source inventory](observability.md#transport-metric-sources) groups every
measurement family. The profile exposes the applicable canonical `signals`
and `requiredWorkerSignals`. Names, HELP, units, labels and no-data laws stay
unchanged. `NATIVE_METRIC_PROFILE` describes the lead adapter's full inventory.
Bun uses a fixed profile for its implemented sources: three source groups for
HTTP-only builds and fifteen for builds with WebSockets. Application
configuration cannot weaken the required measurements within either profile.

An unavailable source is omitted from local output and snapshots, including
zero-valued series. It does not count against snapshot completeness. A source
that the implementation supports remains declared when its sampler fails or
has not run: missing required registration or a missing required gauge sample
then makes its worker incomplete. Do not rebuild the declaration from whatever
samples happened to arrive. Optional source availability still follows each
signal's existing no-data law.

A complete snapshot has every expected worker reporting, all required factories
for the declared profile registered, every required gauge sampled, and no
collection degradation. Registered counters can report zero before their first
event; unsupported counters cannot. An expected worker that failed to answer
still counts as missing. Use one fixed profile for a snapshot's reporting group;
heterogeneous runtimes need separate snapshots, not the intersection of their
measurements.

A single-process transport without relay, state audit, waiting room, posture,
upgrade admission or pacing, or message admission omits those source groups.
It declares any other groups only when their measurements are implemented.
For example, an HTTP/WebSocket-only measurement layer can select `http` and
`websocket`; absent relay and admission samples then convey unavailability,
not healthy zero activity. This explicitly permits the corresponding family
omissions in Bun runtimes while keeping their supported measurements required.

The `drops` source additionally requires `droppedFrameCoverage` to be
`all-deliveries` or `direct-sends`. Bun's `server.publish` does not expose
per-recipient drop counts, so a runtime measuring only direct `send` outcomes
uses `direct-sends`. It must not estimate publish recipient drops or claim that
these counters cover all fan-out. With no drop measurement the coverage is
`unavailable` and both drop families are absent. Snapshots with an explicit
profile carry bounded `metric_sources` and `ws_dropped_coverage` comments;
operators must retain this target-level coverage when comparing drop rates.

These declarations describe runtime support. They are independent of whether
an optional feature is currently active: an implemented event counter can
truthfully stay zero while that feature has no events. A constant zero supplied
in place of an absent measurement source does not qualify as support.

## Identity-header line provenance

Bun 1.4.4 exposes `Origin`, `Content-Type`, `Authorization` and
`Proxy-Authorization` as normalized Fetch `Headers` values. Repeated lines become
a comma-joined value, and `Headers.count` counts the merged fields. Identity-header
provenance is therefore `normalized-values`: the request does not preserve enough
evidence to distinguish one line from several. A single Digest credential with
quoted parameters can have the same public representation as repeated lines.

HTTP, authentication, admin and upgrade routes validate those normalized values.
Origin policy still applies, and application hooks own credential and media-type
parsing. The adapter does not reject every comma or split values to invent a raw
line count: valid credentials and quoted media-type parameters can contain commas.
A valid value alone never grants access.

This rule covers only those four identity fields. HTTP framing, duplicate Host
checks, trusted proxy selection and authorization still apply. Deployments that
require rejection of every repeated identity line need an ingress that inspects
raw repetitions, or a transport API that preserves them. Native uWS and Node HTTP
transports preserve raw header evidence and reject repeated identity lines.

The raw TCP cases in `test/live/identity-headers-check.mjs` exercise all four entry
points with equal normalized single-line and repeated-line values, including a
legal single-line Digest credential and a quoted media-type parameter. They also
verify origin refusals, admin authorization and duplicate Host rejection.
