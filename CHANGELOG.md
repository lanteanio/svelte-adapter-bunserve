# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `SmoothDrainError` exposes committed updates, acknowledgements and events when
  an authority callback fails, preserving its exact cause and bounded retries
  without replaying output already returned.

- Native testing servers share delivery authorization, operation ordering and
  tracing with production; response bridges preserve exact header bytes.

- `platform.authorizeDelivery` checks recipient access before application writes,
  preserves pending-frame order, and includes held deliveries in pressure and
  graceful shutdown. Native fan-out remains available without a policy.

- `createTestServer({ host })` binds an explicit address and advertises it in
  HTTP and WebSocket URLs. The `sim` entry exports shared leak-lane thresholds
  and verdict helpers with matching declarations.

- Observability exports metric source profiles with explicit drop coverage. Snapshots
  require every supported measurement and omit unavailable transport sources.
- Upgrade metrics count active attempts with or without admission limits and
  report pacing queue depth and oldest age from the live controller.

- Redis cross-process topic fan-out supports the guarded bus published in
  `svelte-adapter-uws-extensions@0.6.0-next.64`.

- The Vite plugin runs a development WebSocket server with the adapter endpoint
  paths, authentication, dashboard and delivery authorization.

- Added `bodyLimits` route rules for native SSR, authentication, and admin uploads,
  with matching declared/chunked budgets, bounded streaming reads, and 413
  enforcement even when application code catches the body error.


- Production publish grants and the game ingress lane support sender-excluding
  fan-out. Unsubscribe and tracked unsubscribe clear matching grants.
- `publishBatched` delivers compatible events in shared native topic frames and
  falls back to per-event publication for mixed memberships or capabilities.

- `svelte-adapter-bunserve/vite` builds the configured `handler` in the application
  SSR graph, sharing server module instances with routes.

- `./platform-contract` exports a generated, frozen public Platform member
  inventory and its exact TypeScript name union for wrappers and mocks.
  Contextual fields are included; absent runtime capabilities remain absent.

- Bun 1.4 `memoryPressure` notifications coalesce into a cgroup discovery
  refresh on the next regular pressure tick. Warning and critical notifications
  share this hint, without an extra timer, sample or invented pressure level.
  Sampler shutdown removes the listener; controlled environments never install a host listener. Runtimes without events keep normal sampling.

- Public `testing`, `sim`, `safe-url` and `observability` entries include
  declarations, native Bun test-server support and deterministic simulation helpers.
- Server and client plugin entries cover replay, presence, channels, cursors,
  groups, throttling, rate limits, middleware, queues, locks, sessions, deduplication,
  CRDT documents, smoothing and webhooks.
- Smoothing authority accepts `maxCommandsPerTick`: a positive safe integer
  bounds each entity's drain, retains its ordered tail and acknowledges only
  the applied prefix. Omitted limits drain fully; `inject()` stays unpaced.
- Client smoothing applies `snapSpeedPerSec` to local authoritative placements.
  Automatic detection needs two measured command intervals; an explicit numeric
  ceiling applies at cold start. `0` disables speed checks, and snaps preserve
  unacknowledged command replay.

- `CANONICAL_HOST_ALIASES` redirects listed host authorities to `ORIGIN`, with
  exact port matching and configured proxy-header support.

- `./plugins/replay/client` provides the replay-aware `onReplay` topic store.

- `staticCacheControl` assigns path-specific cache policies to static and
  prerendered files and retains the selected policy on revalidation.

- `sendCoalesced` normalizes non-Error serialization failures to
  TypeError and preserves native Error identity. Queued failures stay contained;
  reentrant drains preserve newer values and yield bounded work to the event loop.

- `connection.sendSerialized(text)` sends complete JSON text unchanged and returns
  local socket admission without retaining disconnected messages.

- `releaseSubscription(ws, topic)` releases a failed setup's admitted membership,
  derived subscriptions, publish grant and shared cohorts without cancelling
  independent pending authorization. It is available from `./subscriptions`.

- `svelte-adapter-bunserve/client` provides the family WebSocket client, with
  authentication preflight, bounded connection attempts, reconnect backoff,
  subscriptions, binary codecs and temporary offline simulation. The entry
  includes TypeScript declarations and is safe to import during SSR.

- Live authentication checks accept `X-Requested-With: XMLHttpRequest`
  and refuse the former `svelte-adapter-uws` header when origin evidence is
  absent.

- `svelte-adapter-bunserve/connection` exports `attribution(ws)` and
  `connectionSessionId(ws)` through the shared connection slots. Attribution
  remains the frozen value established before the application's `open` hook.

- Root TypeScript declarations cover adapter options, WebSocket hooks and the
  implemented `Platform` surface.

- Metric declarations carry worker/process scope and sum/max/min aggregation
  rules used by snapshot merging. Source profiles determine the required
  instruments while preserving missing-sample completeness checks.

- `request-n` accepts the client's advisory `queued` backlog, divides it by the
  fixed queue ceiling of 256, and clamps the ratio to 0 to 1. The sampler folds
  the retained worker peak into `pressure.value` and halves it each sample.
  It does not change the pressure reason or grant decision.

- Refreshed the control-egress benchmark for per-entry batch overflow replies.
  A near-8-KiB numeric-ref frame measured 21.6x amplification; a maximal ref
  measured about 60x. Sustained overflow traffic reached the 4 MiB ceiling
  and closed with 4429. Documentation no longer claims a 256-reply bound.

- A live HTTP/1.1 pipelining check against the built server: synchronous probe
  requests complete twice, while a delayed response followed by another request
  closes without returning a partial or reordered response on Bun 1.3.14.

- The leak lane now runs the family's held-socket topic workload as `ws`
  (four connections, 200 operations/s), with connection turnover in a separate
  `churn` scenario paced from fixture upgrade limits. Denied subscriptions
  fail a workload unit, and an unreadable final connection count fails lane
  health. Live checks exercise confirmed cycles and complete cleanup.

- Extra server entries, as svelte-adapter-uws builds them: a file a Vite
  plugin writes into the SvelteKit server output under a name starting with
  `__` and ending in `.js` - svelte-realtime's generated `__live-registry` is
  one - is bundled as its own entry and imported at the top of the built
  `index.js`, in file-name order, before the WebSocket handler loads. Each is
  imported by the file name Rollup wrote for it, found by real path, with a
  JSON-quoted specifier, so a name with an apostrophe, `#` or `%` loads too,
  also in a project reached through a symlink. Until now the build left such
  files out, and the code in them never ran.

- `svelte-adapter-bunserve/subscriptions`, the entry svelte-adapter-uws
  declares: `trackedSubscribe(ws, topic)` and `trackedUnsubscribe(ws, topic)`,
  accounted topic membership for code that joins or leaves a connection's
  topics outside the wire protocol - a presence join, a snapshot handshake, a
  plugin in another package. Native membership, the connection's subscription
  set, the per-connection cap, a shared-codec topic's cohort and the
  subscription total move together; a bare `ws.subscribe` leaves the total
  and the subscriber walk behind. `trackedUnsubscribe` also cancels a
  subscribe for the same topic still waiting on its authorization hook. Every
  slot they touch is a registered symbol or a global hook under
  svelte-adapter-uws's names, so that adapter's own copy of these helpers,
  carried by a plugin, moves this runtime's state the same way: the taps such
  a plugin derives from a topic are released when the topic is revoked, and
  the unwind of its observer lane runs the app's `unsubscribe` hook. The entry
  ships its type declarations alongside the adapter's root declarations. A
  second adapter runtime in one worker that takes over the subscription
  accounting sink is reported as a
  `runtime.subscription-accounting.sink-displaced` diagnostic line. Timed
  against the tree before these subscription changes with
  `bench/subscription-churn-ab.mjs` on Bun 1.3.14, a `platform.subscribe`
  and `platform.unsubscribe` pair costs about 5% more, some 30 ns of 650: the
  shared accounting sink and its settled-registry check, the in-flight
  record's running total and authority flag, and the derived-tap release. The
  same pair as client frames is within about 1%.

- `platform.assertions`, the per-category count of framework invariant
  violations svelte-adapter-uws declares, and the checks that feed it: about
  twenty sites across the realtime tier, with svelte-adapter-uws's categories
  and tiers. A violation is counted, published as
  `framework_assertion_violations_total{category,severity}`, and logged as one
  `[lantean/diagnostic ... component=runtime.assertion event=invariant.violated]`
  line; in production the check itself never throws. The fatal ones - a
  second `open` on one connection, a socket admitted without its connection
  permit, a message on a connection with no platform, a subscribe onto a broken
  subscription set, an empty publish envelope - also exit the process with
  code 78 on the next microtask. Under `NODE_ENV=test`, or with `VITEST` set,
  every violation throws. On every build, WebSocket handler or not. Timed
  against the tree before it with `bench/assertion-guards-micro.mjs` on Bun
  1.3.14, an application frame, `send` and `publish` could not be told apart
  from the run-to-run noise of two identical trees on the same machine; the
  guard call alone costs about 0.2 ns.

- `platform.sendCoalesced(ws, { key, topic, event, data })`, the
  coalesce-by-key send svelte-adapter-uws declares: one pending message per
  connection and key, latest value wins, flushed at once and again on every
  drain ahead of the app's `drain` hook. A value JSON cannot carry throws to
  the caller when it flushes at once; one queued behind backpressure is
  dropped and reported as the `ws.send-coalesced.unserializable` operational
  event with `ADAPTER-ERR-COALESCED-UNSERIALIZABLE`. A topic or
  event name the envelope cannot carry throws at once and is never queued.
  1,000,000 pending keys per connection, the oldest evicted past that.
  What it writes is charged to the close hook's `messagesOut`/`bytesOut`.

- `platform.topicEpoch(topic)` and `platform.bumpTopicEpoch(topic)`, the per-topic
  seq-space generation svelte-adapter-uws declares. The explicit-seq lane is
  single-authority per topic: the max-seen mark is monotone and no seq carries
  the identity of the counter that issued it, so ONE publish stamped from a
  different authority pinned that mark for the life of the process and every
  later resume window deduped against a floor from the wrong sequence space,
  silently. An app that changes a topic's authority now bumps its epoch, and
  the offsets clients recorded under the old one die at their next resume
  through the ordinary epoch-mismatch answer - no protocol change, since the
  field already rides the `subscribed` ack. The override map is bounded at
  4096 and degrades to the process generation.

- `warmup`, the readiness-gated boot warmup svelte-adapter-uws declares:
  render the configured paths once during the `starting` window, after the
  app's init hook and before readiness reports ready, so a load balancer never
  routes the first client into a cold render. `true` (default) warms `/`,
  `false` disables it, `{ paths }` names the routes. Re-measured on this
  runtime before shipping: 16.1-18.0 ms cold against a 0.75-0.92 ms settled
  mean on Bun 1.3.14, 17-24x across runs. Bounded in every direction - a
  per-render abort, a cancelled (never buffered) endless body, and a total
  budget - so a warmup that hangs loses the warmup, never readiness.

- `platform.isWarmupRequest(request)`, so app hooks can tell a synthetic warmup
  render from a real visit and skip its side effects. Tagged by object
  identity, never a header, so a client cannot forge one.

- The readiness probe now reports 503 `starting` between the listener binding
  and the boot warmup finishing. Liveness stays 200 throughout: the process is
  up, it is simply not ready yet. The boot log's listen line says "listening"
  rather than "ready" for the same reason.

- `websocket.authorizeWireSubscribe` and `platform.authorizeWireSubscribe()`,
  the server-grant gate svelte-adapter-uws declares. Armed, a client-initiated
  `subscribe` / `subscribe-batch` is honoured only for a topic the server
  already authorized for that connection through `platform.subscribe`, unless
  the app exports its own `subscribe` / `subscribeBatch` hook, which then
  decides. `'strict'` requires both the grant and a hook allow, and latches for
  the worker lifetime. Off by default. A value that is not `true`, `false` or
  `'strict'` is a build error rather than a silent "off".

  `platform.checkSubscribe(ws, topic, { requireGrant: true })` now reads the
  grant it has always accepted; with the gate unarmed it falls through to the
  app hook as before.

- `options.seq` on `platform.send` and `platform.sendWire`, the gap-fill
  channel a resume hook replays history through. The replayed frames now carry
  the per-frame seqs the client keys its watermark off; before, the only
  primitive a hook had emitted an envelope with no seq field, so a hook could
  honestly report "I delivered up to 22" and leave the client with no seq to
  resume from. Explicit forms only - number or bigint, the publish lanes'
  validation and range; `false`/`null`/absent keep today's byte-identical
  frame, and `true` throws, because this lane has no counter to draw. Both
  lanes stay side-effect-free: no counter advance, no max-seen record, no
  resume capture.

- `bigint` as the second spelling of an explicit publish seq, on the publish
  lanes and per batch entry, held to exactly the same range as the number
  spelling so the two can never disagree about validity.

### Changed

- Raised the supported Bun minimum to 1.4.4. Native incomplete uploads now close
  after an early response; Bun 1.3.14 leaves those connections open even with
  `Connection: close` and cancellation of the native body. CI tests the supported
  minimum with a real TCP close assertion.

- A second SIGTERM or SIGINT aborts active requests and exits with code 1 during
  graceful shutdown or pending startup. The first stop during startup marks
  readiness as draining and waits for initialization before cleanup.

- **BREAKING** Subscription topic names with unpaired UTF-16 surrogates return
  `INVALID_TOPIC` on platform and non-ASCII wire subscriptions. Replace malformed
  names before upgrading. Valid pairs remain accepted within the 256-unit limit.

- Unsubscribe hooks run directly with contained errors. Client releases no
  longer use a separate queue or retain failed teardown as close-hook debt.

- **BREAKING** `platform.unsubscribe` returns true when it cancels pending
  authorization, and invokes the application unsubscribe hook for removed
  memberships. Derived subscriptions are released during bulk revocation.

- **BREAKING** Standalone resume forwards string session IDs and raw object or
  array history maps to the application. It acknowledges after the hook settles,
  including contained failures. Applications validate their history values and
  signal replay truncation or denial through the replay channel.

- Subscribe batches run per-topic authorization concurrently, then recover and
  activate allowed entries in their original order.

- **BREAKING** Socket `publish` returns a boolean instead of a send-status
  number. It reports eligible peers even for empty or backpressured messages.
  A publisher that released all its subscriptions can still deliver to peers.
  A publisher that never subscribed returns `false` without delivering.

- **BREAKING** Broadcast wire methods propagate codec exceptions and reject
  invalid non-null payloads with `TypeError`, matching directed wire methods.
  `Uint8Array` values from other realms are accepted. A failed encode no longer
  poisons the connection or sends JSON in its place; callers handle recovery.
  Deliveries completed before a later encode fails are not rolled back.

- **BREAKING** `sendTo` and reconnect advice include non-throwing dropped attempts
  in their return counts. Direct fan-out charges completed sends to egress. Reconnect advice
  requires a positive whole-millisecond window, filters every target before
  sending, and excludes throwing send or close attempts from its return count.
  Close-hook counters record accepted advice even when the subsequent close fails.

- **BREAKING** Returning a `Response` from `upgrade` no longer sends that
  response as a handshake refusal. Return `false` to refuse with 401, or move
  custom HTTP refusals into `authenticate`. Successful upgrades return userData
  or an `upgradeResponse(userData, headers)` wrapper.

- **BREAKING** Static and SSR encoding negotiation honors quality weights and
  wildcard preferences: `*` can now select brotli, and `br;q=0` refuses it.
  Send `identity` when no compression is wanted. A zero-length suffix range
  (`bytes=-0`) now returns 416; omit the Range header to request the full file.
- **BREAKING** SSR HEAD cancels the response body without reading or compressing
  it. It retains only an explicitly declared `Content-Length`; set that header
  in the route when clients need a size, or use GET to obtain the body length.

- **BREAKING** Static conditional requests use weak `If-None-Match`
  comparison, matching svelte-adapter-uws. `If-Match` accepts any issued
  representation's tag. A 304 retains response policy headers except
  `Content-Type`, `Content-Encoding` and `Content-Disposition`. Date conditions accept only
  valid HTTP dates, including the rolling fifty-year rule for obsolete years.
  Files with future or pre-1900 timestamps omit Last-Modified and ignore date
  conditions while retaining ETag validation.

- **BREAKING** The upgrade hook receives one event containing request headers,
  cookies, relative URL and client identity. Return
  `upgradeResponse(userData, headers)` from the new `./upgrade-response`
  entry to set handshake headers. Header arrays preserve separate `Set-Cookie`
  values; transport-owned handshake headers remain protected.

- **BREAKING** A missing configured WebSocket handler fails the build instead
  of silently disabling the endpoint. Use `websocket: false` or omit the option
  to disable it. The Vite plugin resolves handler aliases in the server graph
  and records the source path to detect conflicting adapter configuration.
  Fallback TypeScript builds also accept esbuild 0.25 and 0.26.

- **BREAKING** WebSockets require `websocket: true` or an options object.
  Automatic handler discovery uses `src/hooks.ws.js`, `.ts`, then `.mjs`. Rename
  `src/ws-handler.js` or configure it explicitly; omitting `websocket` or setting
  it to `false` disables the endpoint and handler discovery.

- **BREAKING** Successful unsubscribe frames no longer emit `unsubscribed`,
  including requests carrying a `ref`. Clients needing confirmation should use
  an application message. All string topics are released silently without
  `unsubscribe-denied`, including invalid or system-topic spellings.

- **BREAKING** Standalone resume calls no longer have a separate concurrency
  refusal. Permanent grant denials return `FORBIDDEN` before pending
  attempt pressure can return `RATE_LIMITED`. Batch admission counts valid
  topics in input order, including permanent grant denials; landed membership
  limits are checked after authorization hooks settle.

- **BREAKING** Server subscription APIs authorize system topics through the
  application hook. `platform.subscribe` takes only `(ws, topic)`; remove the
  former `allowSystemTopic` escape. Observer checks with `requireGrant` use the
  configured wire topic alphabet; ordinary server checks permit non-ASCII topics.

- **BREAKING** `sendWire` propagates codec exceptions and rejects invalid
  payload types before announcing a wire id. A failed encode does not poison
  the connection or send a JSON fallback; the application handles the error.

- **BREAKING** `sendWireBatch` sends JSON for stateless codecs, propagates codec
  exceptions, and reads each entry payload once. Both batch and per-entry codec
  results accept `Uint8Array` values from another JavaScript realm.

- **BREAKING** `SHUTDOWN_TIMEOUT=0` waits without a deadline. Set a small
  positive value for a near-immediate shutdown cutoff.

- **BREAKING** Subscribe batches apply the first 256 entries and answer
  additional string entries with `BATCH_OVERFLOW`. The whole-batch
  `BATCH_TOO_LARGE` error is no longer emitted.

- **BREAKING** Subscriptions without an application hook follow the public-topic
  default. Server subscribe calls on closed sockets resolve `null`. Use
  wire-subscribe authorization or an application hook to restrict private topics.

- A request target that carries a `#` is refused with `400` on every lane - the
  probes, the built assets, prerendered pages, SSR, the auth path and the
  WebSocket handshake - as on svelte-adapter-uws and as RFC 9112 asks. Bun read
  the rest as a fragment, so `/healthz#frag` was answered as the probe. A
  handshake whose query carries one counts as
  `upgrade_rejected_total{reason="malformed_handshake"}`; one whose path carries
  one is refused like any other request. Bun builds the request URL from the
  `Host` value as well, so a `#` there is refused with it, where
  svelte-adapter-uws reads the Host only on the lanes that build a URL from it
  and answers the probes and built assets regardless. svelte-adapter-uws also
  refuses a raw byte outside visible ASCII in the target. Bun answers a space or a byte below
  `0x20` with its own `505` before the adapter runs, hands DEL on as `%7F`, and
  hands every byte from `0x80` up on decoded as UTF-8 and escaped again, one
  that is not part of UTF-8 as `%EF%BF%BD`, so such a target is served as that
  escaped spelling would be. The check is one scan of `req.url`, about 10 ns
  against the roughly 470 ns every request already spends parsing it (Bun
  1.3.14).

- **BREAKING** A WebSocket handshake no client could complete is refused before
  the capacity gate, the origin check and the app's `upgrade` hook, as on
  svelte-adapter-uws: `400` unless there is one `Upgrade: websocket` line, a
  `Connection` that lists `upgrade`, one key that is the base64 of 16 bytes and
  at most one version line, and `426` with `Sec-WebSocket-Version: 13` for any
  version but 13, absent included. Bun accepted most of these itself, so a
  handshake without `Connection: upgrade`, with a key that is not base64, with
  its key or version line repeated or asking for version 8 used to open a
  socket. A GET on the path that carries a
  key or `Upgrade: websocket` is a handshake for this rule. Each refusal is
  counted as `upgrade_rejected_total{reason="malformed_handshake"}`, a new
  series. Letter case is ignored, and only spaces and tabs are trimmed. Bun
  joins a repeated header line into one value, so one line that lists several
  values reads as several lines: a single `Sec-WebSocket-Version: 13, 8` line
  is refused `400` where svelte-adapter-uws answers `426`, and a single
  `Upgrade: websocket, h2c` line with no key is refused `400` where
  svelte-adapter-uws treats it as a request that is not a handshake.

- **BREAKING** A request on the WebSocket path that is not a GET handshake goes
  on to the app's routes, as on svelte-adapter-uws: a HEAD, a POST or any other
  method always, and a GET that is not a handshake - a plain one, or one
  asking to upgrade to another protocol - when no `upgradeAdmission` limit
  (`maxConcurrent`, `maxConnections` or `perTickBudget`) is configured. Such a
  request used to be answered `426`, or, when it carried
  `Upgrade: websocket` with another method, taken through the upgrade path and
  the app's `upgrade` hook and refused `400` at the end; the hook no longer
  runs for it. Under a limit a GET that is not a handshake is still the
  adapter's: `426` with the body `WebSocket upgrade required` while there is
  room, and at capacity the shed upgrade's `503` with `retry-after`, or, for a
  browser that asks for `text/html`, the short accessible page
  svelte-adapter-uws serves with `waitingRoom: false`. The `426` no longer
  carries `Upgrade` and `Connection` headers.

- **BREAKING** A subscribe a revocation cancelled while its authorization hook
  was awaited is answered `FORBIDDEN`, as on svelte-adapter-uws: in its
  `subscribe-denied` frame and as the result of `platform.subscribe`. It was
  `CANCELLED`, a reason that adapter never sends, so an app or client keyed on
  svelte-adapter-uws's reasons read a revoke here as something else.

- The per-connection subscription cap is 65,536, svelte-adapter-uws's figure,
  where it was 10,000. A copy of that adapter's `trackedSubscribe` checks its
  own constant, and a plugin carrying it could grow a connection here past
  10,000, after which every lane of this runtime refused every new topic.
  Measured on Bun 1.3.14, a native subscription holds about 530 bytes
  resident, so a connection at the cap holds about 33 MB.

- A connection's subscription slots - its topic Set, its in-flight subscribe
  record and that record's total, and its platform - are keyed by
  svelte-adapter-uws's registered names now (`adapter-uws.ws.subscriptions`,
  `adapter-uws.ws.pending-subscribes`, `adapter-uws.ws.pending-subscribes-total`
  and `adapter-uws.ws.platform`, each through `Symbol.for`), so a copy of the
  subscription helpers another package carries reaches the same connection
  state. The in-flight record has that adapter's layout too. The slots are
  declared as own properties when the connection opens, so an accessor on
  `Object.prototype` for one of those names cannot take the runtime's writes.

- **BREAKING** A drained connection is closed with 1001, the code the family
  protocol puts after a `reconnect` advisory, where it got 1012: at shutdown
  with the reason `Server shutting down`, after `platform.adviseReconnect`
  with `Server draining`, as on svelte-adapter-uws. Bun puts 1001 on the
  wire intact; Bun's own WebSocket client reports it as 1000, a client-side
  reading the family client treats as a retry like 1001 and 1012. A
  shutdown with the advisory on now advises every connection first and then
  closes them all the same way.

- **BREAKING** An `open`, `message` or `drain` hook that throws, or returns a
  promise that rejects, closes its connection with 1011 and the reason
  `Open handler error`, `Message handler error` or `Drain handler error`, as
  svelte-adapter-uws does; the connection used to be left open. A failing
  `close` hook is only logged. The line printed is the family's,
  `[ws] the open hook threw [ADAPTER-ERR-OPEN-HOOK]` and its siblings, once
  per failure rather than throttled, since each failure costs a connection.
  A falsy `open` or `drain` export is skipped; one set to anything else that
  is not a function fails like a throwing hook, for every connection, as
  does a non-function `close` export other than `null` or `undefined`. A
  `message` export that is not a function is ignored.

- **BREAKING** `ws.end(code, reason)` follows the close rule
  svelte-adapter-uws applies: a code outside 1000-1003, 1007-1014 and
  3000-4999 throws a `TypeError` and leaves the connection open, as does a
  reason without a code or one that is neither text nor UTF-8 bytes. Such a
  code used to be replaced by 1000 with a one-time warning, and a lone reason
  carried on 1000. A reason in bytes now goes out as the text it encodes
  (Bun alone writes a byte array's decimal digits), a reason over 123 UTF-8
  bytes is still cut at a character boundary, and `ws.end()` with no code
  sends a close frame with no status, which the client reads as 1005, where
  it sent 1000.

- **BREAKING** `ws.close()` always drops the connection with no close frame
  and ignores any arguments, as on uWS; `ws.close(code, reason)` used to be
  honoured as a graceful close with a one-time warning. The graceful close
  is `ws.end(code, reason)`.

- **BREAKING** `ws.end()` and `ws.close()` on a connection that has already
  closed throw a `WsClosedError`, as `send` and `subscribe` do there and as
  uWS does; they were silent no-ops. With no code, `ws.end()` reports 0 to
  the server's own `close` hook, as uWS does, while the client reads 1005.

- **BREAKING** A connection that spends its control-frame budget is closed
  4429 with nothing written before the close. The
  `{"type":"error","code":"CONTROL_FLOOD","limit":B}` frame that preceded it
  is gone: the family protocol defines 4429 as a close with no `error` frame
  before it, and the family clients already treat 4429 as throttling and
  reconnect on the accelerated curve. The server logs the connection's
  request id instead, throttled.

- **BREAKING** A close hook's `bytesOut` counts a text frame in UTF-16 code
  units, its JavaScript `length`, and a binary frame in bytes: the unit
  svelte-adapter-uws reports. It was an exact UTF-8 count, which walked every
  text frame on every directed send: `bench/bytes-out-micro.mjs` times that
  count at 15 to 27 ns a frame under Bun 1.3.14, run to run, against 3 to 4
  ns for `length`. ASCII text reads the same as before; non-ASCII text reads low, so
  treat text `bytesOut` as a lower bound on the UTF-8 bytes sent. `bytesIn`
  stays an exact byte count.

- **BREAKING** `publishWire` and `publishWireBatch` no longer charge a live
  topic broadcast to each subscriber's `messagesOut` and `bytesOut`. A plain
  `publish` was already uncounted, and the codec lanes, which walk
  subscribers themselves, counted every frame, so the same app read
  different figures depending on the lane and on the adapter serving it.
  What `publish`, `publishWire` and `publishWireBatch` can still charge, on
  both adapters: the wire-id announce a walk sends, which is a control frame,
  and the envelope
  held for a connection whose resume is in progress, charged when the replay
  sends it.

- The flow-control window narrows along a ramp as memory fills, not in one
  step: past a `heap_used_ratio` of 0.7 it fell from the full 256 requests to
  under a third at once, and it now ramps down, reaching half at the default
  0.85 MEMORY threshold and a twentieth near the wall. Below 0.7 every window
  is the full base, as before, and no window is smaller than it was.

- Send-gate windows now narrow as the worker approaches a memory wall. The
  sizer has always had a heap term, and this adapter passed it a constant
  zero: the only reading available was arena fullness, which JavaScriptCore
  keeps fitted to usage, so an idle server measured 0.90 to 0.94 and feeding
  it would have collapsed the window on a server under no load. The reading
  is now distance to the nearest memory wall, so the sizer's 0.7 knee is
  crossed by a worker actually approaching an out-of-memory death. One
  reading now feeds all four consumers the family contract names - the
  `MEMORY` reason, the saturation fold, the `heap_used_ratio` gauge and the
  send-gate window - so none is calibrated against a different basis.

  Where no memory wall is discoverable this changes nothing. Bun reports no
  allocation ceiling, so the container arm carries the reading alone, and an
  uncontained process has no wall to measure a distance to: the reading is
  0, the memory term is inert, and subscriber load sizes the window by
  itself exactly as before. The narrowing is what a memory-limited container
  gets. It is the sampler's cached value, never a live
  `process.memoryUsage()`, so the replenish path pays no syscall and a
  window's memory reading is at most one sample interval old; grant sizes
  stay deterministic under the simulator, which runs no sampler and reads
  the zero the cache starts at.

- The leak lane (`npm run test:leak`) now gates the way svelte-adapter-uws's
  lane gates, so a record from either runtime reads the same. The verdict is
  that lane's: resident-set growth through the shared `detectGrowth` kernel
  (16 MiB tolerance, 256 KiB/sample slope floor, an r-squared vote at 0.5,
  monotonic vote off), an error-rate ceiling of 0.5%, and a p95-creep ceiling
  of 50%; the rules are pure and unit-tested in milliseconds. The measurement
  shape is that lane's too: a sixty-second warmup, a forced-collection
  baseline, a worked-but-unsampled resettle, a settle loop that opens the
  window only once the reading has held inside a band for eight rounds, and
  the window sampled every two seconds. The flags are `--minutes` (1 to 60,
  default 3), `--scenario http|ws|churn|selfcheck|all` and `--out <dir>`, replacing
  the `LEAK_*` environment knobs; the phase timings are calibration constants
  in the plan. The fixture's probe is `/__leak?op=mem|gc|retain|release`,
  armed by `LEAK_PROBE` alone, and the self-check plants its leak through
  `op=retain` over HTTP once a clean server has settled, so `LEAK_INJECT` and
  the retained array in the fixture's WebSocket handler are gone. A JSON
  record with every sample and settle reading is written after every
  scenario, to a gitignored `test/leak/records/` by default, and CI uploads
  it. Exit codes are 0 clean, 1 the server's problem, 2 the lane could not
  reach a verdict it trusts - a bad flag, a failed build, a killed gate, a
  window that never settled - and a server that dies mid-run is a 1 with
  the samples it produced, not a 2. HTTP traffic is held to four keepalive
  connections, as the uws lane holds it. The `ws` scenario stays a
  connection churn (open, subscribe, close, fifty a second), which is what
  the connections gate reads; the uws `ws` scenario holds four sockets and
  churns topics, so the two are compared by verdict rather than by series.

  Two gates stay on top of the family's three, because this runtime's
  resident set is a weak signal over a short window and both were found by
  measurement here: settled retention (heap plus external, forced collections
  until two agree, at both ends of the run; fails past both a 30% ratio and
  a 2 MiB floor, because the ws churn retains the same 1.1 MiB over nine
  thousand connections as over twenty-four thousand - a bounded structure
  filling, not a leak - and a ratio alone would call that a leak on a
  smaller idle heap) and WebSocket connections still registered after every
  client closed. Neither satisfies the self-check, which counts only the
  family's growth gate as detection. The health floor is eight samples,
  the kernel's own, where the uws rules hold it at two. The README's
  calibration table records what a healthy run measures on Bun under each
  rule.

- **BREAKING** The memory-pressure signal is now distance to the nearest memory
  WALL, the family basis, and `memoryHeapUsedRatio` defaults to the family's
  `0.85` instead of being disabled. The old sample was arena fullness
  (`heapUsed / heapTotal`), which JavaScriptCore keeps fitted close to usage -
  an idle server read 0.90-0.94 and the ratio FELL as the arena grew - so the
  signal had to be off here to avoid firing on a sleeping process, and it could
  never see the death that actually happens: the OOM killer charges the whole
  resident set against the cgroup limit. The sample is now the worst of two
  walls, each measured with the quantity its wall kills on. JavaScriptCore
  reports no allocation ceiling, so the container arm carries the reading; a
  process with no discoverable wall has no memory-wall measurement and contributes zero to pressure.
  The container wall is the tightest memory limit that applies to the process
  across its cgroup and its ancestors, re-read every sample, so a limit
  raised, lowered or set on a running service is followed; which cgroup the
  process is in is re-read about once a minute, and at once when a group it
  was reading goes away. A limit file that fails to read for any reason other
  than being gone - an LSM policy change, descriptor or memory exhaustion -
  stands at the value it was last read at rather than dropping out, since a
  read is most likely to fail under the memory event the signal reports. An
  app that set `memoryHeapUsedRatio` explicitly is unaffected in spelling, but
  the number now means something different - re-read it against the wall
  basis rather than carrying the old value over. The `heap_used_ratio` gauge
  publishes the same reading with the family's help text: the pressure
  sampler's, absent until its first tick like the other sampled gauges, or on
  a build with no WebSocket tier a reading the scrape takes itself, at most
  once a second. It used to report arena fullness, so a dashboard or alert on
  it changes meaning too; with no wall the gauge is absent and the pressure contribution is zero.

- **BREAKING** A `null` per-entry `excludeWs` on `publishWireBatch` now
  INHERITS the call-level exclusion instead of opting that entry back in. The
  call-level exclusion is the default for every entry, and an entry overrides
  it only by naming a socket - which is what `excludeWs: null` means everywhere
  else in the family.

- **BREAKING** A per-entry `seq` on `publishWireBatch` is now an OVERRIDE in
  every form but absent, matching the batch option's own table: a number or
  bigint is that entry's explicit authority, `true` draws the counter for it
  alone, and `false` or `null` publish it seq-less. Previously `null` inherited
  the batch option and `true`/`false` were refused, so a nullable authority
  column reading null had the batch's counter stamped on that row - a value
  from another sequence space, where the column said there was none.

- **BREAKING** An explicit publish seq is now held to the safe-integer range
  (at most `9007199254740991`); a positive integer above it throws a
  `TypeError` naming the range instead of being stamped. The seq space is
  IEEE-754 double everywhere but the varint, so above 2^53 two ids a caller
  means to be different land on one value - and because watermarks advance on
  a strict greater-than, the second frame never advances the client's and
  resume dedup goes ambiguous with nothing on the wire to notice by. Snowflake
  ids and large log offsets are the affected callers: keep the wide id in the
  event data and give `seq` an authority inside the range, or offset it by a
  per-topic base.

- The vendored `protocol.schema.json` and the uws surface manifest are re-pinned
  to svelte-adapter-uws 0.6.0-next.95. The schema now carries the family's
  wording for the `epoch` field: an opaque per-process generation token,
  compared for equality only and never a timestamp.

- **BREAKING** Publish-family `seq` options reject strings, objects and other
  invalid values with `TypeError` instead of substituting a local counter.
  Numbers and bigints express positive safe-integer authority; `true` draws a
  local counter, while `false` and `null` omit the seq. In `publishWireBatch`,
  each supplied entry seq overrides the batch option, including `null` and
  `false`; only `undefined` inherits. Explicit authority belongs on individual
  entries, so a number or bigint at the batch option level is refused.

### Removed

- **BREAKING** The extra `ws_closed_socket_aborts_total` scrape metric is removed.
  Closed-socket aborts remain available in the runtime's `closedWsAborts` counter.

- **BREAKING** `websocket.allowUnauthenticatedSubscribe`. svelte-adapter-uws
  does not declare it, so an app that set it could not carry its config to the
  adapter this one mirrors. It said "every topic here is public"; say that with
  a `subscribe` hook that returns `null`, or let the server decide membership
  and arm `websocket.authorizeWireSubscribe` instead. The no-gate error message
  names both. A build that still passes the key warns about an unknown option
  rather than failing.

- **BREAKING** Five option keys svelte-adapter-uws does not declare:
  `websocket.publishToSelf`, `websocket.maxSubscriptionsPerConnection`,
  `websocket.maxConcurrentSubscribeGates`,
  `websocket.maxControlEgressBytes` and
  the top-level `staticCacheMaxFileSize`. Subscription admission uses the
  65,536 landed-membership and 4096 pending-attempt limits; there is no separate
  subscribe-gate concurrency ceiling. Control egress and static-cache limits
  remain fixed constants. `publishToSelf` is pinned to `false`, which makes a
  connection-level publish exclude its own socket the way uWS does. A build
  that still passes one of these keys warns about an unknown option rather than
  failing.

- **BREAKING** `platform.totalSubscriptions`, `platform.publishCount` and
  `platform.droppedReleaseRecords`. svelte-adapter-uws declares none of them:
  its platform carries `metrics` and `metricsSnapshot()` and reports counters
  through the registry, so an app reading these three here could not move back
  to the adapter this one mirrors. The counters themselves are unchanged - the
  first two are the `ws_subscriptions` and `ws_publishes_total` metrics, and a
  dropped release record still logs once per process.

### Fixed

- Duplicate CRDT updates and already-held resync snapshots skip fan-out and
  persistence. Pending inserts, deletes and formatted-text changes still relay
  and persist before their dependencies or cleanup transactions finish.

- HEAD responses preserve declared lengths without reading the application body
  and keep unknown lengths out of Content-Length on Bun 1.4.4.

- Flat SvelteKit builder configuration retains base paths and manifest app paths.
- Hashed client assets keep immutable cache headers under a configured base path.
- Malformed Host values are refused before upgrade and probe routing.
- An explicit null trace context clears inherited context across async work.

- Wire unsubscribe removes native topic memberships created directly through
  the socket, clears matching publish grants, and runs teardown without sending
  acknowledgement frames. Empty topics remain harmless on Bun.

- Module request handlers, one-shot listeners and outstanding replay requests
  follow explicit connection replacements. Plugin helpers keep permanently
  closed clients offline.
- Smoothing authority commits acknowledgements and command metadata only after
  successful state application and discards scratch events after a failed command.
- Configured metrics retain the operator registry identity and share its module
  with application routes through the Vite plugin. Canonical snapshots exclude
  application instruments and check local-worker completeness. Invalid instrument
  factories fail during startup; unsampled gauges remain absent.
- The public Platform inventory includes every declared capability.

- Untrusted-proxy warnings include the configured environment prefix, and
  non-string `envPrefix` values throw `TypeError` during adapter configuration.
- Legacy diagnostic parsing recognizes the complete family prefix table,
  including `svelte-adapter-ws` prefixes and component names.

- Connection-capacity pressure uses the smallest enabled handshake or
  live-connection limit. Runtime socket state uses the shared adapter symbol keys.

- Ordinary publications and shared batches validate payloads before advancing
  topic sequences or authoritative recovery marks, including the testing server.

- Webhook delivery deadlines settle on Bun even when request destruction emits
  no error. Validated DNS addresses retain HTTP authority and TLS hostname checks.
- Test-server diagnostics identify Bunserve consistently; testing declarations
  reuse the public runtime version type. Regressions cover Unicode topic
  validation, transport limits, lifecycle hooks and simulation assertions.
- Observability examples use Bunserve scrape labels and describe each server
  instance accurately; safe URL declarations name this package's import paths.

- Successful direct and finite-continuation HTTP responses retain reusable
  native connections. A source error after streaming starts closes the
  connection without a complete chunked terminator on supported Bun runtimes.


- Memory-wall gauges disappear when no engine or cgroup ceiling is known and
  resume when a finite wall returns. Unknown walls contribute zero to pressure;
  unavailable memory-wall readings remove the built-in gauge sample.

- SSR normalizes body chunks before byte accounting and releases pending readers
  on disconnect. One bounded check-phase turn distinguishes finite continuations
  from deferred output. HEAD leaves bodies unpulled, and Bun owns transfer framing
  on SSR and authentication responses.

- Handler discovery warns about a legacy handler when WebSocket options are omitted;
  configured handler aliases resolve through the SvelteKit SSR build.

- The leak runner accepts finite numeric durations from 1 to 60, including
  fractional minutes and exponent notation, and rejects invalid values before
  building. Both flag spellings preserve the first value when an option repeats.

- Recovery offsets remain unchanged until the matching subscription reply. Replay
  truncation clears offsets while retaining epochs and is reported once per request.

- Module client stores and managed ingress follow an explicit connection replacement
  after close; connection-bound stores stay attached to their original connection.

- Server-side subscription cancellation and observer cleanup run every teardown
  directly, including after an authorization hook finishes. They no longer
  close a connection by entering the bounded client unsubscribe queue.

- The metric manifest declares both rendered egress counter families and checks
  that the default scrape contains no undeclared adapter family.

- Topic helpers forward publish options, including sequence, compression and
  jitter, through the live publish wrapper. Nullable trace-context declarations
  preserve the shared shape while this runtime continues to supply `null`.

- `sendWireBatch` stops when a per-entry JSON fallback finds the socket closed,
  avoiding later codec calls and duplicate closed-socket accounting.

- Static and prerendered text assets declare UTF-8 in `Content-Type` for
  CSS, CSV, HTML, calendar, JavaScript, Markdown, plain text, WebVTT and YAML
  files. Compressed responses retain that declaration; 304 responses omit it.
  Re-encode legacy text assets as UTF-8 before deploying: the HTTP charset
  overrides HTML meta charset and CSS @charset, and staticHeaders cannot
  override Content-Type. File bytes and JSON, XML, RTF, SVG and binary media
  types remain unchanged.

- Upgrade response headers encode accepted high-range characters as UTF-8,
  warn once per worker about cookies on 101 responses, and preserve nonempty
  queries ending in `?` in the upgrade event. Runtime guards reject reserved
  handshake names and non-string values before attempting the native upgrade.

- HEAD responses across probes, authentication refusals, static files,
  prerendered pages and SSR carry the server's current `Date`; application
  Date values are removed from SSR, authentication and admin responses.
  Declared streaming lengths remain intact. Bun's unknown-length HEAD and
  304 framing differences are documented.

- Request body input pauses when the application queue reaches 64 KiB.
  With a finite body budget, each ten-second full-queue pause permits one
  further native read to detect unread excess bytes; consumer demand resumes
  input immediately. Client disconnects before observed body completion and
  native body errors still abort the application signal while the queue is full.
  HTTP request lifetime and shutdown behavior are documented alongside the
  default WebSocket leak calibration.

- Static and SSR encoding negotiation honors quality weights, wildcard exclusions
  and exact encoding tokens. Range validators belong to the selected
  representation, and a zero-length suffix range returns 416.

- Shutdown hooks receive `reason`, `signal`, and `deadline`. Async
  `sveltekit:shutdown` listeners are awaited under the same budget.

- Request signals stop aborting on disconnect after native body completion
  has been observed. Streaming responses stay registered for graceful draining;
  signals still active when shutdown stops waiting are aborted.

- Route on the request target independently of the Host-derived URL prefix.
  SSR and authentication reject invalid origin headers with 400, and proxy
  origin reconstruction preserves the request body and query.

- Plugin capability, trusted attribution, and owned-topic prefix slots use the shared registered keys. Attribution resolves before open and invalid results close with code 1008.

- Subscribe batches recover allowed topics in one resume call, preserve per-topic epochs and buffered live delivery, and require a ref for history requests.

- Subscription authorization admits at most 4096 pending attempts per connection across single and batch requests, independently of the landed subscription cap.

- Held wire subscriptions consult the application hook again on single and batch requests while retaining the subscription-cap exemption.

- Static header benchmarks retain range support in compressed header fixtures,
  matching the responses served by the runtime.

- The admission simulator parses the upgrade event's relative request target so
  its parked, refused, and accepted connections continue to exercise admission.

- TypeScript WebSocket handlers compile when the Vite build plugin is absent.

- Discover hooks.ws.js, hooks.ws.ts, and hooks.ws.mjs in the shared order.

- Static byte ranges use the negotiated representation and require strong
  If-Range validators. Wildcard revalidation covers immutable assets; response
  headers and conditional precedence follow the shared adapter behavior.

- Authentication uses the shared event signature and carries client identity.
  Refused auth origins leave the client budget intact; upgrade rate-limit
  refusals omit Retry-After.

- Refresh the public API reference and vendored protocol schema to
  svelte-adapter-uws 0.6.0-next.96, including its WebTransport carriage
  annotations. `assertions` and the `./subscriptions` export now match the
  pinned declarations directly.

- Correct the `publishWireBatch` entry sequence helper's documentation:
  `true` draws the counter, `false` and `null` suppress it, and only an absent
  value inherits the shared options. Runtime behavior is unchanged.

- A static file whose name a browser percent-encodes is served for that
  spelling, as on svelte-adapter-uws and SvelteKit's Node adapter. A client
  escapes a space in the target, Bun escapes every byte outside ASCII, and
  assets were looked up by their raw file name, so `static/maß.txt` asked for
  as `/ma%C3%9F.txt`, or `My Report.pdf` as `/My%20Report.pdf`, got the app's
  404 by every spelling. The escapes may be in either letter case; they are
  decoded with `decodeURI`, so an escaped `/` does not reach into a directory,
  and a name carrying a `#` or `?` is not served for an escaped spelling. A name
  written decomposed is found for the composed spelling as well. A target that
  matches a file as sent is served exactly as before, on the same single
  lookup.

- A download's `Content-Disposition` carries its file name as the UTF-8 bytes
  svelte-adapter-uws writes, with control characters stripped as well as the
  quote and the backslash. A name outside Latin-1 failed the response with a
  500, since a fetch Headers value is bytes, and a name inside it went out as
  one Latin-1 byte per letter.

- On Windows, a path whose decoded spelling names an alternate data stream
  (`%3A`) or an 8.3 short name (`%7E`) is refused with `400` as the raw
  spelling already was, as on svelte-adapter-uws: every lane behind the check
  decodes before it opens a file.

- A request SvelteKit would route onto one of the adapter's own paths without
  spelling it - a data or route-resolution request such as
  `/healthz/__data.json`, or an escape such as `/%68ealthz` - is refused with
  `400` whatever its method, as on svelte-adapter-uws; it used to reach the
  app's router as that path. The paths are the probes, the auth path while the
  handler mounts it, and the WebSocket path while an `upgradeAdmission` limit
  makes its GETs the adapter's. A page one trailing slash further on,
  `/healthz/`, and its data stay the app's, and a file the app serves at such a
  path is still served. Bun resolves dot segments and backslashes before the
  adapter sees the target, so a spelling through them is the path itself here,
  on every lane: a GET of `/x/../healthz` is answered by the probe and a POST of
  it reaches the app as `/healthz`, a POST to `/x/../__ws/auth` reaches the auth
  endpoint, and a handshake on `/x/../ws` opens a socket. svelte-adapter-uws
  refuses each of them with `400`, the last only under an admission limit.

- A subscribe revoked while its authorization was awaited is no longer acked
  because its own hook installed the membership. A plugin join from inside the
  hook (a `trackedSubscribe`) left the topic held when the attempt landed, and
  the landing acked any held topic, so the revocation did not stand. The
  landing now reads who installed it, as svelte-adapter-uws does: a fresh
  attempt or a `platform.subscribe` re-grant that completed after the
  revocation is current authority and acks, while the revoked attempt's own
  install is refused and unwound - membership, cohort and the app's
  `unsubscribe` hook - once no other attempt is left to judge it. A hook that
  installs membership and then refuses has it unwound the same way, on the
  single, batch and `platform.subscribe` lanes. Two more readings follow from
  it. A subscribe for a topic held only by such an install is judged rather
  than acked on sight, so it is never told it holds a membership the revoked
  attempt's landing then removes - and under the server-grant gate that
  install does not count as a grant, so a client re-sending its subscribe
  cannot keep a topic it was revoked from. And a recover subscribe revoked
  that way is served no replay history before its landing refuses it.

- `platform.unsubscribe` could take the instance's subscription total below
  zero when its bookkeeping had drifted, and a negative total skewed the
  subscriber ratio and `ws_subscriptions`. Every change to the total now goes
  through one clamp at zero, which reports the drift as
  `subs.total-negative` (see `platform.assertions`).

- A connection whose subscription slot is not a Set now closes cleanly. The
  close handler took the slot as the connection's subscriptions, stored `NaN`
  as the instance's subscription total and threw from its own cleanup,
  skipping the release of the connection's capability counts, wire state and
  queued sends. It now treats such a slot as holding nothing, as
  svelte-adapter-uws does.

- A connection's request id reaches `open` whatever the process has put on
  `Object.prototype`. It crossed the upgrade on a string key, and assigning
  that key went through any setter Object.prototype had for the name, so a
  preload or polyfill defining one left the connection with no request id. It
  now rides a Symbol no other code can name. An application userData key of
  that old name is no longer overwritten and deleted, and a connection whose
  id did not arrive gets a minted one instead of `undefined`.

- The enumerable Symbol keys of the object an `upgrade` hook returns now
  reach the connection's userData in `open`, as they do on
  svelte-adapter-uws. Only string keys were copied. The adapter's own
  per-connection slots are never copied, so a hook that returns or spreads
  another connection's userData does not hand the new one that connection's
  wire-id table, cohorts, capabilities, budgets or permit.

- A shared-codec cohort join for a topic the connection already holds takes
  no second wire-id reference and sends no second announce; a repeat used to
  leave the id alive after its last member left. A repeat join also moves the
  connection between the cohorts rather than leaving it on both: off the JSON
  cohort when its earlier announce was refused and this one is delivered, off
  the binary cohort (its reference given back) when it has since lost the
  capability. Here a repeat join happens only when a shared publish runs from
  app code inside the first shared publish's cohorting walk - a close hook run
  by an announce that cut its own connection, for one.

- A `wire-id` announce, per connection or for a shared cohort, is charged to
  the connection's control-frame budget (4 MiB per 10 s) like every other
  control frame, and an announce the budget cannot afford cuts the
  connection with close code 4429. It was written with a raw send
  outside the budget. An announce into a socket that has already closed now
  reports undelivered, as a refused one does.

- A rate-limited auth preflight's `429` now carries a `Retry-After` of about
  one `authPathRateLimitWindow`, jittered (10 to 14 seconds at the default),
  instead of the flat window, so the clients behind one address - offices,
  schools, carrier NAT - do not all return in the same second. A fractional
  window is rounded up to whole seconds first, so the header is always an
  integer delay.

- `platform.sendWireBatch` returns 2 when the codec declined the batch and
  the frame for the final entry was dropped; it returned 1, as if everything
  had gone out. A dropped frame followed by entries that fall back to JSON
  still reports the status of the last send.

- Message data JSON has no form for - a function or a symbol - is refused
  with a `TypeError` to the caller on every send and publish lane, as a BigInt
  or a cyclic value already was, instead of going out as `"data":undefined`, a
  frame no client can parse. Every value JSON can carry is sent as before.

- An armed grant gate now decides the client-named `resume` frame as well as
  the subscribe lanes. That frame carries a per-topic `lastSeenSeqs` map and
  yields a topic's message HISTORY, and it passed the client's list to the
  app's `resume` hook unfiltered - so a topic the same connection was refused
  on the live-subscribe path was served on the history path. Both of the
  frame's maps are now filtered to the topics the server granted: they arrive
  keyed the same way, in the same frame, and the hook reads them together, so a
  topic dropped from the watermarks and left in the epochs is the refused topic
  arriving by the other hand. This is the whole gate for that lane - nothing
  re-checks behind it. Filtered rather than refused whole, since a reconnect
  legitimately names topics it still holds.

- A `subscribe` carrying `recover` now gap-fills a topic the connection already
  holds, instead of acking it and running nothing. Live membership carries no
  HISTORY, so the early "already subscribed" answer left a client that replayed
  from an offset subscribed and believing it had caught up, with the tail
  between its last-seen seq and now silently missing and no truncation signal
  to notice it by. Under an armed grant gate, where holding a topic is exactly
  what having been granted it means, that was every gap-fill this lane could be
  asked for. The per-connection subscription cap no longer counts a topic the socket
  already holds either, so the gap-fill cannot be refused `RATE_LIMITED` to a
  connection that is not growing.

- A subscribe hook that only OBSERVES no longer stands the gate aside. The gate
  steps back for an app that exports its own `subscribe` / `subscribeBatch`, on
  the reasoning that an app which took the topic decision owns it - but a
  plugin hook is not that: it joins a roster, returns no opinion, and denies
  nothing, while satisfying the same test. Arming the gate and following such a
  plugin's wiring together gave no enforcement at all. A hook carrying
  `Symbol.for('adapter-uws.hook.side-effect-only')` still runs and no longer
  counts as an authorization decision. An app's own wrapper around one is
  unmarked and still decides.

- A revocation landing while a `subscribe-batch` hook is awaited now cancels
  the install. The batch ran the app's hook with no in-flight token stamped for
  its topics, and a revoke can only cancel a subscribe that is recorded as in
  flight - so `platform.unsubscribe`, or the client's own `unsubscribe` frame,
  found nothing to cancel and the subscription landed behind it. The client
  then held a subscription it had been told was cancelled. The single-subscribe
  spelling stamped its token before its gate and refused correctly; the two
  spellings of one request now answer alike. What one frame may stamp is
  bounded, against the in-flight ceiling and the subscription cap both, and the
  excess is refused from the tail: a batch carries up to 256 topics and many
  can be parked at once, so an unbounded stamp would let a connection spend
  itself out of being grantable at all.

- A subscribe whose topic was revoked and then legitimately re-granted while
  its gate was awaited is acked rather than refused. Membership is read before
  the cancellation mark now, on both the single and the batch lane - the mark
  only ever rises, so consulting it first cannot distinguish a revoke that
  stands from a permission refresh, and the client was told `CANCELLED` for a
  topic the server was already fanning out to it. A revoke with no re-grant
  behind it still refuses, unchanged, and a denial the app's `subscribeBatch`
  hook gave for that topic outranks both answers: its hook ran for the topic in
  that frame, and holding the topic is not authority to overrule it.

- `platform.checkSubscribe(ws, topic, { requireGrant: true })` re-reads the
  grant after the app's hook resolves. It tested the grant only on the way in,
  so a revocation arriving while the hook was parked still authorized the
  snapshot, and a `'strict'` arming that landed in the same window did not
  tighten the decision it should have. A revoke followed by a legitimate
  re-grant stays invisible, as before - the topic is back in the set.

- A publish the TENANT egress ceiling refuses no longer touches the topic
  ledger. The topic half of the admission decision ran through the mutating
  window lookup, so it seated a key - reclaiming and, at the cap, evicting
  another to make room - before the tenant half could refuse. A tenant already
  over its ceiling could churn the ledger with fresh topic names and reset
  other topics' accounting on the way through. Both halves now decide against
  a non-mutating read.

- Shared binary frames are charged for their real topic id. The frame's topic
  id is a varint and was priced as a flat byte, so a shared wire id past the
  127th shared topic was charged less than it sent, on every frame.

- Adapter options that are not a plain object are refused at factory time
  naming what was passed. `adapter(null)` threw a native
  `Cannot read properties of null (reading 'out')` that named neither the
  adapter nor the option, and `adapter('build')` / `adapter(7)` /
  `adapter(true)` were accepted silently and built a server on defaults - so a
  config plainly meaning `{ out: 'build' }` reported no problem and did
  nothing.

- A `subscribe` carrying `recover` but no `ref` is now refused with
  `{"type":"error","code":"RECOVER_REQUIRES_REF","topic":"<t>"}` instead of
  being answered with nothing. Every gate and denial on that path is silent
  without a ref, so such a frame installed nothing and said nothing whatever
  refused it, and the client replayed its offset into a gap it could not see.
  Silence still stands for a ref-less subscribe that asks for no history.

- A subscribe cancelled by an unsubscribe while its gate was awaiting is no
  longer served replay history. The gap-fill runs before the subscription
  lands, so the settle that reports the cancellation came too late to stop it.

- `publishWireBatch` honours a call-level `{ excludeWs }` on the stateful lane,
  which read the per-entry field alone and so delivered every entry to the
  socket the caller asked to exclude. The stateless reroute always honoured it,
  so the same call behaved differently on either side of a codec gaining
  `state` - the documented way to opt into batch framing - and what the author
  got back was its own update, in a frame a stateful codec gives it no way to
  tell apart. An entry with a non-null `excludeWs` overrides the call-level
  exclusion; `null` and `undefined` inherit it.

## [0.0.3] - 2026-08-28

Still pre-alpha, and the public contract is still not stable. Message admission
gains its outbound half: `websocket.egress` bounds what a single publisher can
cost the process, per topic and per tenant. The static lane answers the full RFC
9110 precondition set instead of ETag alone, and a 304 carries the fields a
revalidating cache needs to use it. A shed upgrade's `Retry-After` spreads
across a band that widens with the protection posture, so a refused fleet does
not come back in one second. An option value that refuses to be read is refused
by option name rather than failing the build with its own error.

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
  `egress` figures and `topPublishers` gains `deliveriesPerSec`.

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

- An option value that refuses to be read is refused by option name at every
  object gate. `Array.isArray`, `Object.keys` and a plain property read all
  throw natively on a revoked Proxy or a throwing getter, so the build stopped
  with the value's own error, naming neither the option nor what it accepts -
  at the options bag itself and at `websocket`, `upgradeAdmission` and its
  `cursorLane`, `pressure`, `compression`, `allowedOrigins` and
  `staticHeaders`. Each gate reads such a value exactly once inside a guard
  and works from a plain copy of its own enumerable keys, and that copy is
  what goes forward: a getter on a `compression` object runs once at
  validation rather than whenever Bun reads the setting.

- A config value that refuses to be read is refused by option name even when it
  is callable. `typeof` reports `function` for a revoked Proxy built over a
  callable target, so `websocket.allowedOrigins` handed one straight to
  `Array.isArray` and the build stopped with `Cannot perform 'IsArray' on a
  proxy that has been revoked` - naming neither the option nor what it accepts.
  The options bag itself had the same hole. A function passed as the whole bag
  is refused too, rather than copied to `{}` and built on silent defaults.

- A `304` now carries `ETag`, `Cache-Control`, `Vary` and `Last-Modified`, per
  RFC 9110 s15.4.5. It carried none of them, so every revalidating cache got a
  response it could not use to extend what it had stored. The fields are baked
  per coding at index time, so the answer still costs no header build.

- `If-None-Match` takes `*` and the list form, and entity-tags compare weakly
  as RFC 9110 s13.1.2 requires - a cache that stored the opaque tag without the
  `W/` prefix is asking about the same representation and now gets the 304 it
  asked for.

- A shed upgrade's `Retry-After` widens with the live protection posture, which
  is the half of the carried contract that never reached a refusal: the shed
  lane passed no spread at all, so an escalated server answered the normal band
  and told a bigger herd to come back inside the same two seconds. Every
  capacity refusal - the ceiling, the cursor lane, the pacing overflow - reads
  the posture per refusal, and at the shared base of 2 that is 2..3 normally
  and 2..4 under siege, matching svelte-adapter-uws value for value.

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
  determinism check - and the determinism scan.

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

- `websocket.maxPayloadLength` accepts at most 2147483647, matching the
  maximum supported by the family transport contract.

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

  Metric names, types and label vocabularies match svelte-adapter-uws so a
  dashboard can use the same queries across adapters. Unavailable measurements
  are omitted rather than reported as healthy zero activity.

  Two new counters back this: `upgrade_admitted_total` (the denominator the
  refusal counts never had) and per-door rate-limit map evictions, which say
  when the map cap rather than the configured limit is deciding who gets
  metered.

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
  trusting a partial flush. Standalone `resume` forwards application-owned
  session and history values, filters both maps through confirmed grants when
  server authorization is armed, and acknowledges after the hook settles.
  On the subscribe recovery lane a throwing hook emits `truncated` before the
  subscription acknowledgement.
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
  server's capacity.

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

Initial release with Bun.serve HTTP handling and JSON topic messaging.

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
  subscribe gate), and `maxControlEgressBytes` (the ack channel, in
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
