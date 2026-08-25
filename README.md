# svelte-adapter-bunserve

> **Status: early, and behind the adapter it follows.** svelte-adapter-uws is
> the lead and is several minor versions ahead. Both halves work here - HTTP and
> single-node realtime, covered by unit, sim, live and leak lanes, all run
> against Bun 1.3.14 and 1.4.0 - and the `platform.*` surface it
> does implement matches the lead's. It is behind on: multi-node fan-out (the
> extensions package throws against it), per-key send coalescing and socket RPC,
> TypeScript types, and multi-process. Fine for a single-node app; pick
> svelte-adapter-uws if you need any of that.

A SvelteKit adapter for [Bun](https://bun.com), built on `Bun.serve`: it follows
[svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws) and works
with the same ecosystem around it -
[svelte-realtime](https://github.com/lanteanio/svelte-realtime) for the client
stores and
[svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions)
for clustering, presence and cursors. Same `platform.*` surface, same plugins,
same client. The adapter swap is one line in `svelte.config.js`; app code is
unchanged.

(One caveat: the extensions package does not work against this adapter yet, so
multi-node fan-out is not available - see [Current state](#current-state).)

## Why this exists

`svelte-adapter-uws` rides uWebSockets.js, a native N-API addon that Bun cannot
load - so Bun users have had the HTTP half (via adapter-node under Bun's Node
compatibility) and none of the realtime tier. Bun's own WebSocket server is
built on the very same uWebSockets core, which means it natively speaks
everything this family needs: topic pub/sub, corked writes, drain events,
backpressure limits. This adapter maps the family's platform surface onto that
native core.

The family, by tier:

| package | transport | tier |
|---|---|---|
| `svelte-adapter-uws` | uWebSockets.js on Node | maximum performance |
| `svelte-adapter-ws` (planned) | node:http + ws | maximum portability |
| `svelte-adapter-bunserve` (this repo) | Bun.serve | Bun, natively |

The suffix names the transport, like every member of the family: `uws` is
uWebSockets.js, `ws` is the ws library, `bunserve` is `Bun.serve`.

## Current state

Every step of the build order below is done. What remains is listed as
known-open under the step that owns it. The public surface is not settled here
in any case: svelte-adapter-uws leads it, and this adapter follows what that one
declares.

1. **API probe** (done): `probe/bun-api-facts.mjs` empirically verifies every
   Bun server API behavior the adapter design relies on - send-result
   semantics, backpressure signals, closed-socket behavior, upgrade flow,
   drain semantics - against a pinned Bun version, and writes a committed
   facts report. The adapter is built against what Bun was measured to do,
   not against what its documentation says.
2. **HTTP half** (done): a built SvelteKit app
   serves under `bun build/index.js`. SSR goes straight through
   `server.respond()` (real web Request in, Response out, Bun's own
   backpressure on streams); static assets come from an in-memory
   precompressed cache with ETag/304, `Last-Modified` with the full RFC 9110
   precondition set (`If-Match` / `If-Unmodified-Since` answer 412,
   `If-Modified-Since` answers 304 for caches that lost the validator), RFC
   7233 ranges, and trailing-slash canonicalization, with a `Bun.file()`
   kernel-sendfile lane for large files;
   SSR dedup and the BREACH-aware compression gate are carried over, and a
   response is compressed whole whenever its body completes without waiting,
   so a streaming render reaches the client as it is produced; `/healthz` +
   `/readyz` and graceful drain round it out.
   Known-open on the HTTP half: the graceful-drain signal path is asserted on
   Linux only (`test/live/shutdown-check.mjs`, run in CI; Windows delivers no
   real SIGTERM to exercise it, so the suite skips there);
   the TLS surface remains unprobed (needs real certificates); a request body
   sent without a Content-Length is capped by Bun rather than by the adapter's
   own check, and that path has not been exercised; immutable assets carry
   no ETag, so they answer no conditional or range requests (inherited from
   svelte-adapter-uws, where versioned filenames make both redundant); and
   telling a complete response body from a streaming one depends on Bun
   resolving an already-available stream read as a microtask - pinned by the
   probe's `body-read-scheduling` group, so a Bun upgrade that changes it
   surfaces as a report diff rather than a silent loss of compression and
   deduplication. `If-None-Match` is matched exactly, so neither `*` nor a
   list of validators produces a 304 (a needless full response rather than a
   wrong one, matching svelte-adapter-uws).
3. **JSON realtime** (done): the upgrade path, the per-connection platform, and
   topic pub/sub over real WebSockets. See [WebSockets](#websockets) below.
4. **Binary wire protocol** (done): `0x03` codec frames over
   `publishWire`/`sendWire` and their batch variants, capability negotiation
   through the `hello` frame, the per-connection wire-id announce, the shared
   cohort split for stateless `shared` codecs, degrade-to-JSON on a dropped
   stateful frame or a failing stateful `encode` (a throw or a wrong-type
   return poisons the capability for that connection; returning `null`
   declines cleanly and keeps binary available), and resume gap-fill with a
   live-frame barrier across the cutover.
   Known-open on the realtime tier: the deferred JSON-tier members are
   absent rather than stubbed, so nothing reports success while doing
   nothing: `request` and `requestTopic` (server-initiated request/reply),
   the coalescing and batching send variants (`sendCoalesced`, `batch`,
   `publishBatched`), and `topicEpoch`. The protection POSTURE machine's
   option is likewise not accepted yet - `platform.protection` reads
   `'normal'` - while the pressure sampling, observability members and
   LEASE/REQUEST_N flow control are live (step 5, done).
5. Backpressure/flow-control parity (done: the pressure sampler,
   `platform.pressure`/`onPressure`/`onPublishRate`, and the lease window
   lane), and the conformance gate against the family's deterministic
   simulation goldens (done: `npm run sim:golden`, whose cross-adapter corpus
   is fingerprint-identical to the sibling's at the pin).

Single-process, and not provisionally so. Bun's `node:cluster` does share a
listening socket across workers, but a `publish()` reaches only the subscribers
held by the worker that ran it, so each worker would serve a private slice of
every topic. Scale-out is the extensions bus, not in-process workers.

**Multi-node fan-out does not work yet.**
[svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions)
(Redis/Valkey) is transport-agnostic and is the intended path, but its
`bus.wrap(platform)` binds four members without feature-detecting them:
`onPressure` and `onPublishRate` (now live here) plus `sendCoalesced` and
`request`, which this adapter does not implement yet - so it still throws a
`TypeError` at startup against this adapter, on those two. It needs either
those members (step 4 above) or the same guards it already applies to its
other optional members. Until one of those lands, treat this adapter as
single-node.

## WebSockets

Zero-config: drop a `src/ws-handler.js` into the project and the realtime
surface turns on. With no such file - and no `websocket` option in
`svelte.config.js` - the adapter serves no WebSocket endpoint at all: no upgrade
lane, no per-connection bookkeeping, nothing added to `Bun.serve`. Configuring
`websocket` without a handler file DOES register the endpoint (on the assumption
that you meant to have one), and since there is no `subscribe` hook to authorize
against, every subscription is then denied `SUBSCRIBE_NOT_CONFIGURED`.

```js
// src/ws-handler.js - every hook is optional
export async function upgrade(request, { platform, headers }) {
	// Runs BEFORE the handshake and may await freely (Bun hands `fetch` a real
	// Request, so nothing is stack-allocated the way it is under uWS).
	// Return a Response to REJECT the upgrade with exactly that response.
	const session = await lookupSession(request.headers.get('cookie'));
	if (!session) return new Response('Unauthorized', { status: 401 });
	// `return false` also rejects, with a plain 401.
	// Handshake headers (subprotocol selection, a Set-Cookie) go on `headers`,
	// which is applied to the 101 response.
	headers['sec-websocket-protocol'] = 'v1';
	// Everything RETURNED becomes this connection's userData.
	return { userId: session.userId };
}

// Optional HTTP preflight, mounted at `websocket.authPath` (default
// `/__ws/auth`) ONLY when this hook is exported. The family client store POSTs
// here before opening a socket when `connect({ auth: true })` is used.
//
// It exists so a session cookie can be refreshed on an ordinary response: a
// Set-Cookie on the 101 upgrade response is silently dropped by Cloudflare
// Tunnel and other strict edge proxies, so a refresh that rides on the
// handshake works in development and vanishes in production.
//
// Return nothing for 204, `false` for 401, or a Response to use verbatim.
// Cookies set here are merged onto whichever of those you return.
export async function authenticate(request, { cookies, platform, getClientAddress }) {
	const session = await refresh(cookies.get('sid'));
	if (!session) return false;
	cookies.set('sid', session.token, { path: '/', maxAge: 3600 });
}

// Once per process. `init` runs after the listener is up (a throw here is NOT
// swallowed - boot failure should be loud). `shutdown` runs at graceful stop
// BEFORE the sockets are drained, so it can still reach connected clients.
export function init({ platform, workerData }) {}
export function shutdown({ platform }) {}

export function open(ws, { platform }) {}
export function message(ws, { data, isBinary, msg, platform }) {}
export function drain(ws, { platform }) {}
export function close(ws, { code, subscriptions, messagesIn, bytesOut, platform }) {}
export function unsubscribe(ws, topic, { platform }) {}

// Authorization gate for every client subscribe. Return a reason string (or
// false) to deny; return null, undefined or true to allow. Anything else is
// not a verdict this can read - `403`, an Error, an un-awaited promise - and
// is refused with INTERNAL_ERROR and a console error rather than allowed.
export function subscribe(ws, topic, { platform }) {
	return topic.startsWith('admin:') ? 'FORBIDDEN' : null;
}

// Optional: gate a whole `subscribe-batch` in ONE call instead of once per
// topic. Return a PLAIN OBJECT keyed by topic whose VALUE is the verdict:
// `false` or a reason string denies, and an absent key (or `true`, or
// `undefined`) allows. Not a real `Map` - that cannot be read as one, and is
// refused with INTERNAL_ERROR and a console error. When exported it REPLACES
// the per-topic `subscribe` gate, including for single subscribes (which are
// treated as a one-entry batch).
export async function subscribeBatch(ws, topics, { platform }) {
	const allowed = new Set(await db.allowedTopics(ws.getUserData().userId, topics));
	const denials = {};
	for (const topic of topics) if (!allowed.has(topic)) denials[topic] = 'FORBIDDEN';
	return denials;
}
```

**Exporting `subscribe` is effectively required.** Without it the adapter cannot
tell an app-private topic from a public one, so it denies every subscription
with `SUBSCRIBE_NOT_CONFIGURED` and prints how to resolve it. Allowing by
default would mean any client that can name `user:<id>` receives it. If every
topic in the app really is public, say so explicitly with
`websocket: { allowUnauthenticatedSubscribe: true }`.

**Handshake headers come from the context, not the returned object.** The
returned object is frequently built by spreading parsed client input
(`return { ...JSON.parse(atob(jwt)), user }`), and an in-band `headers` key on
that object is therefore attacker-settable - a crafted token claim could put an
arbitrary `Set-Cookie` on the 101 response. The context channel cannot be named
by client data. A returned `headers` key is ordinary userData, and the
adapter warns once if it sees one.

**The auth preflight is guarded against CSRF by default.** It accepts session
cookies and runs your credential check, so a page on any origin could otherwise
drive it with the visitor's cookie riding along on a credentialed `fetch`. The
request is accepted when it carries `x-requested-with: XMLHttpRequest` (a
cross-origin browser cannot set a custom header without a CORS preflight, and
this endpoint approves none), or `sec-fetch-site: same-origin` (browsers stamp
it and script cannot forge it), or an `Origin` your `allowedOrigins` allows. The
family client stamps the first, so browser traffic is unaffected. A **missing**
`Origin` is refused here, where the upgrade door allows it - that door has your
`upgrade` hook behind it to authenticate a non-browser client, and this endpoint
IS the authentication. Native clients that send none of the three are what
`authPathRequireOrigin: false` is for.

**The preflight is metered per client address**, at `authPathRateLimit` (30) per
`authPathRateLimitWindow` (10) seconds, so a credential check against a database
cannot be driven at raw server capacity from one address. Over the limit is
`429` with a `retry-after` naming the window, and the hook is never called. The
budget is separate from `upgradeRateLimit`'s and deliberately higher: every
reconnect that preflights also upgrades, so matching them 1:1 would make this
door the binding constraint on both. The identity is resolved exactly as the
upgrade limiter resolves it, with the same caveat behind an address-rewriting
proxy - and the server says so once per door and per cause, on the first
refusal that looks like one. Refusals are counted as
`upgrade_rejected_total{reason: "auth_rate_limit"}`.

**The hooks take `(request, context)` here, where svelte-adapter-uws takes a
single event object.** Bun hands `fetch` a real `Request` that outlives an
await, so passing it straight through is the honest shape rather than copying
one field at a time into a synthetic event. A `hooks.ws` module moving between
the two adapters needs its `upgrade` and `authenticate` signatures adjusted;
everything the context carries (`platform`, `cookies`, `getClientAddress`) is
the same information under the same names.

**`subscribe` is called with the per-connection `platform`**, the same one every
other hook receives, so `platform.requestId` correlates across the whole
connection.

A throwing `subscribe` hook denies with `INTERNAL_ERROR` rather than
`FORBIDDEN`, so a client can retry a transient failure without retrying a
deliberate refusal.

The same `platform` reaches SSR, so a load function or form action publishes
without holding a socket:

```js
export function POST({ platform }) {
	platform.publish('room', 'said', { text: 'hello' });
	return new Response(null, { status: 204 });
}
```

### Platform surface

| member | notes |
|---|---|
| `publish(topic, event, data, options?)` | topic fan-out; `{ seq, jitterMs, compress }`. `seq` DEFAULTS to the per-topic counter - a call with no options stamps one; `{ seq: false }` is the only way to publish without |
| `send(ws, topic, event, data, options?)` | one connection; returns 0 enqueued / 1 sent / 2 dropped |
| `sendTo(filter, topic, event, data, options?)` | filtered fan-out; the filter MUST be synchronous |
| `subscribe(ws, topic, options?)` | server-side subscribe THROUGH the authorization hook; `null` on success, else a reason: `INVALID_TOPIC`, `SUBSCRIBE_NOT_CONFIGURED`, `INTERNAL_ERROR`, `FORBIDDEN` (what a hook returning `false` becomes), `RATE_LIMITED`, `CANCELLED`, `CLOSED`, or the hook's own string |
| `checkSubscribe(ws, topic, options?)` | run the hook without subscribing; the same reasons except the last three, which only an install can produce |
| `unsubscribe(ws, topic)` | unsubscribe and keep bookkeeping in step |
| `metrics` | the instance's metrics registry: `counter(name, help, labelNames?)`, `gauge`, `histogram`, `projectCounter`, `serialize()`, `read()`, `reset()`. Register your own instruments on it; `serialize()` renders the same document `metricsSnapshot()` does, adapter families included |
| `metricsSnapshot()` | `Promise<string>` - the whole Prometheus document, adapter families first |
| `adviseReconnect(options?)` | jittered reconnect advice, then drain |
| `connections` / `subscribers(topic)` / `forEachSubscriber(topic, fn)` | live counts and the per-subscriber walk |
| `totalSubscriptions` / `publishCount` | instance-wide subscription total, and publishes since boot |
| `maxPayloadLength` / `bufferedAmount(ws)` / `closedWsAborts` | limits and backpressure telemetry |
| `droppedReleaseRecords` | instance-wide; non-zero means an `unsubscribe` hook failed often enough that some releases are no longer covered by the close-hook fallback |
| `pressure` | the LIVE 1 Hz sample (mutated in place, never copied): `{ active, value, reason, subscriberRatio, publishRate, memoryMB, maxBufferedBytes, backpressuredConnections, psi, cpuThrottle, topPublishers }`; `reason` precedence is MEMORY > CAPACITY > CPU_QUOTA > PSI > PUBLISH_RATE > SUBSCRIBERS > NONE; kernel readings are `null` off-Linux |
| `protection` | `'normal' \| 'elevated' \| 'siege'`; `'normal'` today (the posture machine's option is not yet accepted here) |
| `onPressure(cb)` | fires on `reason` TRANSITIONS with the live snapshot; throwing callbacks are contained; returns unsubscribe |
| `onPublishRate(cb)` | per-topic runaway-publisher reports `[{ topic, messagesPerSec, bytesPerSec }]` once per window; registering replaces the default throttled console warning; returns unsubscribe |
| `topic(name)` | scoped publisher: `platform.topic('chat').created(data)` |
| `requestId` | per-connection / per-request identity |
| `now()` / `monotonic()` / `random.float()` `.u32()` `.uuid()` `.bytes(n)` | determinism seams |
| `publishWire(topic, event, data, wire, options?)` | binary fan-out through a codec: capable clients get the `0x03` frame, everyone else the `publish()` envelope with the SAME seq; `{ seq, compress, excludeWs }` |
| `publishWireBatch(topic, event, entries, wire, options?)` | one tick's updates as ONE batch frame per capable connection (the codec's `<event>-batch` form), per-entry envelopes and seqs for the rest; per-entry `excludeWs` and `seq` |
| `sendWire(ws, topic, event, data, wire, options?)` | single-target codec frame (seq 0), or the JSON envelope for a caps-less / degraded connection; returns the send tri-state |
| `sendWireBatch(ws, topic, event, entries, wire, options?)` | the per-subscriber twin of `publishWireBatch`, for culled per-viewer walks |
| `registerWireCodec(wire)` | register a codec under its capability token; idempotent, last-wins |

**The memory signal is off by default here, and that is the one pressure
default that differs from svelte-adapter-uws.** `heapUsed / heapTotal` only
measures saturation on an engine that over-allocates its heap. Bun does not:
a freshly booted, completely idle server measures 0.90 to 0.94 on Bun 1.3.14
and 0.81 on 1.4.0 (the live suite pins that it stays high), so the family's
`memoryHeapUsedRatio: 0.85` would fire on a healthy 1.3 process and never
clear, and flap on ordinary allocation churn on 1.4 - either way
`platform.pressure.active` misreports for the life of every app, and
`onPressure` announces `MEMORY` without meaning it. The
same reading is kept out of the flow-control window sizing for the same
reason: fed to a knee calibrated for an over-allocating heap, an idle server
would hand out a fraction of the intended window. Both are pinned by
`test/live/pressure-check.mjs` against a real server, so if the engine's
accounting ever changes the divergence is revisited rather than kept out of
habit.

**What that costs you, stated plainly:** with the heap signal off, this
adapter ships no memory pressure signal at all on a host without PSI - every
non-Linux host, and Linux without PSI compiled in. A worker genuinely
approaching OOM there reports `reason: 'NONE'` and `active: false`, so
`onPressure` is not a memory alert on those hosts. On Linux, `psiMemoryFull`
(default 15) is live and is the better memory signal anyway: it measures
kernel-observed stall time, which fires meaningfully earlier than an
OOM-adjacent heap ratio. Elsewhere, either opt back into the sibling's exact
threshold with `websocket: { pressure: { memoryHeapUsedRatio: 0.85 } }` -
accepting that it reads as permanently active - or watch RSS outside the
process until the family settles a runtime-independent memory signal. Every
other threshold, and the rest of the surface, is the family's.

`platform.subscribe` refuses the adapter's own `__`-prefixed namespace by
default, because the documented advice is to route server-initiated subscribes
through it - so an app implementing its own `join` verb would otherwise pass a
client-supplied room straight into an internal channel. Pass
`{ allowSystemTopic: true }` where that is genuinely intended.

`checkSubscribe` applies the same guard and takes the same escape, so the two
cannot disagree about a topic. A bare `ws.subscribe(topic)` applies neither, and
it is not something the adapter can see - so in the family's
check-then-subscribe pattern, the check is the only thing standing between
client input and an internal channel:

```js
// Test against null, NOT truthiness: '' is a denial reason a hook produces
// naturally from `DENY_REASONS[topic] ?? ''`, and it is falsy.
if ((await platform.checkSubscribe(ws, topic)) !== null) return;
ws.subscribe(topic);            // no gate, no cap accounting, no epoch
```

Even written correctly that pattern subscribes outside the adapter's cap and
in-flight accounting. Prefer `platform.subscribe(ws, topic)`, which gates,
counts and acks in one call. Prefer it in general over a bare
`ws.subscribe(topic)` for
server-initiated subscriptions: the authorization hook only fires for client
`subscribe` frames, so a direct socket call silently bypasses the gate. That
holds whichever gate you export - `subscribe` or `subscribeBatch` - because
`platform.subscribe` runs the configured one either way.

`subscribeBatch` takes precedence when both are exported, and it REPLACES the
per-topic gate rather than supplementing it. A single `subscribe` frame is
gated as a one-entry batch, so the hook decides every subscription regardless of
which frame asked for it.

### Metrics

Every instance keeps a metrics registry and can render it as a Prometheus
document - **including a build with no WebSocket handler**, which is why the
members live on `platform` rather than on the realtime tier. Such a build
publishes the process families (`resident_memory_bytes`, `heap_used_ratio`) and
whatever your app registered, and none of the realtime ones: a server with no
upgrade path has not admitted zero upgrades, it has no upgrade door to count.
Register from the route itself there, since there is no `init` hook to do it
from.

There is nothing to configure - serve it from an ordinary route:

```js
// src/routes/metrics/+server.js
export async function GET({ platform }) {
	return new Response(await platform.metricsSnapshot(), {
		headers: { 'content-type': 'text/plain; version=0.0.4' }
	});
}
```

Your own instruments go on the same registry and land in the same document,
after the adapter's own families:

```js
// src/ws-handler.js
let orders;
export function init({ platform }) {
	orders = platform.metrics.counter('orders_placed_total', 'orders placed', ['tier']);
}
```

**The adapter owns the registry, and that is deliberate.**
svelte-adapter-uws takes one from a module you name in `websocket.metrics`.
That cannot work here: measured on this repo's own fixture, a module imported
by both a SvelteKit route and the WebSocket handler ends up as **two copies** in
the built output, because SvelteKit's server bundle is already bundled before
the adapter's own pass sees your handler. An app that imported its registry to
serve `/metrics` would render one the adapter never wrote to - every adapter
family stuck at zero, and nothing to indicate why. Reaching it through
`platform`, which is the same object SSR already gets, is what makes there be
exactly one.

**Nothing is emitted from a hot path.** The runtime already counts refusals by
reason, publishes, closed-socket aborts and the rest; the document is projected
from those authoritative numbers when something scrapes. So metrics cost nothing
until they are read, and there is no second tally that can disagree with the
first. The pressure-derived gauges are as fresh as the last sampler tick, which
`pressure_sample_timestamp_seconds` states outright - alert on its age rather
than assuming the gauges beside it are current.

`websocket.metrics` - the sibling's option naming your registry module - is
**accepted so a carried config builds, and not loaded**. The build says so, and
names `platform.metrics` as where to go instead. Honouring it would produce a
server that looks instrumented and is not.

The metric names are svelte-adapter-uws's, so dashboards move between the two
adapters. Signals this adapter cannot measure are **absent** rather than zero: a
zero published for something never measured reads as healthy and no alert ever
fires. That applies over time as well as at boot - the pressure families appear
at the sampler's first tick, roughly a second in, and the kernel readings
disappear again if `/proc/pressure` stops answering rather than republishing the
last figure as current. `metrics_snapshot_workers_expected`, `_reporting` and
`metrics_snapshot_degraded` are always `1`, `1` and `0` here, because this
adapter is single-process - they are carried so an alert written against the
sibling still evaluates.

### Options

Options are checked on a two-tier policy, because the person most likely to
mistype one is the person who gets no help from an editor. An unknown top-level
key is **warned** about at build time, naming the option it probably meant - it
is not fatal, so an app pinned to an older adapter than its config was written
for still builds. A known option with a value the adapter cannot honour
**throws** immediately, saying what the option accepts.

The distinction is deliberate: an unrecognised key is a version question, while
an unusable value never becomes correct by waiting. Note that no coercion
happens either - `precompress: 'no'` is refused rather than read as truthy,
which is the shape of typo that otherwise turns an option ON when its author
plainly meant OFF.

The top-level options, with their defaults:

```js
adapter: bunserve({
	out: 'build',                    // build output directory
	precompress: true,               // write .br and .gz siblings for static and prerendered files
	envPrefix: '',                   // prefix for the runtime env vars this adapter reads
	healthCheckPath: '/healthz',     // liveness probe; false disables it
	readinessCheckPath: '/readyz',   // readiness probe; 503 once a drain begins. false disables it
	staticCacheMaxFileSize: 4194304, // files above this are served from disk with Bun.file
	staticDotfiles: false,           // see Static files
	staticHeaders: undefined,        // extra response headers for static and prerendered files
	websocket: undefined             // the realtime endpoint; see below
})
```

`healthCheckPath` answers liveness and `readinessCheckPath` answers readiness -
two distinct probes, so they must differ, and the build fails if they do not. A
readiness 503 during a drain is a signal to stop routing new traffic; if a
liveness probe read the same route, that drain would be answered with a restart
instead. Neither may collide with `websocket.path` or `websocket.authPath`: the
probe routes are matched first, so the endpoint behind the collision would never
be reached, and that fails the build rather than going quiet.

`staticCacheMaxFileSize` is a positive integer byte count. Files at or below it
are held in the in-memory static index; larger ones are streamed from disk
through `Bun.file`, which uses the kernel's own send path.

`staticHeaders` is an object of string header values applied to static and
prerendered responses, merged once while the index is built rather than per
request. Names must be RFC 7230 tokens and values single-line printable text -
a control character in a value would otherwise throw on every static request, so
it fails the build instead. Ten keys are reserved and dropped with a warning
naming each one, because they decide transfer, caching and conditional-request
correctness: `content-type`, `content-encoding`, `content-range`,
`content-length`, `date`, `etag`, `last-modified`, `vary`, `cache-control` and
`accept-ranges`. A
non-reserved key that the adapter already sets, such as `x-content-type-options`,
is replaced by yours.

```js
adapter: bunserve({
	websocket: {
		path: '/ws',                        // default
		handler: 'src/ws-handler.js',       // default
		authPath: '/__ws/auth',             // the auth preflight POST; must differ from `path`
		authPathRequireOrigin: true,        // CSRF guard on it; false accepts native clients
		metrics: undefined,                 // accepted for config portability; NOT loaded - see Metrics
		authPathRateLimit: 30,              // preflights per client address per window; 0 disables
		authPathRateLimitWindow: 10,        // that window, in seconds
		compressCredentialedResponses: false,
		maxPayloadLength: 1024 * 1024,      // default 1 MB
		idleTimeout: 120,                   // seconds; Bun REFUSES anything above 960
		maxBackpressure: 1024 * 1024,
		closeOnBackpressureLimit: false,
		sendPingsAutomatically: true,
		compression: false,                 // true, or { compress, decompress }
		allowedOrigins: 'same-origin',      // 'any' | '*' | ['https://app.example']
		publishToSelf: false,
		allowNonAsciiTopics: false,
		allowSystemTopicSubscribe: false,
		allowUnauthenticatedSubscribe: false,
		maxSubscriptionsPerConnection: 10_000,
		maxConcurrentSubscribeGates: 64,
		maxConcurrentUnsubscribeHooks: 64,
		maxQueuedUnsubscribeHooks: 1024,
		maxControlEgressBytes: 4 * 1024 * 1024,
		upgradeRateLimit: 10,               // upgrades per client address per window; 0 disables
		upgradeRateLimitWindow: 10,         // that window, in seconds
		upgradeTimeout: 10,                 // seconds the `upgrade` hook may take; 0 waits forever
		// Admission control for the upgrade path. Every layer is OFF unless
		// you set it; omit the block entirely and nothing is gated.
		upgradeAdmission: {
			maxConcurrent: 1000,              // handshakes in flight at once
			maxConnections: 50_000,           // reserved + live, held until close
			perTickBudget: 64,                // upgrades per event-loop tick
			maxDeferred: 1024,                // finite queue behind the budget
			cursorLane: { fraction: 0.25 }    // omit to disable the lane
		},
		// Pressure-sampler thresholds; each signal accepts `false` to
		// disable it. The sampler always runs - this only tunes it.
		pressure: {
			// OFF here, and the one default that deliberately differs from
			// svelte-adapter-uws (which ships 0.85). See below.
			memoryHeapUsedRatio: false,
			publishRatePerSec: 10_000,
			subscriberRatio: 50,
			sampleIntervalMs: 1000,           // under 100 resets to 1000; capped at 2^31-1
			topicPublishRatePerSec: 5000,
			topicPublishBytesPerSec: 10 * 1024 * 1024,
			psiCpuSome: 60,                   // kernel signals; inert off-Linux
			psiMemoryFull: 15,
			psiIoFull: 50,
			cpuThrottledRatio: 0.25
		}
	}
})
```

The last five are per-connection bounds this adapter enforces itself, and they
are different jobs rather than different sizes of the same one:

- `maxSubscriptionsPerConnection` bounds what can INSTALL. It counts installed
  plus DISTINCT pending topics, because N concurrent subscribes to one topic can
  only ever install one subscription - counting them N times would deny requests
  that are not over any real limit.
- `maxConcurrentSubscribeGates` bounds concurrent APP WORK in the SUBSCRIBE
  gate: the `subscribe` / `subscribeBatch` hook, counted for as long as each
  call is suspended. That is where an app does its database round-trip, and
  distinct-topic counting cannot bound it - N concurrent gates for one topic
  cost 1 against the cap above. Exceeding it denies the subscribe with
  `RATE_LIMITED`. The same counter also bounds the `resume` hook on both lanes
  that reach it, so lowering this number starts refusing gap-fills too: a
  standalone `resume` frame over the bound is answered `RESUME_RATE_LIMITED`,
  and a `subscribe` carrying `recover` is denied `RATE_LIMITED` as usual. It does NOT cover `platform.checkSubscribe`, which the app
  calls from its own code: the adapter can bound the verbs it owns and answer a
  refusal in a protocol it defines, and it can do neither for a server-side
  call, the same reason the `message` hook is unbounded.
- `maxConcurrentUnsubscribeHooks` and `maxQueuedUnsubscribeHooks` bound the
  `unsubscribe` hook, and they are a SEPARATE pair rather than a share of the
  gate number because the two lanes have different rights. A subscribe may be
  refused - the client asked, and it is told no. An unsubscribe may only be
  DEFERRED: the hook is where the app releases plugin state that outlives native
  membership, and the family client sends `unsubscribe` with no `ref` and has no
  branch for a refusal, so dropping one leaks that state silently. So releases
  past the concurrency bound queue in FIFO order rather than being dropped, and
  only a speculative release - for a topic this connection was never granted,
  which costs an attacker nothing to invent - yields its place, and a release
  refused there runs no hook at all. A connection that fills even the queue is
  closed with 4429, and every release whose hook has not SUCCEEDED is named in
  the set handed to the `close` hook, so the app performs that teardown by
  another route.

  **Teardown is at-least-once, so make it idempotent.** If a release's
  `unsubscribe` hook does not resolve - because it is still queued when the
  socket dies, or it threw, or it rejected against a backend that is down - the
  topic is named to the `close` hook instead. (The one limit: a connection
  records at most 2176 DISTINCT topics owed a teardown, which no amount of
  ordinary concurrency reaches - getting there takes that many different topics
  on one connection whose hook never resolved, and releasing the same topic
  repeatedly does not grow it. Past that the release is not recorded, the
  adapter says so once, and the instance-wide
  `platform.droppedReleaseRecords` counts it.) The
  cost is that a hook which was mid-await when the connection died can finish
  AND have its topic named there, so a teardown that is not idempotent (a bare
  `roster.decr(topic)`) can run twice. The alternative is dropping the release
  whenever the two race, which leaks silently; running it twice is the failure
  an app can defend against. A speculative release carries no promise at all,
  because recording those would let a client grow the record by naming topics it
  never had.
- `maxControlEgressBytes` bounds the ACK CHANNEL, in bytes per 10 s. Exceeding
  it closes the connection with `CONTROL_FLOOD` and code 4429. It covers every
  frame the client's own input buys, which includes the `__replay:t`
  `truncated` marker: a resume or recover naming many topics can be answered
  with a marker per topic, so that lane amplifies the same way acks do. A
  marker the budget cannot afford therefore CUTS the connection rather than
  being dropped - a client that reconnects cold-resyncs, which is what the
  marker says.

`upgradeRateLimit` meters upgrades PER CLIENT ADDRESS - ten per ten seconds by
default, `0` to disable - on a sliding window, so a client cannot double its
rate by placing requests either side of a boundary. It is checked before the
Origin comparison and before your `upgrade` hook, because the Origin gate bounds
no rate at all (a non-browser client sends whatever Origin it likes) and the
hook is the expensive part. Over the limit is `429` with a `retry-after` naming
the window.

Two things decide whether it means what it says:

- **What counts as one client.** The key is the socket peer unless
  `ADDRESS_HEADER` is set. Behind a reverse proxy, an L4 load balancer, or
  docker's `userland-proxy`, every client arrives as the gateway address and
  this per-client limit is really one GLOBAL cap - the symptom is intermittent
  `429`s on `/ws` under trivial traffic. Set `ADDRESS_HEADER=x-forwarded-for`
  (with `XFF_DEPTH`), or set the limit to `0` if you throttle upstream. The
  server says so once per door, on the first refusal that looks like this -
  including when the header you configured did not arrive on the request, or
  when no client address could be resolved at all.

  **Set `TRUSTED_PROXIES` too.** Without it the header is honoured from
  whoever sends it, so the limiter keys on a value the client chooses: a fresh
  one per request never reaches a limit, and another client's address spends
  theirs. It takes addresses or CIDR ranges, and the server warns at boot if a
  limiter is configured and this is not.
- **IPv6 is keyed on its /64**, not the full address, because a /64 is the
  smallest block a host is routinely given - keying the whole address would let
  one attacker source every request from a fresh one and never share a bucket
  with itself. A 6to4 site is keyed on its /48. Clients behind one /64 (an
  office, a campus, a VPN egress) therefore share a bucket. IPv4, IPv4-mapped
  addresses, NAT64, Teredo and link-local keep their full value, because their
  /64 is shared by clients with nothing to do with each other. A recognised
  address never keeps a port: an `ADDRESS_HEADER` whose proxy writes the peer
  SOCKET rather than the peer host (`1.2.3.4:5678`, `[::ffff:1.2.3.4]:5678`)
  carries a different value per connection, and metering that would meter
  connections rather than clients. A value the address parsers do not
  recognise is never trimmed at all, port included - two spellings of one
  client-supplied string are not two spellings of one client.

A load test from a single machine will be rate-limited, which is the limiter
working. Point it at `upgradeRateLimit: 0`, or give the generator real
addresses.

`upgradeTimeout` bounds the one part of a handshake that can hang: your
`upgrade` hook. It awaits a database, an identity provider or a lock, and while
it waits the handshake is holding an admission slot and a connection permit no
other client can have - so one unreachable dependency turns the ceiling below
into a queue of handshakes that never finish. A hook that outruns the bound is
refused with `504 Gateway Timeout`, its counters are returned, and a value it
produces afterwards is discarded rather than upgrading a client that has already
been told no. Ten seconds by default, in seconds because that is the unit
svelte-adapter-uws declares it in; `0` waits indefinitely. A hook that answers
without a promise never arms a timer at all.

`upgradeAdmission` is separate from all of those: they bound what one
established connection may do, and this bounds whether a connection is
established at all. Every layer is opt-in, and a crossed ceiling answers `503`
with `retry-after: 2` rather than accepting a socket it cannot serve.

- `maxConcurrent` caps handshakes IN FLIGHT. It is checked before the origin
  comparison and before your `upgrade` hook, so a connection storm is shed
  without paying for the work those do - typically a cookie parse and a
  database round-trip. Header parsing is NOT saved here: Bun has already
  parsed them before the adapter is entered, which is a real difference from
  svelte-adapter-uws, where the ceiling sits ahead of that too.
- `maxConnections` caps reserved upgrades PLUS live connections, and the permit
  is held until the socket closes. That is what makes it different from
  `maxConcurrent`, which returns its slot the moment the handshake ends -
  without a lifetime permit, sequential handshakes walk past a live-connection
  ceiling one at a time.
- `perTickBudget` caps upgrades per event-loop tick, so 10K handshakes arriving
  in one I/O batch cannot starve the loop. Work past the budget waits for a
  later tick rather than being refused, and `maxDeferred` bounds how much may
  wait - defaulting to 1024 while pacing is on. The queue is deliberately
  finite: an unbounded one turns a storm into retained closures, which is a leak
  wearing a throttle's clothing.
- `cursorLane` reserves a fraction of `maxConcurrent` for a deprioritised
  cursor-only lane, so a flood of cursor reconnects can never starve ordinary
  WebSocket admission. Omit it and the lane does not exist.

A shed upgrade is not silent. The server says which ceiling refused it, how full
that ceiling was, and which key widens it, throttled so a sustained storm costs a
handful of lines rather than one per refusal. Silence there is the trap: from the
client side a gate doing exactly what it was configured to do is
indistinguishable from an outage, and the quickest thing that makes it stop is
removing the ceiling. A client that hangs up mid-handshake gives its slot and its
permit back at the hang-up rather than when your `upgrade` hook finishes, so a
storm of connect-then-drop clients cannot hold the ceiling closed behind them.

The block is spelled as `svelte-adapter-uws` spells it, with the same defaults
and the same accepted values, so a config moved between the two adapters gates
identically. One key is accepted without being honoured: uws serves a holding
PAGE at a crossed ceiling unless `waitingRoom: false`, and this adapter has no
holding page - it always answers `503`. A config that asks for one builds and
runs, and says at build time that the page will not be served.

Two smaller differences in what a refusal looks like, both of them uws's to
settle: uws omits `retry-after` on a cursor-lane refusal and on every refusal
once the holding page is off, where this adapter always sends it; and uws
reports refusals through its metrics registry rather than the log, so a runbook
built on these lines has no counterpart there until `websocket.metrics` is
supported here.

Every one of these is PER CONNECTION, which is the honest scope and not the same
as per client. A peer that reconnects after being cut gets a fresh budget, so
none of them bounds an attacker who can open sockets in a loop; nothing here
limits connections per IP or handshake rate, and that belongs upstream, in the
load balancer or ingress, the way connection limiting normally does.

`SHUTDOWN_RECONNECT_WINDOW_MS` (default 3000) sets the window over which
draining clients spread their reconnect; 0 closes them immediately with no
advisory. Bun's graceful `server.stop()` does NOT end WebSockets - a probed echo
round-trip still completes afterwards - so the adapter advises and closes them
as an explicit shutdown step. Without that, every client would be cut
simultaneously by `stop(true)` with a 1006 and no chance for close hooks to run.

The uWS-shaped names (`maxBackpressure`, `sendPingsAutomatically`,
`compression`) are kept so one `svelte.config.js` works across the adapter
family; they are renamed to Bun's spelling at boot. Two differences are handled
at build time rather than silently: `idleTimeout` above Bun's hard 960-second
ceiling fails the build with an explanatory error (uWS has no such ceiling, so a
config carried over from svelte-adapter-uws can exceed it), and a numeric uWS
compressor constant translates to on/off with a warning that the specific
compressor tuning was dropped.

`allowedOrigins` defaults to `'same-origin'`, which is a cross-site WebSocket
hijacking defense: upgrades are not subject to the same-origin policy but do
carry cookies, so a page on another origin could otherwise open an authenticated
socket. A request with NO `Origin` header is allowed - the header is only
trustworthy because browsers set it and refuse to let script forge it, so
denying on absence would break non-browser clients while stopping no attack.

**`same-origin` needs `ORIGIN` set to mean anything.** The check compares the
`Origin` header against the server's own origin, and with `ORIGIN` unset that
origin has to be reconstructed from the request - whose `Host` header the client
chose. The comparison is then between two values the same peer supplied, which
still refuses an ordinary cross-origin page but does not survive a deployment
where the host is attacker-controlled (a wildcard or multi-tenant domain, or DNS
rebinding). The adapter warns once on the first upgrade that relies on the
fallback. Set `ORIGIN=https://app.example` in production, or pass an explicit
`allowedOrigins` list.

### Wire protocol

Client to server: `subscribe` (optionally carrying
`recover: { offset, epoch? }` to gap-fill the missed tail before going live),
`unsubscribe`, `subscribe-batch` (each accepts an optional `ref`),
`hello` (`{"caps":[...]}` capability declaration; re-sends replace the set),
`request-n` (flow-control window replenish; the carried `n` is advisory - the
server sizes every window from its own posture),
and `resume` (`{"sessionId","lastSeenSeqs",{"lastSeenEpochs"?}}`).

A `hello` whose caps include `lease` arms flow control on that connection,
FIRST hello only: the server answers `{"type":"lease-ok"}` plus a
`{"type":"lease","count","ttlMs"}` window grant, and re-grants on each
`request-n`. Windows narrow as per-connection subscriber load rises and
always floor, so an opted-in client keeps making forward progress; the
server never gates its own sends on the window - pacing is the client's job,
which is what makes a non-opting old client's behavior byte-identical to
before.

A `subscribe-batch` and a `resume` each name at most **256 topics** - the
batch's entries, and the UNION of the resume's `lastSeenSeqs` and
`lastSeenEpochs` (a topic in both counts once, two disjoint maps of 256 do not
pass). One number for both lanes, so a client needs one chunking rule rather
than two. Over it, the frame is refused WHOLE and nothing is applied.

Chunk by BYTES as well: the 8192-byte control-frame ceiling below bites first
for realistic topic names - a resume naming UUID-shaped topics overflows it at
roughly 150 - and answers `CONTROL_FRAME_TOO_LARGE` instead. The family clients
chunk at 200 topics and 8000 bytes, which clears both.

A `resume` also carries a `sessionId`: 1 to 128 characters of printable ASCII
with no quote or backslash. It is handed to the app's `resume` hook, which
queries a backend with it, so a `sessionId` that is a string but breaks those
rules is refused rather than forwarded. Printable ASCII rather than merely "no
control byte", because the looser rule still admits DEL, the C1 block, the bidi
overrides and U+2028 / U+2029 - which `JSON.stringify` emits raw - and because
over printable ASCII the 128 bound is characters and bytes alike. Server to
client:

| frame | when |
|---|---|
| `{"type":"welcome","sessionId":"..."}` | on open |
| `{"type":"wire-id","topic":"t","id":N}` | the numeric topic id for `0x03` frames, announced on the same socket before the first binary frame for its topic |
| `{"type":"resumed"}` | the `resume` frame's gap-fill RAN and flushed - or the app exports no `resume` hook, so there was nothing to serve; switch to live. Sent only then: every other outcome is an `error` carrying a `code`, so a client that does not receive this must not treat itself as caught up |
| `{"topic":"__replay:t","event":"truncated","data":null}` | the gap-fill for `t` is INCOMPLETE - the buffered window overflowed its cap, or a frame was refused past the backpressure limit. Drop the stored per-topic offset and cold-resync; do not trust the partial flush. A socket that refuses this marker twice is closed with **1013** instead of being acked, since there is no way left to tell it |
| binary `[0x03][schemaVersion:u8][topicId:varint][seq:varint][codec payload]` | a codec frame, for connections that declared the codec's capability in `hello` |
| `{"type":"subscribed","topic":"t","ref":N,"epoch":E}` | a subscription took |
| `{"type":"subscribe-denied","topic":"t","ref":N,"reason":"..."}` | it did not |
| `{"type":"unsubscribed","topic":"t","ref":N}` | released, whether or not it was held |
| `{"type":"unsubscribe-denied","topic":"t","ref":N,"reason":"..."}` | the topic failed wire validation, so the adapter will not claim it was released |
| `{"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":L,"size":N}` | a control frame at or above 8192 BYTES |
| `{"type":"error","code":"BATCH_TOO_LARGE","limit":L,"size":N}` | a `subscribe-batch` carrying more than 256 entries; NONE of them were applied |
| `{"type":"error","code":"RESUME_TOO_LARGE","limit":L,"size":N}` | a `resume` naming more than 256 topics across either of its maps; NO gap-fill ran and no `resumed` follows |
| `{"type":"error","code":"INVALID_SESSION_ID"}` | a `resume` whose `sessionId` was a string but empty, over 128 characters, or carried a byte outside printable ASCII (or a quote or backslash); the value is never echoed back. A frame whose `sessionId` is not a string at all is not recognised as a `resume` and reaches the app's `message` hook like any other unrecognised frame |
| `{"type":"error","code":"RESUME_RATE_LIMITED"}` | this connection already has `maxConcurrentSubscribeGates` (64) hooks in flight, so the `resume` hook never ran and NO gap-fill happened. Transient: retry |
| `{"type":"error","code":"RESUME_FAILED"}` | the app's `resume` hook threw or rejected, so how much of the window it covered is unknown. Retrying does not help; drop the stored per-topic offsets and cold-resync |
| `{"type":"error","code":"CONTROL_FLOOD","limit":B}` | this connection's control-frame budget is spent; the socket is then closed **4429** |
| `{"type":"reconnect","afterMs":N,"windowMs":W}` | shutdown advice, before the drain closes the socket; `afterMs` is omitted when the advice carries no delay |
| `{topic, event, data, seq?, j?}` | the data envelopes. On the PUBLISH lanes `seq` is present unless the call said `{ seq: false }`; the single-target lanes (`send`, `sendTo`, and the JSON fallbacks of `sendWire`/`sendWireBatch`) never carry one and have no seq option, so an absent `seq` does not by itself mean a publisher opted out. `j` is the per-subscriber jitter in ms, present only when `publish` was given `jitterMs` |

Acks are sent only when the client supplied a `ref`; a `ref` over 128 BYTES is
treated as absent. Every subscribe / unsubscribe reply names the topic it
answers for - a denial a client cannot correlate is one it discards, which is
why the frames that answer for no single topic (`BATCH_TOO_LARGE`,
`RESUME_TOO_LARGE`, `INVALID_SESSION_ID`, `RESUME_RATE_LIMITED`,
`RESUME_FAILED`, `CONTROL_FLOOD`) are `error` frames carrying a `code` rather
than denials carrying a null topic.

A `resume` is refused whole rather than truncated to the limit, which matters
more than it does for a batch: a partly-covered gap-fill would still end in
`resumed`, and the client has no gap detection, so it would go live believing
it had caught up on topics the server never read.

The topics a `resume` names are held to the always-illegal bytes, to
`__proto__`, and to the system-topic guard - but NOT to the wire subscribe
lane's `allowNonAsciiTopics` rule. The wire is not the only way a connection
acquires a topic: `platform.subscribe` is the documented server-side spelling
and trusts non-ASCII names past that bound on purpose, so holding a resume to
the stricter rule would drop a topic the app legitimately granted. That refusal
would be SILENT - the topic simply vanishes from the map the hook gap-fills
from, and `resumed` still says go live - which is the hole this machinery
exists to prevent. Refusing must never be stricter than granting, the same
reason the `unsubscribe` lane is permissive.

`resumed` therefore means the hook ran to completion for the topics the frame
was allowed to name. Every other outcome is an `error` carrying a `code` -
`RESUME_TOO_LARGE`, `INVALID_SESSION_ID`, `RESUME_RATE_LIMITED`,
`RESUME_FAILED` - because `resumed` is the only frame a resuming client keys on
and it has no gap detection: an ack that follows no gap-fill tells the client it
caught up on history nobody read. A client that pipelines many frames at
reconnect WILL meet `RESUME_RATE_LIMITED`, so handle it rather than waiting for
an ack that is not coming.

Two limits on that guarantee, both deliberate. Topics the frame named but the
lane refused (an always-illegal byte, `__proto__`, a system topic where
`allowSystemTopicSubscribe` is off) are dropped from the map silently and are
not reported per topic. And a hook that itself calls `platform.send` is
responsible for its own send results: the adapter cannot see that a frame the
hook pushed was refused past the backpressure limit, so a resume hook that
ignores the tri-state can still lose frames under a full socket.

On the `subscribe` + `recover` lane the answer is the marker rather than an
error, because that lane already has the replay channel open and answers per
topic: a hook that throws there emits
`{"topic":"__replay:t","event":"truncated","data":null}` BEFORE the `subscribed`
ack, so the ack never implies a gap-fill that did not happen. That is the same
signal the lane already sends for an overflowed window or a refused gap-fill
frame, and the same one the family clients already act on.

The marker is the one frame on this channel whose delivery is checked, because
the state that produces it - a socket at or over its backpressure limit - is
also the state that refuses it. A refused marker is retried once; if the socket
will not take the retry either, the connection is closed with **1013** rather
than acked, and no `subscribed` follows. The reconnect resumes from the last seq
the client actually received, so the tail it missed is re-delivered. 1013 is
retry-class for the family clients, unlike 1008, which they treat as terminal.

The `resume` hook's RETURN VALUE is the dedup boundary for the gap-fill, so it
is part of the contract rather than an ignored result. Return the highest seq
you actually delivered per topic (`{ [topic]: seq }`, or a bare number for a
single-topic recover).

Report nothing and the boundary falls back to the highest EXPLICIT seq this
server has stamped for the topic, as it stood when the window opened. That
re-delivers most of the window, but it is conservative rather than lossless: a
frame arriving inside the window carrying an OLDER explicit seq than that mark -
a reordered cluster seq - is still deduped away. Reporting what you actually
covered is what makes the boundary exact.

A topic this server has stamped no explicit seq for has no mark at all, which is
not the same as a mark of 0: it dedups nothing, and the whole held window
re-delivers.

**A publish stamps a seq by default.** `platform.publish(topic, event, data)`
with no options draws the per-topic counter, exactly as `{ seq: true }` does,
and svelte-adapter-uws answers the same call the same way - the two adapters
are drop-in replacements, so the same app has to put the same bytes on the
wire under both. `{ seq: false }` is the one spelling that publishes without:
the envelope then omits the field entirely, and the opt-out consumes no
counter value, so the run continues where it left off.

A counter seq is not a MARK: it is a process-local space, it never writes
a value into the authoritative marks above, and only an explicit numeric
seq can raise a resume boundary. It is not entirely inert either, and the
one place it shows is worth knowing about: once an app is past 10,000 marked
topics and the bound is evicting, publishing to a topic that already carries
a mark keeps that mark RECENT, so a bare publish influences which topic keeps
its dedup floor and which loses it. The value never moves; only the eviction
order does. Below the cap the recency is not even recorded, because nothing
can be evicted for it to save the topic from.

**What the 10,000-topic bound evicts.** Both per-topic seq maps - the counters
and the authoritative marks - hold at most 10,000 entries, and a new topic
arriving at a full map evicts one. The policy is second-chance, not LRU: a
topic published to since the eviction last swept past it is spared and moved
to the back of the queue, so a quiet topic is what an eviction reaches for.
One eviction examines a bounded window (`SWEEP_LIMIT`, 32 entries today),
though, and where every entry in that window has been published to recently
there is no quiet topic within reach and the oldest of them is evicted
anyway. An app whose live topic set is genuinely larger than the cap
therefore has ACTIVE topics evicted.

What that costs differs by map, and so does the remedy. Each warns once, on
its own first eviction:

- A lost COUNTER restarts that topic at 1, so a client holding an older seq
  for it sees the number go backwards. This map is fed by every publish that
  neither hands in a number nor opts out with `{ seq: false }`, so publishing
  high-cardinality topics either of those ways keeps them out of it entirely.
- A lost MARK takes the topic's resume dedup floor with it. A resume opening
  while the topic is unmarked has no floor to fall back on and re-delivers
  the whole held window, up to the resume buffer's frame cap - duplicates
  rather than a gap, but the whole window. A later explicit publish re-seeds
  the mark at whatever seq it carries: a floor again, and from a monotone
  authority the damage heals on the next EXPLICIT publish to that topic - a
  bare one stamps the counter and re-seeds nothing - but a lower floor than
  the topic had whenever that seq falls below the lost mark, which is what a
  reordered cluster seq does. Only `{ seq: <number> }` creates a mark, so
  there is no publish-side opt-out here: scoping the topics that carry
  explicit seqs is the only lever.

One publish therefore WRITES A SEQ into at most one of the two maps, and there
are only two guards deciding which: an explicit number goes to the marks,
`{ seq: false }` writes nothing anywhere, and everything else - a bare publish,
`{}`, `{ seq: true }` - draws the counter. Not a list of five shapes but two
tests, which is why a `{ seq: '5' }` that was meant as a cluster seq draws the
counter rather than being refused.

The maps still overlap: a topic published both ways is in both, and the
recency touch described above means "writes no seq into a map" is not the same
as "does not touch it".

An explicit `{ seq: <number> }` must be an INTEGER OF AT LEAST 1. There is no
upper bound - the frame varint carries any magnitude exactly, so snowflake ids
and log sequence numbers past 2^53 are fine - but each of the excluded cases
makes the two wires disagree about one event: `0` is the binary frame's "no seq"
sentinel, so a stamped 0 vanishes for binary subscribers while the envelope
carries `"seq":0`; a negative seq parses back off the wire as a different number
(`-1` arrives as `127`); and a fractional one is truncated on the frame while
the JSON envelope prints it in full. The counter lane and every shipped
authority are 1-based, so a 0-based external source must offset by 1.

One rule the integer check cannot enforce: a topic's explicit seqs must all
come from ONE authority. The mark they advance is monotone - it only ever
moves up - and no number carries the identity of the counter that issued it,
so a single publish stamped from somewhere else (`{ seq: Date.now() }` in a
one-off code path, a second partition's offsets, an upstream counter that
restarted after a redeploy) pins the mark at that value for the life of the
process. Every later resume window on that topic then dedups explicit frames
against a floor from the wrong sequence space, silently. Keep one issuer per
topic; when a topic's seq space must genuinely change, publish under a new
topic name rather than reusing the old one under a new counter.

A seq that breaks the rule THROWS a `TypeError` rather than being absorbed.
Publishing it seq-less instead would degrade the client's resume dedup with
nothing to notice it by, and falling back to the counter would be worse still:
the counter is a different sequence space, so substituting it puts a local value
into the topic's authoritative mark. A batch is refused whole - every per-entry
seq is checked before anything is stamped or sent, so a bad entry cannot leave
the earlier ones already fanned out.

A batch-level `{ seq: <number> }` on `publishWireBatch` throws for the same
reason. One number cannot be the one-seq-per-entry the method publishes, and
stamping all N entries with it is precisely what lets a partial delivery dedup
the whole batch away: the client reports that shared seq as its watermark and
the floor discards every entry at or below it, including the ones it never
received. Put the cluster seq on each entry (`{ data, seq }`), or leave the
seq to the local counter, which already increments per entry - that is what
a batch with no seq option, or with `{ seq: true }`, does. The call is
refused even when the batch is empty, because the seq is a property of the
call rather than of that tick's data.

Only explicit-seq frames are measured against the boundary at all. A counter
frame - the default, and equally `{ seq: true }` - draws from this process's
own per-topic counter, an unrelated space, so it is never deduped and always
flushes, and publishing one does not move the mark a reported boundary is
checked against. A topic published both ways therefore behaves the same as
one published with explicit seqs only.

The reported boundary is trusted only up to the highest seq this server has
stamped for the topic. That bound exists because echoing the client's own
offset straight back is the easiest hook to write and that value is client
input: unbounded, it would let a client suppress precisely the frames the
barrier is holding for it. (`test/fixture/src/ws-handler.js` echoes it on
purpose - it is a controlled test double, not a pattern to copy. Its
`fixture-resume-script` lane is the opposite double, and needs both halves of the
contract to be one: it DELIVERS every frame it publishes into the window at or
below its watermark before reporting it, because what a hook returns is what it
delivered rather than what exists, and it reports a seq this server really
stamped, because the bound above refuses any report on a topic carrying no
explicit mark - which is every topic the rest of that suite publishes to. A
script arms one window and is spent by it.)

A control frame is recognized by its `{"type"` prefix, so a control frame must
put `type` first. Whitespace is stepped over in two bounded runs of 16 - before
the `{` and between it and the first key - so an ordinarily pretty-printed frame
is recognized, while `JSON.stringify(frame, null, 17)` is not. A reordered key
is deliberately NOT recognized: `{"ref":1,"type":"subscribe"}` is legal JSON and
is passed to the app as data, because recognizing it costs 21-27 ns on every
inbound frame against 4.1-4.8 ns for the prefix compare
(`bench/control-frame-prefix.mjs`).

`subscribe-batch` carries at most 256 entries. A batch over that is refused
WHOLE, with one `BATCH_TOO_LARGE` frame and nothing applied, rather than being
partly applied and answered per dropped entry: the reply must not scale with the
inbound frame. An 8 KB frame holds four thousand two-byte entries, and at ~200
bytes per answer a per-entry reply would turn one frame into 800 KB. Every
client in the family chunks at 200 topics and 8000 bytes to stay under this, so
none of them can reach the refusal.

Within the limit the batch is answered PER ENTRY, which is an amplifier and
deliberately so - the family client keys its denial store and its per-topic
epochs off those frames and re-subscribes everything as a batch on reconnect, so
collapsing them loses every denial and degrades resume. What that costs is
bounded twice over, and `bench/control-egress.mjs` measures both: no batch frame
can be answered with more than 256 frames (48 KB at the worst shape, 256
one-character entries with a maximal ref; roughly 17 KB for a full batch of
ordinary topic names that all install), and the ACK CHANNEL as a whole gets
4 MB per 10 s per connection
(`maxControlEgressBytes`) - 86 of those worst-shaped frames - after which the
connection is closed with `CONTROL_FLOOD` and close code 4429. 4429 rather than
1008 because the family clients treat 1008 as terminal and stop reconnecting for
good, while 4429 is their throttle code.

A control-shaped frame at or above 8192 BYTES is refused with
`CONTROL_FRAME_TOO_LARGE`; an oversized frame that merely *begins* `{"type"` but
carries a type the adapter does not consume is passed to the app hook untouched
rather than swallowed.

The WebSocket handler is bundled by Rollup from project source, with SvelteKit's
`$lib` alias resolved. There is no esbuild fallback, so the handler must be
plain JavaScript resolvable by that plugin set.

## Static files

A static path with a dot-prefixed segment (`/.env`, `/deep/.hidden`,
anything under `/.git/`) is left out of the static index and answers `404`.
The files that land in `static/` by accident are exactly the sensitive ones -
a stray `.env`, an `.htpasswd`, editor backups, an unpacked `.git` - and
`adapter-node` refuses plain dotfiles too, so an app migrating from it keeps
that posture. The exclusion is segment-wise and decided once while the index
is built: there is no per-request check to bypass. An encoded request
(`/%2Eenv`) reaches nothing either - the static lane looks the raw
pathname up as a Map key and never decodes it, and the decoded spelling
was never a key. A refused directory is not descended into, so an
unpacked `.git` is never even read.

A top-level `.well-known/` keeps serving its ordinary files - RFC 8615
discovery (`security.txt`, ACME HTTP-01 challenges) is documented served
behavior. The carve-out is narrow in both directions: it applies at the
FIRST path segment only, so `x/.well-known/y` is not an escape hatch, and
it exempts the segment itself rather than the tree under it, so a dotfile
inside `.well-known/` is still refused.

The build warning names each refused path once - a refused directory is a
single entry, and a compressed `.br`/`.gz` sibling is covered by naming its
source file - so the mistake surfaces at build time instead of as a
production `404`. To serve dotfiles deliberately:

```js
adapter: bunserve({
	staticDotfiles: true // index and serve every dotfile
})
```

Everything above is the PRODUCTION server. Dev and preview serve `static/`
through SvelteKit's own pipeline, which never reads `staticDotfiles` - and
the two do not even agree with each other: `vite preview` refuses
dotfiles, while `vite dev` serves them (its static middleware runs with
sirv's dotfile filter off). So a dotfile you can fetch in dev is not
evidence the built server will serve it. svelte-adapter-uws applies the
same production rule and spells the option the same way.

## Versions at boot

A built server logs its resolved identity while it boots, before the line
announcing what it is listening on:

```
svelte-adapter-bunserve 0.0.1 (protocol rev 1, svelte-realtime 0.4.2, svelte-adapter-uws-extensions not installed)
```

Everything on that line is read at runtime, never inlined at build time: the
adapter's own version and the protocol revision come from the exact
`package.json` and `protocol.schema.json` the build copied into
`build/meta/`, and each sibling version is what `import.meta.resolve` actually
finds next to the app - what is deployed, not what was declared. When two
surfaces disagree at runtime, compare these versions first: partial upgrades
and registry cooldowns are the usual real-world cause. The schema itself ships
in the package as `protocol.schema.json` (the family contract's vendored copy,
held byte-identical to svelte-adapter-uws's by the parity gate).

## Environment variables

Read by the built server at boot, not at build time. The `envPrefix` adapter
option prefixes every name below, so `envPrefix: 'MY_'` makes the port
`MY_PORT`; the server warns when it sees an unprefixed name it would otherwise
have read, since that is a variable someone expected to take effect.

| variable | default | what it does |
|---|---|---|
| `HOST` | `0.0.0.0` | listen address |
| `PORT` | `3000` | listen port |
| `ORIGIN` | unset | the public origin, e.g. `https://example.com`. Set it behind a proxy so redirects and the CSRF check use the address clients actually used |
| `PROTOCOL_HEADER` | unset | header carrying the client's protocol, e.g. `x-forwarded-proto` |
| `HOST_HEADER` | unset | header carrying the client's host, e.g. `x-forwarded-host` |
| `PORT_HEADER` | unset | header carrying the client's port |
| `ADDRESS_HEADER` | unset | header carrying the client address, e.g. `x-forwarded-for` |
| `XFF_DEPTH` | `1` | which entry of the forwarded chain to trust, counted from the right - `1` is the rightmost, the address your nearest proxy appended. Read only when `ADDRESS_HEADER` is set; a value that cannot select a hop throws at boot where it would be read, and warns where it would not |
| `TRUSTED_PROXIES` | unset | comma-separated IPs and CIDR ranges, IPv4 and IPv6. When set, an address claim is honoured only from a peer in this set, and one from anywhere else is ignored in favour of the socket address, once with a warning. Unset trusts the header verbatim |
| `BODY_SIZE_LIMIT` | `512K` | largest request body accepted, with `K`/`M`/`G` suffixes and an optional trailing `B`. `0` disables the cap; a negative or non-finite value such as `Infinity` is refused rather than read as "no limit" |
| `IDLE_TIMEOUT` | `120` | seconds a connection may go idle before Bun closes it. See Timeouts |
| `SHUTDOWN_TIMEOUT` | `30` | seconds to wait for in-flight work during a graceful shutdown before closing anyway |
| `SHUTDOWN_DELAY_MS` | `0` | milliseconds to keep serving after the signal arrives, so a load balancer notices the readiness 503 before connections are cut |
| `SHUTDOWN_RECONNECT_WINDOW_MS` | `3000` | the window advertised in the `reconnect` frame sent to WebSocket clients before the drain closes them |
| `SSL_CERT` | unset | path to a TLS certificate. TLS is enabled only when both this and `SSL_KEY` are set |
| `SSL_KEY` | unset | path to the matching TLS private key |

`PROTOCOL_HEADER`, `HOST_HEADER` and `PORT_HEADER` are trusted as given. Set
them only behind a proxy that overwrites those headers on every request;
otherwise a client can choose its own origin by sending them.

`CLUSTER_WORKERS` is accepted and ignored, with a warning naming it. This
adapter runs single-process on purpose: multi-node scale-out rides the
transport-agnostic extensions bus rather than in-process clustering. Bun's
`node:cluster` does share a listening socket across workers, but a `publish()`
reaches only the subscribers held by the worker that ran it, and a
`SharedArrayBuffer` sent over IPC arrives as a dead copy - so workers would each
serve a private slice of every topic, which is worse than one process.

## Timeouts

`IDLE_TIMEOUT` is the number of seconds a connection may go idle before Bun
closes it. It defaults to **120**, and the adapter sets it explicitly rather
than inheriting Bun's own default of roughly 10 seconds.

That is not a preference. A quiet RESPONSE counts as idle, so Bun's default
severs a stream that pauses for longer than it - measured, an unset timeout
delivers a stream that pauses for 2s and cuts one that pauses for 12s
(`probe/bun-api-facts.report.md`, `http-idle-timeout` section). An SSE endpoint
whose heartbeat is slower than 10 seconds would therefore be disconnected
mid-stream, with nothing the app can catch. 120 clears every ordinary heartbeat
interval while still bounding how long a silent connection holds a socket.

Set `IDLE_TIMEOUT=0` to disable it entirely (also measured), accepting that a
connection which goes silent is then held indefinitely. Bun refuses anything
above 255, so the adapter refuses it first, at boot, with a message naming the
variable - a value outside the range is an error rather than a silent fallback
to a timeout nobody chose.

WebSocket connections are governed separately, by `websocket.idleTimeout` in the
adapter options (Bun caps that one at 960).

## Development

Requires [Bun](https://bun.com) installed. The supported floor is **Bun 1.3.14**
(`engines.bun`), which is also the version the committed probe report was
generated against. CI runs every gate on both Bun generations - 1.3.14 and 1.4.0 - because 1.4
changed several behaviours this adapter reads: the API probe, the live and leak
suites, the unit and sim lanes (one process per file, via
`scripts/bun-test-lane.mjs`), both golden corpora and the determinism scan. The
corpora are blessed under Node and must match fingerprint-for-fingerprint under
Bun, which makes that gate a cross-engine determinism check rather than a
pass/fail. After upgrading Bun, re-run the probe and review the report diff
before trusting the upgrade.

```sh
bun run probe   # runs the API probe and writes probe/bun-api-facts.report.md
```

The probe report is committed alongside the script; a Bun upgrade that changes
an observed behavior shows up as a report diff, not a silent breakage.

The test fixture app builds with this adapter (and, for benchmarks, with
svelte-adapter-uws and @sveltejs/adapter-node against the same routes):

```sh
cd test/fixture
npm install
npm run build          # ADAPTER=uws / ADAPTER=node for the A/B variants
bun build/index.js     # serve the bunserve build
node ../../bench/http-bench.mjs http://127.0.0.1:3000/ 32 8
```

The WebSocket tier line ("Bun, natively" vs uws's "maximum performance") is a
performance statement, never a capability statement, and the numbers behind it
come from three benches, run pairwise against svelte-adapter-uws's own bench
server with one shared client and workload:

```sh
bun bench/ws-fanout-bunserve.mjs           # this side; the uws side is
                                           # node <uws>/bench/24-ws-adapter-uws.mjs
bun bench/ws-fanout-client.mjs 200 8       # same client against either server
bun bench/idle-rss.mjs --cmd "bun bench/ws-fanout-bunserve.mjs" --clients 1000
bun bench/lease-engagement.mjs             # flow control against the REAL built server
```

Measured on one Windows x64 dev machine (Bun 1.3.14, Node 24; relative
figures are the point, absolute ones will differ elsewhere):

| workload | `svelte-adapter-bunserve` | `svelte-adapter-uws` |
|---|---|---|
| fan-out, 50 subscribers, 10 senders | 1.97M msg/s delivered (50.0x) | 1.95M msg/s delivered (50.0x) |
| fan-out, 200 subscribers, 10 senders | 2.53M msg/s delivered (200.0x) | 2.38M msg/s delivered (200.0x) |
| idle memory, 1000 held sockets | +2.5 KB/socket (62.5 MB baseline) | +2.4 KB/socket (108.7 MB baseline) |

At 50 subscribers both sides deliver the senders' full output at a perfect
fan-out ratio - the client, not either server, is the bottleneck - so the
honest reading is parity-class throughput, not a ranking. The fan-out pair
measures transport against transport (both bench servers are floors without
the adapters' gates and counters); the adapter's own per-publish pressure
bookkeeping is measured separately by `bench/publish-bump-micro.mjs`:
6.5 ns/publish on the recorded run, beside a 49 ns envelope build and the
native fan-out a real publish also pays - the same bookkeeping the sibling
performs on its own publish lanes. The flow-control
engagement proof is its own bench, not an estimate: a slow consumer opting
into the `lease` capability against the real built server sees exactly one
`lease-ok`, a full 256-permit window per grant on an unloaded server, one
`request-n` per low-water window, and its whole paced backlog delivered
(2000 sends through 8 windows in the recorded run). That bench is also what
caught the engine's idle heap ratio collapsing those windows to a sixteenth
of the base before `grantSizeFor` stopped feeding it into the sizing math.

The unit suite covers the pure decision modules (range parsing, content
negotiation, path canonicalization, proxy trust, header validation) and runs
under Node, not Bun. It also covers the WebSocket demux and the authorization
gate, which reach the app through a specifier the build injects: a loader hook
(`test/helpers/ws-handler-loader.mjs`) resolves that specifier to a stub, so
`handler/ws.js` and `handler/platform.js` can be driven without a build. Put
frame-shape and hook-contract assertions there - it is the fast lane:

```sh
npm test   # requires Node 22+ for the test-runner glob
```

`test/unit/io-budget.test.mjs` is the performance gate in that lane, and
`test/unit/http-io-budget.test.mjs` is its HTTP twin: per-response operation
counts for the static lane (Headers and Response constructions, `Bun.file`
opens, pathname decodes), each pinned exactly. Both count OPERATIONS - encode
calls, native publishes, socket writes - and never measure time, because a
wall-clock assertion cannot gate CI: it fails on a busy runner, gets retried
until green, and is then ignored.

The two scale differently, and each shape catches what the other cannot. The
fan-out gate grows the INPUT - connections, or entries in a batch: "6x the
input must not increase the count of X", which is what catches a lost
encode-once or a fan-out that quietly became a per-connection walk. The HTTP
gate repeats a request 200 times and requires each counting budget to come out
at exactly 200 times its per-response value. That is what catches a cost which
is amortized rather than absent: a disk touch taken every 64th request, or a
second header build once an entry has been served forty times, hides completely
inside a short window and is exactly the shape a cache or pool regression
takes. The decode budgets are the inverse, and the reason the repetition is not
always of an identical request: what they require is that a SECOND sighting of
a path, and two hundred distinct unencoded ones, add no decodes at all.

Every budget that can be stated at scale is. The four exceptions are all one
shape - a FIRST decode, measured once because a first sighting happens once:
a malformed path, a fresh one, the fresh one that overflows the cache, and the
entry that overflow evicted, decoding again on its next sighting. The file ends
with a self-check aimed at work that genuinely scales, so the gates cannot pass
vacuously.

Lowering a budget needs no discussion. RAISING one is a design decision - it
says the adapter now does more I/O per unit of work - so record the reason in
the comment on that budget, in the same change that raises it.

The live lane asserts the same contract end to end against a real server, which
is what catches everything the stub cannot model: it first drives the real send
facade over a genuinely saturated Bun socket (the send-result suite, which
needs no build), then builds the fixture, boots the built output under Bun, and
drives real WebSocket clients against it. It covers the send-result mapping
against a real slow consumer, the subscribe, batch, and unsubscribe frames, the
subscription cap under pipelined frames, Origin enforcement on the upgrade, the
binary wire tier (announce, stateful codec frames, the cohort split, and both
resume paths), the graceful-shutdown signal path (Linux only; the suite skips
on Windows), and a no-handler build proving the HTTP surface is untouched when
no realtime is configured. It needs
Bun and the fixture's dependencies (`npm install` in `test/fixture` once;
`ADAPTER=uws` imports a sibling checkout by path and is not a dependency, so a
plain clone installs):

```sh
npm run test:live   # builds test/fixture twice and runs the suites in test/live/
```

The leak lane asks a question none of the others can: does serving for a while
make the process grow? It boots the built fixture, drives it at a fixed rate,
and applies five independent gates - retained memory across the run, the
footprint's trend, error rate, p95 latency creep, and connections still
registered after every client has closed.

Two of those deserve their reasoning stated, because the obvious version of
each is wrong. Retention is measured after forcing the collector until it
SETTLES: one forced collection is not settled, and comparing single readings
made a healthy run's growth swing between +7.5% and +67.6%. It counts heap plus
external, since a typed array lives outside the JS heap and most of what a
server retains is buffers. The footprint is measured as a least-squares slope
gated on an r-squared floor, so a runner whose memory merely wanders produces
no fit and cannot fail the build - and its thresholds are set to catch runaway
rather than to be precise, because RSS under Bun's allocator climbs toward a
working-set plateau that looks exactly like a leak over a short window.

It ends with a self-check that arms a deliberate leak in the fixture and
requires the verdict to fail. A gate never observed failing cannot be told
apart from one that is unable to.

It has its own CI job and is not part of `npm run test:live`, because it spends
minutes by design and a gate that slow in the dev loop is one people stop
running.

```sh
npm run test:leak                      # two scenarios plus the self-check
LEAK_SCENARIO=ws npm run test:leak     # one scenario, for investigating a trend
LEAK_DURATION_MS=240000 npm run test:leak   # a longer window settles a plateau question
LEAK_RESETTLE_MS=0 npm run test:leak   # start sampling straight off the baseline collection
```

A window that cannot hold at least eight samples at the configured cadence is
refused before the fixture is built, rather than run and then reported as
having measured nothing.

The deterministic simulation drives the REAL handler dispatch - the same
modules a built server runs - over an in-memory Bun.serve double, a virtual
clock, and a seeded fault engine (`src/sim.js`; every clock, RNG and timer
read in the runtime goes through `src/runtime/runtime.js`, enforced by
`npm run check:determinism`). A seed reproduces its interleaving bit-for-bit,
and the committed golden corpora (`test/dst-goldens/`, verified in CI by
`npm run sim:golden`) pin forty seeds' structural fingerprints each.

`adapter-single` is the cross-adapter corpus: its fingerprints are identical to
svelte-adapter-uws's own committed corpus at the parity pin, checked locally
with

```
node scripts/sim-golden.js --corpus adapter-single \
  --against ../svelte-adapter-uws/test/dst-goldens/adapter-single.golden.json
```

Identical golden traces are the positioning guard: the tier line stays a
performance statement, never a capability statement. Nothing adapter-specific
belongs in that corpus, which is why there is a second one.

`adapter-admission` runs a server with all four `upgradeAdmission` layers
configured at once, an app that refuses sockets from inside its `open` hook, and
clients that leave while the app's `upgrade` hook still has them. Every refusal
reason the ceiling can give is given by some seed. Each corpus names the server it runs
against, and that server is built once when the runtime is imported - so one
process verifies one corpus, and `npm run sim:golden` is two invocations rather
than a loop. Select one with `--corpus <name>`; an unrecognised name is refused
rather than defaulted.

A change that deliberately moves a fingerprint is blessed with
`node scripts/sim-golden.js --update`, and the corpus diff is the reviewable
record of what moved. The corpus records the commit it was blessed from,
because a seed without one is half a bug report. Blessing while any TRACKED
file differs from `HEAD` records that commit with a `-dirty` suffix, which is
the usual outcome and not a problem to fix: it means the fingerprints came from
that commit's working tree, and the source diff sitting beside the corpus diff
is the other half. Untracked files are not counted, and neither is the corpus
itself. Set `GIT_COMMIT` to record a full sha directly instead, which is what a
CI job that already knows its checkout would do.

The publishing surface has its own gate, run in CI on every push:

```sh
npm run check:publish   # publint + attw against the packed package
```

It lints what `npm pack` would actually ship - the export map, the file list,
and whether each export subpath resolves for an ESM consumer. These are the
failure modes that pass every local test and break only inside a consumer's
node_modules.

## License

[MIT](LICENSE)
