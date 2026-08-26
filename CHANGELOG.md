# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `websocket.egress`: publish-egress ceilings, the outbound half of message
  admission - per-window `messages`, `deliveries` and `bytes` bounds held per
  topic and per tenant in a bounded, lazily-rotated ledger, spelled and
  defaulted exactly as svelte-adapter-uws declares them. A refused publish
  delivers nothing, stamps no sequence and returns `false`; a batch is
  admitted whole or refused whole; a publish heavier than a whole window's
  allowance is refused on every attempt and reported every time; the `bytes`
  ceiling delivers the crossing publish and refuses the next, because byte
  weight exists only after serialization. Ledger keys are bounded to what is
  live at once (lapsed windows reclaimed amortized), and an eviction that
  costs enforcement is counted in `egress_window_evicted_total{scope}` beside
  `egress_refused_total{scope}`. Tenants resolve through the handler module's
  `egressTenantOf(topic)` export. The pressure snapshot gains the sibling's
  `egress` figures and `topPublishers` gains `deliveriesPerSec`; the `egress`
  entry leaves the parity gap list, so the oracle now checks it by name.

- The static lane answers the full RFC 9110 precondition set. Mutable assets
  carry `Last-Modified` beside the ETag, `If-Modified-Since` answers 304 for a
  cache that lost the validator, and `If-Match` / `If-Unmodified-Since` answer
  412 - evaluated in the RFC's order, so a failed `If-Match` is never converted
  into a 304 by a matching `If-None-Match`. Every one of them is answered
  against the representation content negotiation selects, so a client holding
  the gzip copy and asking for identity is told its copy is not what is being
  served. `If-Match` is compared as opaque equality rather than with strict
  strong comparison, because every validator here is weak by construction and
  the strict reading would answer 412 to a client echoing the exact validator
  this server handed it. Dates are read only in the three formats RFC 9110
  s5.6.7 defines - an ISO 8601 string is not an HTTP-date and is ignored like
  any other unintelligible value. `last-modified` joins the reserved
  `staticHeaders` keys: the preconditions answer from the file's real date, so
  an app-chosen value would make them lie.

### Fixed

- A `304` now carries `ETag`, `Cache-Control`, `Vary` and `Last-Modified`, per
  RFC 9110 s15.4.5. It carried none of them, so every revalidating cache got a
  response it could not use to extend what it had stored. The fields are baked
  per coding at index time, so the answer still costs no header build.

- `If-None-Match` takes `*` and the list form, and entity-tags compare weakly
  as RFC 9110 s13.1.2 requires - a cache that stored the opaque tag without the
  `W/` prefix is asking about the same representation and now gets the 304 it
  asked for.

- A shed upgrade's `Retry-After` jitter produces the spread its shape always
  suggested. The band arithmetic gains svelte-adapter-uws's two-value floor -
  `base + floor(random() * max(2, ceil(base * spread)))` - so at the shared
  base of 2 a refusal answers 2..3 where it used to answer exactly 2 on every
  draw: `floor(random() * 1)` is 0 for every draw below 1, so a refused fleet
  was told the same second and returned together into the same full gate. The
  primitive is the exported `jitterRetryAfter`, every capacity refusal
  (cursor lane included) draws from it, and both edges of the band are pinned
  through an injected RNG - a range assertion alone passes against a constant.

### Changed

- The build-injected specifiers are package imports now. The runtime's bridge
  modules import `#server`, `#manifest` and `#ws-handler`, and the build writes
  a `package.json` into the output root that maps them to the generated chunks
  (and pins `"type": "module"`, so the output stays ESM whatever the app's own
  package.json says). They were bare tokens rewritten during the copy, which
  replaced the token anywhere it appeared - a comment reading "MANIFEST ORDER
  FIRST" shipped mangled - and which meant tests could only reach the handler
  graph through a Node resolver hook that Bun silently ignores, so no
  source-level suite could run on the runtime this adapter targets.

- Every gate now runs on Bun 1.3.14 and 1.4.0 in CI, not only the Bun-driven
  lanes: the unit and sim suites (one process per file, restoring the isolation
  `node --test` provides and `bun test` does not), both golden corpora - which
  must match the Node-blessed fingerprints, making that gate a cross-engine
  determinism check - and the determinism scan. Measured on both generations
  before wiring: unit 70/70 files, sim 8/8, corpora 2x40/40, all green on each.

- The resume lane's close contract now documents what a client actually
  observes. A socket that refuses the truncation marker twice is still closed
  instead of acked, and the close is still asked for with 1013 - but a socket
  saturated enough to refuse that marker is torn down before the close frame
  reaches the client, which sees an abnormal 1006 instead. Both supported Bun
  generations behave that way, and the probe records the measurement. What a
  client can build on is the absent `subscribed` ack and the ended connection,
  not the code; the family clients reconnect from either one.

## [0.0.2] - 2026-08-25

Still pre-alpha, and the public contract is still not stable. What changed since
0.0.1 is the realtime half: the binary wire members, the codec registry, cohort
split and the resume/seq buffers are implemented now, as is the
pressure/protection surface. The WebSocket contract is exercised by unit, live
and leak suites in CI rather than by a smoke test nothing ran. The upgrade path
gained admission control, per-address rate limiting and an auth preflight
endpoint. Every suite runs on Bun 1.3.14 and on 1.4.0.

### Changed

- The adapter's own build-time options and the environment variables its server
  reads are documented. `envPrefix`, `healthCheckPath`, `readinessCheckPath`,
  `staticCacheMaxFileSize` and `staticHeaders` had no README entry at all, and
  neither did `HOST`, `PORT`, the forwarded-header set, the body-size cap, the
  shutdown knobs or the TLS pair.

- A close code or reason the runtime refuses to put on the wire no longer
  turns a graceful close into a crash. uWS sends any `(code, reason)` a hook
  passes, so code written against the family surface has never had these
  arguments checked - and a runtime that throws on a code outside
  1000-1003/1007-1014/3000-4999 or a reason over 123 UTF-8 bytes would throw
  out of `end()` and `close()`, the calls that live in cleanup paths. An
  unsendable code is clamped to 1000 with the reason kept (a no-code close
  cannot carry one), said once out loud so the app learns its code never
  reaches clients; an oversize reason is cut at the last whole code point
  that fits; a reason with no code rides on 1000 rather than being dropped.

- `platform.publish()` reads the three answers the runtime actually gives,
  rather than two. On Bun 1.4 a frame queued for a subscriber under
  backpressure comes back as `-1`, which the old byte-count-or-zero reading
  called "nobody got it" - so an app retrying on `false` would have sent it a
  second time, to a socket already behind. A discarded frame and an empty
  topic both answer `0` and still read as unreached. Only the codes the
  runtime documents claim delivery: an unrecognized one reads as unreached,
  the conservative direction the per-socket send mapping already took, since
  a needless resend self-heals and a false delivery loses the frame in
  silence.

- An option value that cannot be JSON-serialized is now refused by the option
  it names rather than by the message builder. `staticCacheMaxFileSize: 1024n`
  failed the build with "Do not know how to serialize a BigInt" - an error
  naming neither the option nor what it accepts, on a value written precisely
  because a large integer was meant. Every adapter-option diagnostic renders
  its value through one total formatter now, so a BigInt, a Symbol, a function
  or an object whose getters throw all describe themselves instead of
  replacing the message with an error of their own. Total includes the
  formatter's own fallbacks: rendering a value can run code the value brought
  with it (a `toJSON`, a `toString`, a `Symbol.toStringTag` getter, a revoked
  proxy's traps), so every renderer is guarded and the last resort is a
  literal that reads nothing from the value at all.

- A `websocket.*` option written at the TOP level is now answered with its
  real home: a top-level `maxPayloadLength` is met with a suggestion of
  `websocket.maxPayloadLength`, rather than with an unrelated top-level option
  or with nothing at all. A correctly spelled key sitting one level too high is
  the single mistake the spelling suggestion could not reach, because no
  top-level name resembles it - so the option was dropped with the protection
  it configures never applied, and no usable hint. That is the shape the move
  of `path`, `handler` and `compressCredentialedResponses` into the
  `websocket` block makes easiest to hit.

- The parity pin moved to the svelte-adapter-uws 0.6.0-next.92 release cut, and
  the vendored `protocol.schema.json` was re-taken from it. The pin names a
  COMMIT rather than a version, because it has to: commits twenty apart both
  read `0.6.0-next.92`, so the version alone cannot say which tree parity was
  measured against. What uws added in between is recorded rather than quietly
  counted as parity: `platform.diagnostic`, `platform.trace` and
  `platform.traceContext`, the `tracing` and `staticCacheControl` adapter
  options, `websocket.maxTopicSeqEntries`, `websocket.messageAdmission` and
  `websocket.egress` - the outbound half of what `messageAdmission` bounds on
  the way in - and the `./connection` and `./observability` export subpaths are
  all gaps this adapter does not implement. Two entries went the other way and
  were deleted: uws now declares `staticDotfiles` and both
  `upgradeAdmission.maxConnections` and `.maxDeferred`, which this adapter had
  been carrying as ahead-of-the-pin extras.

  `websocket.maxPayloadLength` gained a ceiling of 2147483647 as part of the
  move. Bun accepts a larger bound without complaint and uws refuses it, so a
  config tuned here alone would have failed the build there - the difference the
  value-range check added in this release exists to catch, caught by it on the
  first regeneration.

- **BREAKING** `websocketPath`, `websocketHandler` and
  `compressCredentialedResponses` moved from the top level into the `websocket`
  block, as `websocket.path`, `websocket.handler` and
  `websocket.compressCredentialedResponses`. That is where svelte-adapter-uws
  declares them, and the two adapters are meant to be drop-in replacements for
  each other - so a config carried between them has to mean the same thing in
  both. It did not: each adapter read a key the other never sets, accepted the
  one it was given as an unknown top-level key, and applied its own default
  instead. The endpoint quietly moved to `/ws`, or the handler quietly resolved
  to `src/ws-handler.js`, with a build-time warning as the only signal. The old
  spellings are gone rather than deprecated, because accepting both is what
  makes a config valid here and silently inert there.

- Whether the realtime endpoint is served at all is now decided by the
  `websocket` keys an app actually sets, not by the block being present. Naming
  only `handler` or `path` says WHERE the endpoint would be, not that one is
  wanted, so an app pointing `handler` at a file it does not have is opting out
  - which is how a build with no realtime tier is expressed.

- **BREAKING** Static paths with a dot-prefixed segment - a stray `.env`, an
  `.htpasswd`, an editor backup, an unpacked `.git` - are no longer indexed
  and answer `404`. The prerendered index is built by the same walk and
  excludes them too. Everything SvelteKit copied out of
  `static/` was served verbatim before, so a file that landed there by
  accident was public to anyone who guessed the name, and `adapter-node`
  refuses dotfiles by default - an app migrating from it gained that exposure
  silently. The rule is segment-wise and applied while the index is built, so
  there is no per-request check to bypass and an encoded request decodes to a
  key the index never held. `.well-known/*` keeps serving (RFC 8615
  discovery), carved out at the first segment only. The build names every
  refused path once, so the change surfaces at build time rather than as a
  production 404. Only the built server is affected: `vite dev` and
  `vite preview` serve `static/` through SvelteKit and do not read the
  option. `staticDotfiles: true` restores the previous indexing
  exactly. svelte-adapter-uws made the same change, spelled the same way.

- **BREAKING (wire-visible)** A publish with no options - or with an options
  object carrying no `seq` - now stamps the per-topic counter, where it
  previously stamped nothing. `platform.publish(topic, event, data)` is the
  most common call shape there is, and svelte-adapter-uws has always stamped
  the counter for it, so the same app emitted `{...,"seq":N}` there and a
  seq-less envelope here, silently. Envelopes on that call now carry a `seq`
  field they did not carry before: a client that keyed on its ABSENCE - dedup
  by "no seq means unordered", a schema validator with
  `additionalProperties: false` - sees new bytes. `{ seq: false }` publishes
  without one and is the way to keep the old shape; `{ seq: true }` and an
  explicit `{ seq: <number> }` are unchanged. Counter seqs are process-local
  and never write an authoritative mark, so no resume boundary moves. They
  do keep an already-marked topic recent, so past the 10,000-topic bound a
  bare publish can change which topic keeps its dedup floor.
- The two bounded per-topic seq maps evict second-chance rather than by exact
  least-recently-used order. Exact order meant deleting and re-adding a key on
  every touch, and Map.delete is not flat in map size - measured under Bun,
  about 700 ns at the 10,000-topic bound, more than an order of magnitude
  above a plain set - so once the counter became the default that sat on every
  publish. A topic touched since the last sweep is spared and moved to the
  back of the queue, so it outlives every entry ahead of it and a quiet topic
  is what an eviction reaches for. One eviction examines a bounded window of
  32 entries: where those are all in use it evicts the oldest of them, so an
  app whose live topic set is larger than the cap does have ACTIVE topics
  evicted - a counter restarts at 1, and a mark takes its topic's resume
  dedup floor with it. Each map now warns once on its own first eviction,
  naming the harm that map causes. What is given up against exact order is
  precision among topics all touched within the same lap. Measured per bare
  publish, against a 51 ns envelope build: the counter stamp costs 17 ns on a
  small working set and 32 ns with the map at its bound, where keeping exact
  order cost about 700 ns.

### Added

- Option parity is now checked by VALUE, not only by name. `probe/uws-surface.json`
  records the range svelte-adapter-uws accepts for every option it guards as a
  protective number - read from its own validator at the pinned commit - and the
  parity suite drives this adapter's validator over the same values. A config that
  builds on one adapter and fails the build on the other is the failure the parity
  work exists to remove, and until now nothing could see one: both adapters named
  `upgradeRateLimitWindow`, so a floor of 0.001 here against 1 there was a
  difference no test in either repo could reach.

  Three differences remain, each recorded with the measured reason for it:
  `maxPayloadLength`, `maxBackpressure` and `idleTimeout` take integers here where
  uws takes any finite number, because Bun validates all three itself and refuses
  a fractional value when the server is constructed. Widening them to match would
  trade a build error for a server that does not start. The record is exact in
  both directions - an unrecorded difference fails the suite, and so does an entry
  that no longer describes one.

- `platform.metrics` and `platform.metricsSnapshot()`: a metrics registry on
  every instance and the Prometheus document it renders, with nothing to
  configure. Serve it from an ordinary route - `return new
  Response(await platform.metricsSnapshot())` - and register your own
  instruments on `platform.metrics`, where they land in the same document after
  the adapter's own families. A signal this instance has not measured is ABSENT
  from the document rather than published as a zero, and that holds over time,
  not only at boot: the sampler-derived gauges appear at its first tick, and the
  kernel readings disappear again if `/proc/pressure` stops answering, so a
  frozen number is never served as a current one. It holds across
  CONFIGURATIONS too - a build with no WebSocket handler publishes the process
  families and whatever your app registered, and none of the realtime ones,
  because a server with no upgrade path has not admitted zero upgrades. Every
  instance means every instance: a build with
  no WebSocket handler carries both members too, so an app whose only use for
  this adapter's observability is a scrape route does not need a realtime tier
  to have one.

  **The adapter owns the registry**, where svelte-adapter-uws takes one from a
  module named in `websocket.metrics`. That is a decision on evidence rather
  than a simplification: measured on this repo's fixture, a module imported by
  both a SvelteKit route and the WebSocket handler ends up as TWO copies in the
  built output, because SvelteKit's server bundle is already bundled before the
  adapter's own pass reads the handler. An app that imported its registry to
  serve `/metrics` would render one the adapter never wrote to - every adapter
  family stuck at zero with nothing to say why. Reaching it through `platform`,
  the object SSR already receives, is what makes there be exactly one.
  `platform.metrics` is therefore never `null` here, and `metricsSnapshot()`
  resolves to a string rather than to `string | null`.

  **Nothing is emitted from a hot path.** The runtime already counts refusals by
  reason, publishes, closed-socket aborts, the admission gate's levels and the
  pressure sampler's last reading; the document is projected from those
  authoritative numbers when something scrapes. Metrics cost nothing until they
  are read, and no second tally can disagree with the first. The
  pressure-derived gauges are as fresh as the last sampler tick, which
  `pressure_sample_timestamp_seconds` states outright.

  The metric names, types and label vocabularies are svelte-adapter-uws's, so a
  dashboard moves between the adapters. A signal this adapter cannot measure is
  **absent** rather than published as zero, because a zero for something never
  measured reads as healthy and no alert ever fires - so the upgrade and
  connection counters, the pressure and memory gauges and the kernel readings
  are here, while the relay, clustering, waiting-room, posture and egress
  families are not, each waiting on its own recorded gap. `http_requests_total`
  and the duration histograms need instrumentation on the request path itself
  and are their own slice. `metrics_snapshot_workers_expected`, `_reporting`
  and `metrics_snapshot_degraded` are always `1`, `1` and `0`: this adapter is
  single-process, and they are carried so an alert written against the sibling
  still evaluates rather than silently matching no series.

  Two new counters back this: `upgrade_admitted_total` (the denominator the
  refusal counts never had) and per-door rate-limit map evictions, which say
  when the map cap rather than the configured limit is deciding who gets
  metered.

  `websocket.metrics` - the option naming a registry module on the sibling - is
  accepted so a carried config builds, and is **not loaded**. The build warns
  and names `platform.metrics` as the way in. Honouring it would produce a
  server that looks instrumented and is not, for the two-copies reason above; a
  value that is not a module path is still a build failure, because that is a
  mistake wherever it was going to be read.

- The auth preflight endpoint, with `websocket.authPath` (default
  `/__ws/auth`) and `websocket.authPathRequireOrigin` (default `true`). Export
  an `authenticate` hook from your WebSocket handler and the adapter mounts a
  `POST` endpoint there; export nothing and there is no endpoint, so the path
  falls through to ordinary routing exactly as before. The family client store
  posts to it before opening a socket when `connect({ auth: true })` is used.

  It exists because a `Set-Cookie` on the `101` upgrade response is silently
  dropped by Cloudflare Tunnel and other strict edge proxies - a session
  refresh that rides on the handshake therefore works in development and
  disappears in production with no error anywhere. Moving it to an ordinary
  HTTP response is what every proxy understands. The hook is handed the real
  `Request` plus `{ platform, cookies, getClientAddress }`: return nothing for
  `204`, `false` for `401`, or a `Response` to use verbatim, with anything set
  through `cookies` merged onto whichever of the three you return. A wrong verb
  is answered `405` rather than falling through to the SSR catch-all, which
  would render the app shell at a URL that is not a page. A throwing hook is
  `500`, logged once per throttle window.

  `authPathRequireOrigin` is the CSRF guard, on by default: the endpoint runs
  app credential code against session cookies, so a page on any origin could
  otherwise drive it with a credentialed `fetch` and the visitor's cookie
  riding along. A request is accepted when it carries `x-requested-with:
  XMLHttpRequest`, or `sec-fetch-site: same-origin`, or an `Origin` that
  `allowedOrigins` allows - the first of which the family client always sends,
  so browser traffic is unaffected. A **missing** `Origin` is refused here
  where the upgrade door allows it: that door has the app's `upgrade` hook
  behind it to authenticate a non-browser client, and this endpoint is itself
  the authentication. Set it to `false` for native clients that send none of
  the three.

  `authPath` must be absolute and must differ from `websocket.path` and from
  the probe routes; each collision fails the build, because the WebSocket lane
  and the probes are matched first and the preflight would simply never be
  reached.

- `websocket.authPathRateLimit` and `websocket.authPathRateLimitWindow`, a
  per-client-address sliding-window limit on the auth preflight. Thirty per ten
  seconds by default, as svelte-adapter-uws defaults them - **higher than
  `upgradeRateLimit` on purpose**, because every reconnect that preflights also
  upgrades, so this door sees at least as much traffic during a deploy's
  reconnect wave and matching them 1:1 would make the preflight the binding
  constraint on both. Over the limit is `429` with a `retry-after` naming the
  window, and the `authenticate` hook is never called - so a credential check
  against a database cannot be driven at raw server capacity from one address.
  Set `authPathRateLimit: 0` to disable it; the WINDOW refuses zero, because a
  zero window admits everything rather than disabling anything.

  The two doors have SEPARATE budgets, which a shared map would quietly break:
  spending the preflight allowance would then refuse handshakes the upgrade
  limit would have admitted. Identity resolution, the monotonic window, the
  bounded map and the proxy-collapse advisory are shared with the upgrade
  limiter, and that advisory now names whichever door refused first rather than
  always naming the upgrade knob. Refusals are counted as
  `upgrade_rejected_total{reason: "auth_rate_limit"}`, which is where the
  sibling counts them: a refused preflight is a socket that never opens, and a
  dashboard reading upgrade refusals by reason would otherwise be blind to the
  door that turned the client away first.

- `websocket.upgradeAdmission`, admission control for the upgrade path, spelled
  and defaulted exactly as svelte-adapter-uws spells it so a config carried
  between the two adapters gates the same way. Four independent opt-in layers:
  `maxConcurrent` bounds handshakes in flight and is checked before the origin
  comparison and the `upgrade` hook, so a connection storm is shed without
  spending CPU on it; `maxConnections` bounds reserved upgrades plus live
  connections with a permit held until close, which is what stops sequential
  handshakes walking past a live-connection ceiling one at a time;
  `perTickBudget` bounds upgrades per event-loop tick so one I/O batch cannot
  starve the loop, with `maxDeferred` (1024 while pacing) bounding the finite
  queue behind it rather than retaining closures without limit; and
  `cursorLane` reserves a fraction of `maxConcurrent` for a deprioritised
  cursor-only lane, routed on the `svelte-realtime-cursor` subprotocol, so
  cursor reconnects can never starve ordinary admission. A crossed ceiling
  answers `503` with `retry-after: 2`, as uws answers it. A block that gates
  nothing - omitted, empty, or all zeroes - leaves the upgrade path
  byte-identical to before.

  `waitingRoom` is accepted but not honoured: uws serves a holding page at a
  crossed ceiling unless the key is `false`, and this adapter has no holding
  page. Accepting the key keeps a uws config building; a config that asks for
  the page is told at build time that it will get a `503` instead.

- `websocket.upgradeRateLimit` and `websocket.upgradeRateLimitWindow`, a
  per-client-address sliding-window limit on WebSocket upgrades. Ten per ten
  seconds by default, as svelte-adapter-uws defaults them, so **a server that
  sets neither is now metered where it previously was not** - set
  `upgradeRateLimit: 0` to keep the old behaviour, and note that a load test
  from one machine is a single client by this measure. Over the limit is `429`
  with a `retry-after` naming the window. It is checked before the Origin
  comparison and before the app's `upgrade` hook: the Origin gate bounds no rate
  (a non-browser client sends whatever Origin it likes), so without this the
  hook - typically a cookie parse and a database round trip - is reachable at
  raw server capacity from a single address.

  The identity is the socket peer unless `ADDRESS_HEADER` is set, in which case
  the header is read - **and with `TRUSTED_PROXIES` unset it is read from
  anyone**, exactly as the SSR resolver reads it. That makes the bucket key a
  string the client chooses: a fresh value per request reaches no limit, and a
  victim's address spends theirs. **Set `TRUSTED_PROXIES` whenever you set
  `ADDRESS_HEADER`**, so the claim is honoured only where something you run
  wrote it; the server says so at boot when a limiter is configured and it is
  not. Unlike the SSR resolver, a missing or unusable header falls back to the
  socket peer rather than throwing - a bucket key is not `getClientAddress`,
  and a proxy dropping a header would otherwise turn every upgrade into a 500.

  The server also says once per door, on the first refusal that looks like it,
  that this instance may be metering every client as one - a client address
  that could not be resolved at all, a configured `ADDRESS_HEADER` that did not
  arrive on the request, or a loopback or private peer with no header
  configured. All three are the same outage from the client's side:
  intermittent `429`s under trivial traffic.

  IPv6 is keyed on its /64 allocation prefix (6to4 on its /48), because keying
  the full address lets one attacker source every request from a fresh one and
  never share a bucket with itself. IPv4, IPv4-mapped, NAT64, Teredo,
  link-local, scoped, malformed and opaque values keep their full value, since
  their /64 is shared by unrelated clients. The window is measured on the
  MONOTONIC clock, so a wall-clock step cannot retire or extend one, and it must
  be at least a second - svelte-adapter-uws's floor, so a config carried between
  the two adapters cannot build on one and fail the build on the other. A window
  of zero is refused separately and for a different reason: it makes the sliding
  estimate `NaN`, and `NaN >= limit` is false, so the door would admit
  everything while the config said a limit was in force.

  Refusals are counted as `upgrade_rejected_total{reason: "ip_rate_limit"}`.

- `websocket.upgradeTimeout`, in seconds, bounding how long the app's `upgrade`
  hook may take before the handshake is refused with `504 Gateway Timeout`.
  Spelled and defaulted as svelte-adapter-uws spells it, **including the default
  of 10 seconds** - so an app whose hook legitimately takes longer than that now
  gets a 504 where it previously waited indefinitely, and should set the bound it
  wants or `0` to keep waiting. The hook is the part of a handshake that can
  hang: it awaits a database, an identity provider or a lock, and while it waits
  the handshake holds an admission slot and a connection permit that no other
  client can have, so one unreachable dependency would otherwise turn the whole
  upgrade ceiling into a queue of handshakes that never finish. A timed-out
  handshake returns both counters, is counted as
  `upgrade_rejected_total{reason: "auth_timeout"}`, and says so once per throttle
  window - a crossed ceiling is the server working as configured, but this is a
  dependency that is not answering, and the symptom without a line is sockets
  that 504 for no stated reason. A hook that resolves afterwards resolves into
  nothing: its value is discarded rather than upgrading a client that has already
  been refused, and a late rejection is swallowed rather than escaping as an
  unhandled one. A hook that answers WITHOUT a promise arms no timer at all, so
  the common path is unchanged.

- The pressure observability surface and LEASE/REQUEST_N flow control,
  matching svelte-adapter-uws: `platform.pressure` (the live 1 Hz
  snapshot - saturation value, reason, publish rate, subscriber ratio,
  backpressure aggregates, kernel PSI/CPU-quota readings where the host has
  them), `platform.protection` (reads `'normal'` until the posture machine's
  option is accepted), `platform.onPressure` (reason transitions) and
  `platform.onPublishRate` (per-topic runaway-publisher reports; the
  default is a throttled console warning). A client advertising the `lease`
  capability in its `hello` is answered with `lease-ok` plus a `lease`
  window grant, and `request-n` re-grants a window sized from per-connection
  subscriber load - windows narrow as fan-out rises and always floor,
  so an opted-in client keeps making progress. Thresholds are tunable via
  the new `websocket.pressure` block, validated at build time; every signal
  can be disabled with `false`.

  One default differs from svelte-adapter-uws deliberately:
  `memoryHeapUsedRatio` ships **disabled** rather than at 0.85, because
  `heapUsed / heapTotal` is not a saturation measure on this engine - an idle
  server measures 0.90 to 0.94, so the family threshold would report `MEMORY`
  pressure on a healthy process for the life of the app. The same reading is
  kept out of the lease window sizing, where it would otherwise collapse an
  unloaded server's window to about a sixteenth of the base. Both are pinned
  against a real server by the live suite, and
  `websocket: { pressure: { memoryHeapUsedRatio: 0.85 } }` restores the
  sibling's exact behavior. The cost, stated plainly: on a host without PSI
  (every non-Linux host) this adapter now ships no memory pressure signal at
  all, so `onPressure` is not a memory alert there. On Linux `psiMemoryFull`
  is live and is the better signal anyway - kernel stall time fires earlier
  than an OOM-adjacent heap ratio.

- A deterministic simulation harness and golden gate. `src/sim.js` drives the
  REAL handler dispatch - the exact modules a built server runs, loaded
  through a resolution hook - over an in-memory Bun.serve double, a virtual
  clock and a seeded fault engine: a seed plus a commit reproduces an
  interleaving bit-for-bit, and `replaySim` self-gates that determinism on
  every corpus bless. The committed golden corpus
  (`test/dst-goldens/adapter-single.golden.json`, forty seeds, verified in CI
  by `npm run sim:golden`) is fingerprint-identical to svelte-adapter-uws's
  own committed corpus at the parity pin - all forty seeds, the seven
  fault-injected interleavings included - so the two adapters are held to one
  observable behavior by one oracle. Where the sibling's sim drives a testing
  mirror of its dispatch, this one drives the production modules themselves.
  CI also gains the pinned-Bun probe job (a Bun upgrade that breaks an
  observed behavior fails loudly) and the determinism seam scan.

- The simulator models what the runtime does when a socket closes: the request
  it was upgraded from ends, and it ends BEFORE the close callback runs. That
  matters for a socket the app closes from inside `open`, which is dispatched
  synchronously inside `server.upgrade()` - modelling the close without the
  abort left a handshake's hang-up watch armed while its own socket tore down,
  so the interleaving that releases an admission permit twice could not occur
  under simulation at all.

- A second committed golden corpus
  (`test/dst-goldens/adapter-admission.golden.json`, forty seeds) that drives a
  server with all four `upgradeAdmission` layers configured at once, an app that
  refuses sockets from inside its `open` hook, and clients that leave while the
  app's `upgrade` hook still has them. Every refusal reason the ceiling can give
  is given by some seed - the concurrent-upgrade ceiling, the live-connection
  ceiling, the cursor sub-budget and the finite pacing queue - and the layers are
  configured together because that is the only way their interactions are pinned:
  the cursor lane carves its sub-budget out of `maxConcurrent`, and pacing parks
  a handshake across ticks while it is already holding a permit, which is a
  window a client can leave in. Those are the orderings the upgrade path is
  built around, and
  a refused socket runs its close callback - permit release included - before
  `server.upgrade()` has returned, so the accounting is at its most delicate
  exactly where nothing else exercised it. Clients arrive in two waves, so a
  permit given back by the first wave is what admits someone in the second:
  a leaked permit costs nothing until the next client needs it, and a workload
  that never re-uses one cannot fail on it. `npm run sim:golden` runs both
  corpora; a corpus names the server and the workload it was blessed under, and
  a run against a different one is refused rather than reported as drift.
  `adapter-single` is untouched, so it stays fingerprint-identical to
  svelte-adapter-uws's corpus - an adapter-specific workload gets its own file
  rather than diluting the cross-adapter one.

- A steady-state hypothesis over the upgrade ceiling: when a run settles, the
  permits it holds must be exactly the sockets that are open, nothing may still
  be in flight, the cursor sub-budget must be back, and the pacing queue must be
  empty. A permit that outlives its handshake narrows the ceiling for every later
  client and is otherwise silent until the server stops admitting anyone. The
  cursor sub-budget is read separately rather than trusted to move with the
  shared in-flight counter, because the two are kept in step by hand: released
  down the main lane's path, the shared counter settles at zero while the cursor
  lane stays permanently full and refuses every later cursor socket.

- An injectable runtime seam (`src/runtime/runtime.js`): every clock, RNG and
  timer read in the served runtime goes through named helpers over one
  swappable environment - identical in shape to svelte-adapter-uws's seam -
  so a seeded harness can replay behavior exactly without patching globals.
  In production the helpers bind straight to the native primitives
  (monomorphic, measured at parity on the publish hot paths). The process
  epoch is now drawn through the seam and re-latchable by a harness; entropy
  and semantics are unchanged. `npm run check:determinism` scans the source
  for raw primitive calls and fails on any under `src/`, so the seam cannot
  silently regress.

- A boot-time version banner. The first line a built server logs is its
  resolved identity - own version, protocol revision, and the version of each
  family sibling as `import.meta.resolve` actually finds it (or "not
  installed") - all read at runtime from files, never from constants inlined
  at build time: the build copies the exact `package.json` and
  `protocol.schema.json` that produced the server into `build/meta/`. Mixed
  sibling versions are the usual cause when two surfaces disagree, and the
  banner puts the answer at the top of every boot log. The protocol schema now
  ships in the package as `protocol.schema.json`, a vendored byte-identical
  copy of svelte-adapter-uws's, held to it by a hash the parity manifest
  records at its pinned commit.

- Deterministic I/O budgets for the HTTP static lane
  (`test/unit/http-io-budget.test.mjs`), counting operations per response the
  way the fan-out budgets already do: one Headers and one Response per served
  asset, zero disk opens from the memory lane on any representation, exactly
  one `Bun.file` per disk-lane GET and none per HEAD, a 304 with no header
  build, one pathname decode however often the same encoded path repeats -
  each pinned exactly and under 6x load, so a lost cache or a new per-request
  disk touch fails a count, not a timing.

- A publishing-hygiene gate: `npm run check:publish` runs publint and
  arethetypeswrong (esm-only profile) against the packed package, and CI runs
  it on every push. It validates the export map and file list as a consumer's
  package manager would resolve them, which no amount of local testing covers.

- Adapter options are validated on a two-tier policy. An unknown top-level key
  is warned about at build time and names the option it probably meant
  (`precomress` suggests `precompress`, and a case-only difference always
  matches); it is never fatal, so an app pinned to an older adapter than its
  config was written for still builds. A known option carrying a value the
  adapter cannot honour throws at once, saying what the option accepts - and
  nothing is coerced, so `precompress: 'no'` is refused rather than read as
  truthy. `healthCheckPath` is now held to the same rule `readinessCheckPath`
  already was: without a leading slash it could never match a request, so the
  liveness probe would have 404'd forever while looking configured.

- `publishWireBatch` entries may carry their own explicit cluster seq
  (`{ data, seq }`), alongside the per-entry `excludeWs` they already had. That
  is the only form that can honour the method's contract of one seq per entry
  when the seqs come from a cluster rather than from the local counter, so an
  authoritative publisher no longer has to give up batching to stamp its own
  seqs. `{ seq: true }` is unchanged: the counter already increments per entry.

- The binary wire tier: `platform.publishWire`, `platform.publishWireBatch`,
  `platform.sendWire`, `platform.sendWireBatch`, and
  `platform.registerWireCodec`. Connections that declare a codec's capability
  in a `{"type":"hello","caps":[...]}` frame receive `0x03` codec frames -
  `[0x03][schemaVersion][topicId:varint][seq:varint][payload]`, the family
  layout - with the numeric topic id announced on the same socket before the
  first frame; everyone else receives exactly the envelope `publish()` would
  have sent, carrying the SAME seq as the binary frame. When no connected
  client wants binary for a codec, a wire publish is one native fan-out,
  byte-identical to `publish()`. A dropped stateful frame (or a dropped
  announce) permanently degrades that capability to JSON for the connection's
  life, because the encode already advanced per-connection dictionary state
  the client can no longer catch up with; backpressure-enqueued frames are
  delivery, never a drop. Stateless codecs marked `shared` fan out through
  cohort topics (`topic` + a NUL byte + `bin`/`json`) with a refcounted
  server-wide wire id, so one publish is two native publishes instead of a
  per-connection walk.
- Resume gap-fill: a `subscribe` frame may carry `recover: { offset, epoch? }`
  to run the app's `resume` hook - only after the authorization gate allows -
  before going live, with a live-frame barrier bridging the hook's await
  window so a publish landing mid-resume reaches the client, in order, before
  its `subscribed` ack. A window that overflows its frame cap, or a gap-fill
  frame the socket refuses past its backpressure limit, signals `truncated` on
  the replay channel (`__replay:<topic>`) so the client cold-resyncs instead of
  trusting a partial flush. The standalone `{"type":"resume"}` frame drives the same hook for
  client-named topics and answers `{"type":"resumed"}` once its gap-fill has
  flushed. Its topics are held to the always-illegal bytes, to `__proto__` (an
  app allowlist written as a plain object reads that key truthy off
  `Object.prototype`), and to the system-topic guard - but deliberately NOT to
  the wire subscribe lane's `allowNonAsciiTopics` rule, because
  `platform.subscribe` grants non-ASCII names past that bound on purpose and a
  stricter resume would silently drop a topic the app had legitimately granted.
  The frame is bounded like a `subscribe-batch` and by the same number: at most
  256 topics, counting the UNION of its `lastSeenSeqs` and `lastSeenEpochs` so
  that two disjoint maps cannot name twice the cap while each looks compliant.
  Past it the frame is refused WHOLE with
  `{"type":"error","code":"RESUME_TOO_LARGE","limit":L,"size":N}` and no
  `resumed`. The per-connection gate beside it counts FRAMES rather than topics,
  so without a per-frame bound one legal frame could open a backend read per
  topic it named; refusing whole rather than truncating is what keeps a
  partly-covered gap-fill from ending in `resumed` on a client that has no way
  to detect the hole. Its `sessionId` takes rules of its own - 1 to 128
  characters of printable ASCII, no quote or backslash - since it is handed to
  the hook, which queries a backend with it; one that breaks them is answered
  `{"type":"error","code":"INVALID_SESSION_ID"}` with the value never echoed
  back, rather than forwarded.
  `resumed` is sent ONLY when the gap-fill actually ran, or when the app exports
  no `resume` hook and there was nothing to serve. A saturated per-connection
  gate answers `{"type":"error","code":"RESUME_RATE_LIMITED"}` and a hook that
  threw or rejected answers `{"type":"error","code":"RESUME_FAILED"}`, both in
  place of the ack rather than alongside it: `resumed` is the only frame a
  resuming client keys on and it has no gap detection, so acking a frame whose
  hook never ran told the client it had caught up on history nobody read. The
  two codes are distinct because the client's move differs - a saturated gate is
  transient and worth retrying, while a hook that threw wants a cold resync.
  On the `subscribe` + `recover` lane the same failure is answered with the
  marker instead of an error, because that lane answers per topic and already
  has the replay channel open: a `resume` hook that throws there now emits
  `{"topic":"__replay:t","event":"truncated","data":null}` before the
  `subscribed` ack, so the ack no longer implies a gap-fill that did not happen.
  It previously logged the throw and acked as though the history had been
  served. That is the same marker the lane already sends for an overflowed
  window or a refused gap-fill frame.
- A live wire suite (`test/live/wire-check.mjs`) driving two raw WebSocket
  clients - one capable, one JSON-only - plus a resuming third against the
  built fixture: the announce, per-connection stateful payloads, seq parity
  between frame and envelope, the batch fallback, the cohort split with a
  shared id past the 2^32 partition base, and both resume paths asserted on
  client-delivered bytes.

- A CI workflow (`.github/workflows/ci.yml`) running the unit suite and the
  live lane on Linux. The graceful-shutdown SIGNAL path is asserted there and
  only there: on Windows a `SIGTERM` terminates the built server without the
  handler running at all, so `test/live/shutdown-check.mjs` skips rather than
  reporting a failure that says nothing about the code. It asserts that the
  signal reaches the handler, that clients are advised before being closed
  1012, that the app's `shutdown` hook runs from that path while its
  connections still exist, that every close hook runs and its asynchronous
  work completes rather than being cut off by the exit, that the process exits
  0 inside its deadline, and that a `shutdown` hook that never settles cannot
  hold the process open past that deadline.
- A live suite for the send-result mapping (`test/live/send-result-check.mjs`,
  first step of the live lane, no build needed): the real socket facade driven
  over a genuinely saturated Bun socket, with the tri-state checked against
  what the client actually receives - every frame reported delivered or
  enqueued must arrive, no frame reported dropped may arrive, and a closed
  socket throws before the mapping runs. Zero-length payloads are covered in
  both socket states.
- An A/B benchmark for the userData access strategy
  (`bench/userdata-strategy.mjs`): the shipped per-connection facade against a
  prototype-patched read on a real `ServerWebSocket`, with per-message
  composites at the access counts the handler actually pays.
- A tracked live test lane (`test/live/`, `npm run test:live`) that asserts the
  WebSocket wire contract end to end: the send-result mapping against a real
  slow consumer, then, against the built fixture, the subscribe, batch, and
  unsubscribe frames, the subscription cap under pipelined frames, Origin
  enforcement on the upgrade, the graceful-shutdown signal path (Linux only),
  and a no-handler build whose HTTP surface must be untouched. The fixture
  gained a `NO_WS` build variant (`build-no-ws`) for the last of those.
- Unit coverage for the WebSocket demux (`test/unit/ws-demux.test.mjs`). It
  reaches the app through a specifier the build injects, so nothing outside a
  build could import it and every defect in it was found by reading; a loader
  hook now resolves that specifier to a stub.
- `platform.droppedReleaseRecords`, an instance-wide counter of releases whose
  teardown could not be recorded for the `close` hook. Any non-zero value means
  an `unsubscribe` hook has been failing persistently enough to fill a
  connection's record, so those releases lost the close-hook fallback. Their
  own hook is then the only thing that could have torn them down, and if the
  deferral queue was also full it did not run either.

### Fixed

- A gap-fill the client could not be told about no longer ends in a `subscribed`
  ack. The replay truncation marker was pushed into the socket that had just
  refused a frame, and its send result was discarded. A connection at or over
  its backpressure limit is the only state that produces the marker, and it is
  also the state that refuses the marker - so the window that most needed the
  signal was the one window that skipped it. The ack followed, the client went
  live, and the hole in its history was undetectable.

  The marker is retried once when the socket refuses it, and a socket that will
  not take the retry either is closed with 1013. The reconnect resumes from the
  last seq the client actually received, so the missed tail is re-delivered
  rather than lost; 1013 is retry-class for the family client, not one of the
  codes it stops reconnecting on. A connection the flush closed is no longer
  acked or joined to a shared fan-out cohort.

- The four `websocket.upgradeAdmission` bounds are checked at build time. They
  were passed through unexamined on the grounds that the gate applies uws's own
  rules, which is true of `maxConnections` and `maxDeferred` and false of the
  other two: the gate reads `maxConcurrent` and `perTickBudget` as `(opts.x) || 0`,
  so a non-empty string is truthy and becomes the bound itself. A string
  `maxConcurrent` compared as `inFlight >= 'abc'` is false forever, so the
  concurrency ceiling was off while the config asked for one; a string
  `perTickBudget` was worse than off, failing the test that would have run
  callbacks inline while leaving the deferred ceiling at 0, so the pacing queue
  was full on arrival and every upgrade was refused. Neither said anything. An
  unconverted environment variable is the realistic way to write one.

  A non-negative safe integer, which is what svelte-adapter-uws requires of all
  four. It used to range-check only the two ceilings and take a fractional value
  for the rest, and this adapter matched that on purpose - refusing a value uws
  runs would turn a working deployment into a build failure on the way across.
  uws has since tightened all four, so this follows: a count is a whole number
  of things, and `maxConcurrent: 1.5` was never a bound anyone meant.

  The cursor fraction is the one that stays loose, because uws still CLAMPS it
  rather than refusing: a fraction above 1, at 0, or below it is a number uws
  runs, so it builds here too.

  `upgradeAdmission.cursorLane.fraction` is refused on the same terms. The gate
  tests `typeof fraction === 'number'` and falls back to 0.25 when it is not, so
  a typo did not fail - it reserved a quarter of the main ceiling for a lane
  nobody had sized. Numbers are still clamped rather than refused, as uws clamps
  them.

- An option error message no longer fails with a different error than the one it
  was written to report. The messages rendered the rejected value with
  `JSON.stringify`, which THROWS on a BigInt, so `upgradeRateLimit: 10n` failed
  the build with "Do not know how to serialize a BigInt" - naming neither the
  option nor what it accepts, on a value someone wrote precisely because they
  meant a large integer. Twenty-eight of the twenty-nine `websocket` options
  reported this way. Values that JSON has no representation for (a function, a
  symbol, a circular object, one whose getters throw) render as themselves now;
  everything else reads exactly as it did.

- **BREAKING (bucket identity)** A rate-limit key no longer carries a port.
  `1.2.3.4:5678` and `[::ffff:1.2.3.4]:5678` keyed as written, so an
  `ADDRESS_HEADER` whose proxy reports the peer SOCKET rather than the peer host
  - Azure App Service does, and so does nginx configured with
  `$remote_addr:$remote_port` - put every request from one client in a fresh
  bucket, and `upgradeRateLimit` and `websocket.authPathRateLimit` could not
  refuse anything. Nothing about the door said so: the map churned, the entry
  cap absorbed it, and the refusal counters stayed at zero, which reads exactly
  like traffic under the limit. (The socket peer this adapter resolves without
  a header never carries a port, so a deployment that sets no `ADDRESS_HEADER`
  was never affected.) The address is now recovered and the port dropped
  wherever the value is RECOGNISED as an address carrying one, including on
  every path that deliberately declines to fold the address itself. A value the
  address parsers do not recognise is never trimmed, port and brackets
  included, so an opaque `ADDRESS_HEADER` string keeps every byte and two
  spellings of one such string stay two identities. Clients that were metered
  separately still are.

- `XFF_DEPTH` is validated at boot: with `ADDRESS_HEADER` set, a value that
  cannot select a hop refuses to start the process, and without one it is named
  in a warning instead. A non-numeric or non-positive value parsed to `NaN` or
  `0`, both of which slipped past the "chain shorter than the configured depth"
  check in each of the two places that read a forwarded chain, and the read that
  followed threw on `undefined`. The result was a 500 with a stack for every SSR
  request and - since metering by client address resolves an address before
  anything has authenticated - for every WebSocket handshake as well, on a
  server that had started and reported itself healthy. It must be plain decimal
  digits: `2.9`, `3junk` and `1e3` were each accepted as a depth nobody wrote
  (2, 3 and 1). The default is `1` and is unaffected, and a server with no
  `ADDRESS_HEADER` reads the value nowhere, so it will not refuse to start over
  one - svelte-adapter-uws refuses that case too, which is the one place these
  two deliberately differ, and only ever by accepting more.

- A client that opened a WebSocket handshake and hung up while the app's
  `upgrade` hook was still awaiting kept one `upgradeAdmission` in-flight slot
  and one connection permit until that hook settled. The hook is the app's - it
  cannot be cancelled and may take as long as it likes - so a fleet of
  connect-then-drop clients held the ceiling closed for a full hook latency
  behind clients that were already gone, which is precisely the storm the
  ceiling exists to shed. Both counters now come back when the client goes,
  within tens of milliseconds of the socket doing so rather than whenever the
  hook happens to finish, and a handshake whose client left is answered without
  spending a pacing turn a live client could have used. A handshake whose slots
  have
  already been returned is answered rather than upgraded, so a socket can never
  be handed a permit that is no longer held - that would have its close callback
  release one nobody took, which throws where it strands the app's `close` hook.
  The default configuration gates nothing and is untouched, wrapper and abort
  listener alike.

- A shed WebSocket upgrade was completely unobservable: no counter, no log line,
  nothing an operator could reach. A server refusing exactly as configured was
  indistinguishable from a broken one, and the quickest thing that made it stop
  was removing the ceiling. A shed now says once what filled up, how full it was,
  and which key widens it. Throttled with decay and per reason, so a lane that is
  refusing constantly cannot silence the first refusal from a different ceiling,
  and a sustained storm costs a handful of lines rather than one per refusal.
  Nothing about the client is logged: a refusal is a statement about this
  server's capacity. svelte-adapter-uws reports the same refusals through its
  metrics registry, which is a recorded parity gap here, so the line is what an
  operator has until that lands.

  Every upgrade refused before open is also counted under the reason that caused
  it, using svelte-adapter-uws's label names so the same event reads as the same
  word on both: `over_capacity`, `cursor_lane`, `connection_capacity`,
  `deferred_overflow`, `bad_origin`, `auth_rejected`, `hook_error`, plus
  `draining`. Both spellings of an app-level refusal count as `auth_rejected` -
  returning `false` and returning a `Response`, the latter being the form this
  adapter's own docs lead with. `draining` is the one label with no uws
  counterpart, because uws does not turn upgrades away while shutting down;
  leaving it out would have made the total quietly wrong during exactly the
  window an operator is watching a rollout. A refusal is not counted at all once
  its client has hung up, as uws also declines to count those - a
  connect-then-drop fleet must not be able to write its own noise into the
  numbers an operator reads.

  The counts are kept whether or not `upgradeAdmission` is configured. Keeping
  them on the gate would have published a confident zero for origin refusals on
  every server that never set a ceiling. uws's remaining labels arrive with the
  features they belong to (`protection`, `upgradeRateLimit`, `upgradeTimeout`,
  the auth endpoint); its `duplicate_header` has no counterpart here at all,
  because repeated request headers are merged before the adapter is entered.

- The `open` hook was called for a connection that had already closed, when the
  welcome frame did not fit the control-egress budget. `maxControlEgressBytes`
  below about 60 bytes refuses that frame and cuts the connection with `4429`,
  and the close callback runs from inside the open callback - so the app's
  `close` hook ran BEFORE its `open` hook, and `open` then received a socket
  whose first `getUserData()` threw. That throw was reported as "the open hook
  threw; the connection was left open", which was wrong twice over. `open` is
  now called only for a connection the app can still use.

- The liveness and readiness probes answered `GET` but 404'd `HEAD`, because
  both were gated behind a `GET` check that let every other method fall through
  to the SSR catch-all. A load balancer or uptime monitor configured to probe
  with `HEAD` would mark every instance permanently unhealthy, while the
  endpoint looked fine to anyone checking it by hand. Both now answer `HEAD`
  with the same status and headers and no body, including a `Content-Length`
  describing the body the `GET` would have returned.

- A streaming response that went quiet for more than about 10 seconds was cut
  mid-flight. The adapter never set `Bun.serve`'s `idleTimeout`, so it inherited
  Bun's default - and a quiet RESPONSE counts as idle, so an SSE endpoint whose
  heartbeat was slower than that lost its connection with nothing the app could
  catch. Measured both ways in `probe/bun-api-facts.report.md`
  (`http-idle-timeout`): unset, a stream idle for 12s is cut while one idle for
  2s is delivered. The adapter now sets the value itself, defaulting to 120
  seconds, which clears ordinary heartbeat intervals while still bounding how
  long a silent connection holds a socket. Configurable with `IDLE_TIMEOUT`
  (seconds; `0` disables it). A value outside the 0-255 range Bun accepts is
  refused at boot with a message naming the variable, rather than falling back
  to a timeout nobody chose.

- An explicit `{ seq: <number> }` went onto both wires unchecked, so a negative
  seq broke the parity the binary tier exists to guarantee: the frame varint
  encodes `-1` and parses it back as `127`, so a capable client and a JSON-only
  client on the same topic read different sequence numbers for the same event,
  and the watermark the client then stored was a number the server never meant.
  A fractional seq split the two wires the same way, being truncated on the
  frame and printed in full in the envelope, and `0` split them a third way -
  it is the frame's "no seq" sentinel, so a stamped 0 vanished for binary
  subscribers while the envelope carried `"seq":0`. An explicit seq must now be
  an integer of at least 1, still with no upper bound since the varint carries
  any magnitude exactly, and one that is not throws a `TypeError`. Not absorbed:
  publishing seq-less would degrade the client's resume dedup silently, and
  coercing to the counter would put a local value into the topic's authoritative
  mark, which is a different sequence space. The check covers
  `publishWireBatch`'s per-entry seq too, which does not go through the same
  stamping path, and a batch is refused whole so a bad entry cannot leave the
  earlier ones already fanned out.

- `publishWireBatch` validated every per-entry seq up front but then read the
  caller's entries and options again while publishing, and by that point app
  code has already run: serialising a payload calls its `toJSON`, which holds
  live references to both. A `toJSON` that changed a later entry's `seq` had
  that unvalidated value stamped on the stateful lane, or thrown on mid-batch
  by the per-entry reroute with the earlier entries already fanned out and the
  topic already marked - the exact partial failure the up-front check exists
  to prevent. Writing a number into the shared options object smuggled the
  refused batch-level seq form back in for every later entry; flipping an
  entry's `excludeWs` made delivery, the fast-path choice and the resume
  capture disagree about who was excluded; swapping a `data` reference put
  different payloads on the two wires under one seq; and growing or shrinking
  the entries array changed which entries went out at all. The call now reads
  its inputs once, at the top: each documented option is read exactly once
  into a private copy - named-field reads through the prototype chain, so a
  seq carried on a prototype or by an inherited accessor is refused exactly
  as an own one, rather than vanishing from a spread - and each entry is
  normalised into a private record - data reference, exclusion target,
  validated seq - that both publish lanes work from, so what the batch
  publishes is what the call was handed, whatever a payload's serialisation
  code mutates in between. Payload contents are the one deliberately live
  part: the record pins the reference, and the object behind it stays the
  app's own, as on every publish lane.

- `publish` and `publishWire` read the caller's live `options.seq` on both
  sides of the payload's serialisation: the seq was stamped from one read and
  its AUTHORITY recorded from another, with the payload's `toJSON` running in
  between. App code that changed `options.seq` across that boundary could
  have a counter-stamped publish recorded as cluster-authoritative - a local
  counter value written into the topic's authoritative mark, which is the
  resume dedup floor, so a later gap-fill window discarded genuine
  explicit-seq frames as already-seen. The inverse flip stripped a delivered
  explicit seq of its authority in the resume capture. Both lanes now capture
  their options in one read per field before any app code runs - the same
  discipline `publishWireBatch` already had - so the value stamped is the
  value recorded, on every lane.

- `publishWireBatch` conflated an explicit seq of 0 with no seq at all. It
  round-tripped every stamped seq through the wire's 0 sentinel before handing
  it to the resume capture, so an entry published with `seq: 0` was captured as
  seq-less - and a seq-less frame is never deduped, so the same event was
  deduped through `publish()` and re-delivered through the batch. The stamped
  seq is now kept as stamped, and the 0 is applied only at the frame builder,
  where it means "no seq" on the wire and nowhere else.

- `publishWireBatch` given a batch-level `{ seq: <number> }` stamped every entry
  with that one number, which cannot be the one-seq-per-entry it documents. It
  now throws a `TypeError` - the same answer an entry seq the wire cannot carry
  gets, so one class of seq misuse has one failure mode whether it was written
  on the call or on an entry. Neither way of absorbing it was safe: with all N
  entries sharing a seq, a client that received only part of the batch reports
  that seq as its watermark and the resume dedup floor then discards the WHOLE
  batch, including the entries it never received; publishing the batch seq-less
  instead traded that for a resume dedup silently degraded to nothing. Put the
  seq on each entry to keep it (`{ data, seq }`), or use `{ seq: true }` for the
  local counter, which already increments per entry. The call is refused before
  the empty-batch no-op, so a tick that happened to have no entries cannot hide
  the misuse until load produces one. Note the asymmetry this settles: a number
  is a valid `seq` for `publish` and `publishWire`, and is not one for
  `publishWireBatch`, whose `options.seq` is now typed and documented as the
  counter opt-in alone. Raised from a hook, the `TypeError` is reported through
  the usual hook-error path and abandons that tick, where the old behaviour
  published it seq-less.

- Every publish member advanced the topic's authoritative mark for a frame it
  then failed to build. The seq check refuses before anything is stamped, but
  the envelope build is a second throw site - it runs `JSON.stringify`, so any
  payload the app cannot serialise, including a `toJSON` of its own - and the
  mark was raised before reaching it. `publishWireBatch` did it per entry, so a
  batch that put nothing on any wire left the mark raised for every entry it had
  got through. That mark is the resume dedup floor: republishing the same seqs
  after fixing the payload had the next gap-fill window discard them as
  already-seen, which is a silent gap of exactly the kind the resume barrier
  exists to prevent. The mark now moves only once the frame exists and the
  server is there to take it, and the batch marks in a second pass after every
  entry has serialised, so it is refused whole for either kind of bad input.
  The stateless batch lane is N independent publishes by construction and keeps
  the contract that follows from that: an entry already delivered keeps its mark
  and its count, and only the failing entry marks nothing. The `{ seq: true }`
  counter is the one thing not rewound - it is a separate space that is never
  deduped and never marks the topic, so a refused publish costs that topic a gap
  in its counter numbering and nothing else, and rewinding it would be unsafe
  anyway because a `toJSON` can publish re-entrantly and take the next value.

- Every publish member counted publishes it went on to refuse. `publish` and
  `publishWire` incremented `publishCount` before stamping the seq, and all
  three - `publishWireBatch` included - counted before building the envelope. So
  a seq the wire cannot carry, or a payload JSON cannot represent, threw the call
  out after it had already advanced a documented metric: "publishes since boot"
  drifted upward on the app's own bug, in the one case where nothing reached a
  socket to notice it by. The count now sits past every point that can still
  refuse the call - the seq stamp, the envelope build, and the server lookup
  that throws when the platform is used before `Bun.serve()` is listening. A
  batch on the stateful lane counts whole after its envelope loop; the stateless
  lane is N independent `publishWire` calls by construction and still counts
  each as it delivers it.

- A wire codec returning something other than a `Uint8Array` hung the event loop
  instead of declining. `safeEncode` caught a throwing `encode` and served the
  JSON envelope, but never checked the TYPE of what came back, so a truthy
  non-`Uint8Array` reached the frame builder - most plausibly a Promise from an
  accidentally `async` encode, which is truthy and has no length. The builder
  sizes its writer `8 + payload.length`, that is `NaN`, `new ArrayBuffer(NaN)`
  is zero bytes, and the writer grew by doubling: `0 * 2` never reaches the
  requested size, so it spun forever. One connection's codec bug took the whole
  process down, with no error and no frame. A wrong-type return is now a decline
  - logged, and served as the JSON envelope like any other - and the writer's
  doubling is seeded to 1 when the buffer is empty, so it makes progress from
  any starting capacity including zero while keeping the original allocation
  behavior (an exact-fit `max(double, needed)` was measured reallocating on
  every subsequent big write and rejected). A failing `encode` on a STATEFUL
  codec - a throw or a wrong-type return, as distinct from a `null` decline -
  now also poisons that connection's capability to JSON until reconnect: the
  encode may have advanced the connection's dictionaries for a frame the
  client never saw, the same decode desync a dropped stateful frame leaves.
  The frame writer's varint refuses non-integers outright rather than spinning
  on `Infinity` or writing garbage for `NaN`.

- The `__replay:t` `truncated` marker was charged to no budget. Every other
  frame a client's own input buys goes through the per-connection control-egress
  bound (`maxControlEgressBytes`), but the marker went to the socket directly -
  so a lane emitting one per resumed topic was an amplifier the bound could not
  see. It is now charged like the acks, and a marker the budget cannot afford
  cuts the connection with `CONTROL_FLOOD` instead of being dropped: dropping it
  silently would restore the very gap the marker exists to close, whereas a
  client that reconnects cold-resyncs, which is what the marker asks for.

- A zero-length payload sent through the socket facade on a healthy socket was
  reported as dropped: Bun returns 0 for "zero bytes accepted" even though the
  empty frame is delivered (probed, pinned in the facts report). The facade
  now consults the socket's backlog to tell a delivered empty frame from one
  genuinely dropped past the backpressure limit; a non-empty send is
  unaffected.

- `SHUTDOWN_RECONNECT_WINDOW_MS` was read at boot but missing from the set of
  names the adapter recognises, so an app using `envPrefix` refused to start
  when it set that documented variable, reporting it as a conflicting one.

- An app that exports no `unsubscribe` hook no longer queues a no-op per
  release. It did, so a client that held many topics and pipelined the releases
  could exhaust the deferral backlog and be cut with 4429 over hooks that do
  not exist.
- A release whose `unsubscribe` hook had not finished when the connection
  closed was torn down by nobody. The release removes the topic from the
  subscription set before the hook is dispatched, and that set is what the
  `close` hook receives - so a hook still queued when the socket died was
  dropped and its topic was absent from the snapshot, leaking whatever
  per-topic state the app holds. A client could drive this deliberately by
  pipelining more releases than the queue carries. Topics the connection held
  are now recorded until their hook SUCCEEDS and are named in the set handed to
  the `close` hook - including when the hook threw or rejected, which released
  nothing. Teardown is therefore at-least-once: a hook that was mid-await when
  the socket died can complete and also have its topic named to `close`, so an
  app's teardown must be idempotent. This is documented in the README.
- The per-topic `subscribe` gate allowed any verdict that was not `false` and
  not a string, so a gate written `return allowed[topic] ? null : 403`, or one
  returning a lookup promise without `await`, denied nothing and handed the
  client every topic it could name. Unreadable verdicts are now refused with
  `INTERNAL_ERROR` and a console error, which is what `subscribeBatch` already
  did - the same hook logic no longer allows through one entry point and denies
  through the other. `null`, `undefined` and `true` still allow.
- A non-finite `ref` (`1e999` parses to `Infinity`) was echoed into acks as
  `null`, the adapter's own spelling for "no ref", so the client received an
  ack it could not correlate. Only finite numbers are echoable.
- `allowedOrigins: 'same-origin'` with no `ORIGIN` configured compares the
  request against an origin derived from its own `Host` header, which a client
  controls. The behavior is kept (refusing every upgrade on an unconfigured
  server would break local development) but the adapter now warns once on the
  first upgrade that relies on it, and the README says what the default does
  and does not defend against.
- README: the 4 MiB control-egress budget admits 86 worst-shaped batch
  answers per window, not 88. The "full batch of ordinary topic names" figure
  described a measurement taken against the test fixture's deliberately small
  subscription cap, where most answers are denials; a batch that all installs
  is roughly 17 KB.
- The live test lane could report green against a build it never produced:
  `NO_WS` and `NODE_ENV` were not pinned when the runner built the fixture, and
  no suite checked whether something was already serving its port - a leftover
  server from an interrupted run answers in about a millisecond, long before a
  fresh one can boot and fail to bind, so the whole suite would assert against
  the stranger. Each suite now refuses to start on a busy port, fails fast when
  the server it spawned exits, and starts that server with the runtime's
  environment variables cleared rather than inherited. The subscription-cap
  check now asserts the cap is filled exactly, since an upper bound alone was
  satisfied by a regression that refuses every subscribe.
- The fixture no longer declares `svelte-adapter-uws` as a dependency, so
  `npm install` in `test/fixture` works on a clone with no sibling checkout -
  it previously failed outright, which made the live lane unrunnable anywhere
  but the author's machine. `ADAPTER=uws` imports it by path, overridable with
  `UWS_ADAPTER`.
- The resume barrier's per-topic high-water mark was written by two unrelated
  sequence spaces. Both the local `{ seq: true }` counter and an explicit
  cluster-stamped `{ seq: <number> }` wrote it, the monotone guard applied only
  to explicit seqs, and only explicit seqs are ever measured against it - so on
  a topic published both ways a counter publish overwrote the explicit mark,
  downward included. That mark is the bound on the watermark an app's `resume`
  hook reports. Pulled DOWN, it made an honest report look impossible: the
  report was rejected and the gap-fill fell back to re-delivering the whole held
  window. Pulled UP, by a counter that had run further than the cluster seqs, it
  did the opposite - a client echoing that offset back could suppress held
  frames the resume never covered. The mark now tracks the explicit lane alone,
  a counter publish keeps its topic recent there and changes no value, and a seq
  no comparison can order (`NaN`) neither erases a standing mark nor seeds a new
  one. `{ seq: true }` publishes no longer occupy that map at all, so its
  eviction cap bounds only topics carrying cluster-stamped seqs.
  One behavior change to know about: on a topic published both ways, the floor
  used when a hook reports nothing is now that explicit mark rather than
  whichever lane published last, so an in-window frame carrying an older
  explicit seq is deduped where it previously flushed by accident. Report the
  watermark you covered and the boundary is exact either way.
- A topic this server had stamped no explicit seq for was treated as having
  covered seq 0, so the first frame of a 0-based cluster sequence space - a
  Kafka offset, a log index - was deduped away during a resume gap-fill and
  reached the client from nobody, with no truncation marker and nothing to make
  the client notice. "No mark yet" and "mark of 0" are now distinct: an unmarked
  topic dedups nothing, while a topic whose mark really is 0 still covers seq 0.

## [0.0.1] - 2026-07-30

First release, and a pre-alpha one: the package exists so the name is taken and
the shape can be reviewed in the open. The HTTP half and the JSON realtime tier
both work, but the public contract is not stable, the binary wire and pressure
surfaces are not implemented, and multi-node fan-out through
svelte-adapter-uws-extensions does not work yet. Do not build on this release.

### Added

#### HTTP

- A build-time adapter (Rollup bundling of the SvelteKit server output, asset
  copy, precompression, placeholder replacement - no native addon, no worker
  bootstrap) plus a `Bun.serve` runtime. `fetch(req)` hands SvelteKit a real web
  Request via `server.respond()`, and Bun consumes the SSR ReadableStream with
  its own backpressure.
- An in-memory precompressed static cache served as `Response(buffer)`, with
  weak ETag/304 conditional requests, RFC 7233 single-range requests (206/416,
  If-Range validation), trailing-slash-308 canonicalization for prerendered
  pages, and per-file br/gz variant selection. Files above
  `staticCacheMaxFileSize` (default 4 MiB) are served from disk via `Bun.file()`
  (kernel sendfile), with ranged reads and the same variant negotiation.
- A distinct ETag per content-coding (`W/"x"` for identity, `W/"x-br"`,
  `W/"x-gzip"`). Encoded responses do not advertise `accept-ranges`, ranges are
  served from the identity representation only, and `If-Range` is matched
  against the identity validator - so a download resumed against a compressed
  representation falls back to a full response instead of splicing identity
  bytes at offsets computed against compressed ones.
- SSR request deduplication (leader/waiter coalescing for concurrent anonymous
  GET/HEAD), a BREACH-aware credentialed-compression gate (opt-in via
  `compressCredentialedResponses`), whole-body brotli/gzip compression, and a
  default `x-content-type-options: nosniff` fill.
- Streaming responses forwarded as they are produced. A body is buffered - for
  compression, and for sharing with dedup waiters - only while it keeps
  producing without waiting, so an already-rendered page still takes the
  compressed path while a streaming one (SvelteKit deferred data, an event
  stream, any route that emits a shell and then awaits) reaches the client
  immediately. Bodies that stream are never shared with dedup waiters.
- Liveness (`healthCheckPath`, default `/healthz`) and readiness
  (`readinessCheckPath`, default `/readyz`) routes; readiness reports 503 once
  graceful shutdown begins. Graceful drain via `server.stop()`: readiness-drain
  window (`SHUTDOWN_DELAY_MS`), in-flight completion raced against
  `SHUTDOWN_TIMEOUT`, hard-close, explicit exit.

#### Realtime

- JSON realtime over real WebSockets: an upgrade path, a per-connection
  platform, and topic pub/sub. Zero-config - a `src/ws-handler.js` in the
  project turns the surface on, and its absence leaves the adapter with no
  upgrade lane, no `websocket` option on `Bun.serve`, and no per-connection
  bookkeeping. Hooks: `upgrade` (may await freely; return a `Response` to reject
  the handshake, `false` to reject with 401, any other object becomes userData;
  handshake headers for the 101 are set on the hook's context), `open`,
  `message`, `drain`, `close`, `unsubscribe`, `init`, `shutdown`, and
  `subscribe` / `subscribeBatch` as the authorization gate for every client
  subscribe.
- Platform members: `publish`, `send`, `sendTo`, `subscribe`, `checkSubscribe`,
  `unsubscribe`, `adviseReconnect`, `connections`, `subscribers`,
  `forEachSubscriber`, `maxPayloadLength`, `bufferedAmount`, `closedWsAborts`,
  `totalSubscriptions`, `publishCount`, `topic`, `requestId`, and the
  `now`/`monotonic`/`random` determinism seams. The binary-wire and pressure
  members are ABSENT rather than stubbed, so nothing reports success while doing
  nothing.
- The SSR request path carries the same platform (a prototype-linked clone per
  request), so a load function or form action can publish to connected clients
  without holding a socket.
- A throw-on-closed socket facade over Bun's `ServerWebSocket`. Bun throws on
  nothing - a closed socket's `subscribe()` returns `true`, `send()` returns 0,
  `getBufferedAmount()` returns 0 - so a consumer that catches a closed-socket
  throw to roll back would otherwise see a silent success. The facade also keeps
  one identity-stable wrapper per connection, which the live-connection registry
  and echo-suppression comparisons depend on.
- A send-result shim mapping Bun's `>0` / `-1` / `0` onto the tri-state the
  platform keys on (1 sent, 0 enqueued behind backpressure, 2 dropped). The
  closed-socket check runs BEFORE the mapping, because Bun's `0` is ambiguous
  between "past the backpressure limit" and "socket closed" while those two have
  different consequences: the first poisons this connection's wire state, the
  second must not.
- Subscribing requires an explicit decision. With no gate hook exported,
  subscriptions are denied with `SUBSCRIBE_NOT_CONFIGURED` and a message naming
  every fix, rather than letting any client that can name a topic read it. Set
  `websocket: { allowUnauthenticatedSubscribe: true }` when every topic really
  is public.
- Per-connection bounds, each a separate job: `maxSubscriptionsPerConnection`
  (what can install), `maxConcurrentSubscribeGates` (concurrent app work in the
  subscribe gate), `maxConcurrentUnsubscribeHooks` with
  `maxQueuedUnsubscribeHooks` (the same for the unsubscribe hook, which may be
  deferred but never dropped), and `maxControlEgressBytes` (the ack channel, in
  bytes per 10 s). All are per connection, so connection limiting still belongs
  upstream.
- `websocketPath` (default `/ws`), `websocketHandler` (default
  `src/ws-handler.js`), and a `websocket` transport-options object using the
  family's uWS-shaped names, renamed to Bun's spelling at boot.
  `allowedOrigins` defaults to `'same-origin'` as a cross-site WebSocket
  hijacking defense; a missing `Origin` header is allowed, since the header is
  only trustworthy when a browser set it.

#### Configuration and tooling

- Env surface: `HOST`, `PORT`, `ORIGIN`, `PROTOCOL_HEADER`, `HOST_HEADER`,
  `PORT_HEADER`, `ADDRESS_HEADER`, `XFF_DEPTH`, `TRUSTED_PROXIES`,
  `BODY_SIZE_LIMIT` (also wired to Bun's `maxRequestBodySize`; `0` disables the
  cap, matching adapter-node), `SHUTDOWN_TIMEOUT`, `SHUTDOWN_DELAY_MS`,
  `SHUTDOWN_RECONNECT_WINDOW_MS`, `SSL_CERT`/`SSL_KEY`, with optional
  `envPrefix`.
- Adapter options: `out`, `precompress`, `envPrefix`, `healthCheckPath`,
  `readinessCheckPath`, `staticHeaders` (reserved keys stripped loudly),
  `staticCacheMaxFileSize`, `compressCredentialedResponses`.
- Build-time validation rather than a boot-time crash: an `idleTimeout` above
  Bun's hard 960-second ceiling fails the build with an error naming
  svelte-adapter-uws as the likely source of the value, a numeric uWS compressor
  constant translates to on/off with a warning that the specific tuning could
  not be carried across, and a WebSocket-handler import that cannot be resolved
  fails the build instead of being externalized into output that crashes at
  boot.
- A test fixture app (`test/fixture`, adapter-switchable via `ADAPTER`), a
  `node --test` unit suite (`npm test`, requires Node 22+), a Bun server API
  probe (`probe/bun-api-facts.mjs`) with its committed facts report, and
  benchmarks for the HTTP path (`bench/http-bench.mjs`), the static response
  path (`bench/static-headers-micro.mjs`), the control-frame prefix test
  (`bench/control-frame-prefix.mjs`), and the ack channel
  (`bench/control-egress.mjs`). Every amplification figure quoted in this repo
  comes from a run of the last of those.

### Known limitations

- The binary wire members (`publishWire`/`sendWire` and their batch variants,
  the codec registry, cohort split, resume/seq buffers) and the
  pressure/protection surface are not implemented.
- svelte-adapter-uws-extensions binds four platform members without
  feature-detecting them (`sendCoalesced`, `request`, `onPressure`,
  `onPublishRate`), so `bus.wrap(platform)` throws against this adapter and
  multi-node fan-out through that package does not work yet.
- The WebSocket wire contract is exercised by a live smoke suite that is not
  yet part of `npm test`; only the pure decision modules are covered there.
