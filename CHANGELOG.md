# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- `publishWireBatch` conflated an explicit seq of 0 with no seq at all. It
  round-tripped every stamped seq through the wire's 0 sentinel before handing
  it to the resume capture, so an entry published with `seq: 0` was captured as
  seq-less - and a seq-less frame is never deduped, so the same event was
  deduped through `publish()` and re-delivered through the batch. The stamped
  seq is now kept as stamped, and the 0 is applied only at the frame builder,
  where it means "no seq" on the wire and nowhere else.

- `publishWireBatch` given a batch-level `{ seq: <number> }` stamped every entry
  with that one number, which cannot be the one-seq-per-entry it documents. It
  is now refused (warned once, published without a seq) rather than honoured:
  with all N entries sharing a seq, a client that received only part of the
  batch reports that seq as its watermark and the resume dedup floor then
  discards the WHOLE batch, including the entries it never received. Publishing
  seq-less costs a re-delivery instead, which the client tolerates. Put the seq
  on the entry to keep it. The method's JSDoc also typed `seq` as a boolean
  while `publishWire` documented and accepted a number; both now agree.

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
