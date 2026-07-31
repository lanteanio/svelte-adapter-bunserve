# svelte-adapter-bunserve

> **Status: pre-alpha prototype. Nothing here is usable yet. Do not install.**

A SvelteKit adapter for [Bun](https://bun.com), built on `Bun.serve`: it follows
[svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws) and works
with the same ecosystem around it -
[svelte-realtime](https://github.com/lanteanio/svelte-realtime) for the client
stores and
[svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions)
for clustering, presence and cursors. Same `platform.*` surface, same plugins,
same client. The adapter swap is one line in `svelte.config.js`; app code is
unchanged.

(One caveat while this is pre-alpha: the extensions package does not work
against this adapter yet - see [Current state](#current-state).)

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

Prototype phase. The build order:

1. **API probe** (done): `probe/bun-api-facts.mjs` empirically verifies every
   Bun server API behavior the adapter design relies on - send-result
   semantics, backpressure signals, closed-socket behavior, upgrade flow,
   drain semantics - against a pinned Bun version, and writes a committed
   facts report. No adapter code is written from documentation memory.
2. **HTTP half** (done, this is where the repo is now): a built SvelteKit app
   serves under `bun build/index.js`. SSR goes straight through
   `server.respond()` (real web Request in, Response out, Bun's own
   backpressure on streams); static assets come from an in-memory
   precompressed cache with ETag/304, RFC 7233 ranges, and trailing-slash
   canonicalization, with a `Bun.file()` kernel-sendfile lane for large files;
   SSR dedup and the BREACH-aware compression gate are carried over, and a
   response is compressed whole whenever its body completes without waiting,
   so a streaming render reaches the client as it is produced; `/healthz` +
   `/readyz` and graceful drain round it out.
   Known-open on this slice: the graceful-drain signal path is UNVERIFIED
   (Windows delivers no real SIGTERM to exercise it; the Linux CI slice will);
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
   Known-open on this slice: the binary wire protocol (`0x03` frames, codecs,
   cohort split, resume/seq buffers) and the pressure/protection surface are
   not implemented - those members are ABSENT from the platform rather than
   stubbed, so nothing reports success while doing nothing. `platform.request`
   (server-initiated request/reply) and the coalescing send variants are
   likewise still to come.
4. Binary wire protocol.
5. Backpressure/flow-control parity, then the conformance gate against the
   family's deterministic simulation goldens.

Single-process at launch; a multi-process mode is planned.

**Multi-node fan-out does not work yet.**
[svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions)
(Redis/Valkey) is transport-agnostic and is the intended path, but its
`bus.wrap(platform)` binds four members this adapter does not implement yet
(`sendCoalesced`, `request`, `onPressure`, `onPublishRate`) without
feature-detecting them, so it throws a `TypeError` at startup against this
adapter. It needs either those members (slices 4 and 5 above) or the same
guards it already applies to its other optional members. Until one of those
lands, treat this adapter as single-node.

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
by client data. A returned `headers` key is now ordinary userData, and the
adapter warns once if it sees one.

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
| `publish(topic, event, data, options?)` | topic fan-out; `{ seq, jitterMs, compress }` |
| `send(ws, topic, event, data, options?)` | one connection; returns 0 enqueued / 1 sent / 2 dropped |
| `sendTo(filter, topic, event, data, options?)` | filtered fan-out; the filter MUST be synchronous |
| `subscribe(ws, topic, options?)` | server-side subscribe THROUGH the authorization hook; `null` on success, else a reason: `INVALID_TOPIC`, `SUBSCRIBE_NOT_CONFIGURED`, `INTERNAL_ERROR`, `FORBIDDEN` (what a hook returning `false` becomes), `RATE_LIMITED`, `CANCELLED`, `CLOSED`, or the hook's own string |
| `checkSubscribe(ws, topic, options?)` | run the hook without subscribing; the same reasons except the last three, which only an install can produce |
| `unsubscribe(ws, topic)` | unsubscribe and keep bookkeeping in step |
| `adviseReconnect(options?)` | jittered reconnect advice, then drain |
| `connections` / `subscribers(topic)` / `forEachSubscriber(topic, fn)` | live counts and the per-subscriber walk |
| `totalSubscriptions` / `publishCount` | instance-wide subscription total, and publishes since boot |
| `maxPayloadLength` / `bufferedAmount(ws)` / `closedWsAborts` | limits and backpressure telemetry |
| `topic(name)` | scoped publisher: `platform.topic('chat').created(data)` |
| `requestId` | per-connection / per-request identity |
| `now()` / `monotonic()` / `random.float()` `.u32()` `.uuid()` `.bytes(n)` | determinism seams |

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

### Options

```js
adapter: bunserve({
	websocketPath: '/ws',                 // default
	websocketHandler: 'src/ws-handler.js',// default
	websocket: {
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
		maxControlEgressBytes: 4 * 1024 * 1024
	}
})
```

The last five are per-connection bounds this adapter enforces itself, and they
are different jobs rather than different sizes of the same one:

- `maxSubscriptionsPerConnection` bounds what can INSTALL. It counts installed
  plus DISTINCT pending topics, because N concurrent subscribes to one topic can
  only ever install one subscription - counting them N times denied requests
  that were not over any real limit.
- `maxConcurrentSubscribeGates` bounds concurrent APP WORK in the SUBSCRIBE
  gate: the `subscribe` / `subscribeBatch` hook, counted for as long as each
  call is suspended. That is where an app does its database round-trip, and
  distinct-topic counting cannot bound it - N concurrent gates for one topic
  cost 1 against the cap above. Exceeding it denies the subscribe with
  `RATE_LIMITED`. It does NOT cover `platform.checkSubscribe`, which the app
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
  records at most 2176 topics owed a teardown, which no amount of ordinary
  concurrency reaches, but a hook failing over and over on one connection can.
  Past that the release is not recorded, the adapter says so once, and
  `platform.droppedReleaseRecords` counts it.) The
  cost is that a hook which was mid-await when the connection died can finish
  AND have its topic named there, so a teardown that is not idempotent (a bare
  `roster.decr(topic)`) can run twice. The alternative is dropping the release
  whenever the two race, which leaks silently; running it twice is the failure
  an app can defend against. A speculative release carries no promise at all,
  because recording those would let a client grow the record by naming topics it
  never had.
- `maxControlEgressBytes` bounds the ACK CHANNEL, in bytes per 10 s. Exceeding
  it closes the connection with `CONTROL_FLOOD` and code 4429.

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

Client to server: `subscribe`, `unsubscribe`, `subscribe-batch` (each accepts an
optional `ref`). Server to client:

| frame | when |
|---|---|
| `{"type":"welcome","sessionId":"..."}` | on open |
| `{"type":"subscribed","topic":"t","ref":N,"epoch":E}` | a subscription took |
| `{"type":"subscribe-denied","topic":"t","ref":N,"reason":"..."}` | it did not |
| `{"type":"unsubscribed","topic":"t","ref":N}` | released, whether or not it was held |
| `{"type":"unsubscribe-denied","topic":"t","ref":N,"reason":"..."}` | the topic failed wire validation, so the adapter will not claim it was released |
| `{"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":L,"size":N}` | a control frame at or above 8192 BYTES |
| `{"type":"error","code":"BATCH_TOO_LARGE","limit":L,"size":N}` | a `subscribe-batch` carrying more than 256 entries; NONE of them were applied |
| `{"type":"error","code":"CONTROL_FLOOD","limit":B}` | this connection's control-frame budget is spent; the socket is then closed **4429** |
| `{"type":"reconnect","afterMs":N,"windowMs":W}` | shutdown advice, before the drain closes the socket; `afterMs` is omitted when the advice carries no delay |
| `{topic, event, data, seq?, j?}` | the data envelopes; `j` is the per-subscriber jitter in ms, present only when `publish` was given `jitterMs` |

Acks are sent only when the client supplied a `ref`; a `ref` over 128 BYTES is
treated as absent. Every subscribe / unsubscribe reply names the topic it
answers for - a denial a client cannot correlate is one it discards, which is
why the two frames that answer for no single topic (`BATCH_TOO_LARGE`,
`CONTROL_FLOOD`) are `error` frames carrying a `code` rather than denials
carrying a null topic.

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
inbound frame. An 8 KB frame holds four thousand two-byte entries, and answering
each one cost ~200 bytes, so the old shape turned one frame into 800 KB. Every
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

## Development

Requires [Bun](https://bun.com) installed. Current facts baseline: **Bun
1.3.14** (the version the committed probe report was generated against). After
upgrading Bun, re-run the probe and review the report diff before trusting the
upgrade.

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

The unit suite covers the pure decision modules (range parsing, content
negotiation, path canonicalization, proxy trust, header validation) and runs
under Node, not Bun:

```sh
npm test   # requires Node 22+ for the test-runner glob
```

The live lane asserts the WebSocket wire contract end to end, which the unit
suite cannot: it builds the fixture, boots the built output under Bun, and
drives real WebSocket clients against it. It covers the subscribe, batch, and
unsubscribe frames, the subscription cap under pipelined frames, Origin
enforcement on the upgrade, and a no-handler build proving the HTTP surface is
untouched when no realtime is configured. It needs Bun and the fixture's
dependencies (`npm install` in `test/fixture` once; the `ADAPTER=uws` A/B
variant resolves from a sibling checkout and is optional, so a plain clone
installs):

```sh
npm run test:live   # builds test/fixture twice and runs the suites in test/live/
```

## License

[MIT](LICENSE)
