# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
