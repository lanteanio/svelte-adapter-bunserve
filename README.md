# svelte-adapter-bunserve

A SvelteKit adapter for [Bun](https://bun.com), built on `Bun.serve`: it follows
[svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws) and works
with the same ecosystem around it -
[svelte-realtime](https://github.com/lanteanio/svelte-realtime) for the client
stores and
[svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions)
for clustering, presence and cursors. Same `platform.*` surface, same plugins,
same client. The adapter swap is one line in `svelte.config.js`; app code is
unchanged.

The bundled [`./client` entrypoint](#client-store-api) also provides topic stores,
automatic reconnection, and reversible offline controls directly.

`platform.authorizeDelivery` installs an optional recipient policy for application
deliveries, with ordered pending decisions, revocation checks, bounded buffering
and graceful shutdown. See [delivery authorization](docs/delivery-authorization.md).

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
| `svelte-adapter-ws` | node:http + ws | maximum portability |
| `svelte-adapter-bunserve` (this repo) | Bun.serve | Bun, natively |

The suffix names the transport, like every member of the family: `uws` is
uWebSockets.js, `ws` is the ws library, `bunserve` is `Bun.serve`.

## Runtime model

A built SvelteKit application runs with `bun build/index.js`. HTTP responses
use web Requests and Responses with Bun's stream backpressure. Static files
support precompression, validators and conditional requests. Immutable assets
use their content-addressed URL as the cache identity; they omit ETags and
byte ranges while retaining wildcard existence preconditions.

WebSocket hooks expose JSON topic messaging, binary wire codecs, subscription
recovery, pressure sampling and flow control. The API probe, unit tests,
deterministic simulations, native socket tests and leak tests exercise these
contracts against the supported Bun runtimes.

Each server process owns its subscriptions. A native topic publication reaches
that process's connections, so sharing a listening socket across workers does
not provide cross-worker fan-out. Applications that distribute connections
across processes need a bus that forwards publications between them.

`svelte-adapter-uws-extensions@0.6.0-next.64` supports this through
`createPubSubBus` from its `redis/pubsub` entry. Activate the bus with the local
platform, then publish through `bus.wrap(platform)` to deliver locally and
through Redis to the other processes. Each process needs its own activated
subscriber and must call `bus.deactivate()` during shutdown. The wrapper
preserves the platform's live getters and available methods.

An HTTP response stream that fails after its first bytes closes the connection
without a complete chunked terminator. Source errors and invalid response chunks
therefore remain visible as truncated responses; invalid producers are cancelled
and their readers released. `test/live/response-stream-failure-check.mjs` pins the
raw TCP failure boundary on supported Bun runtimes.

## Smoothing controls

`createSmoothAuthority({ maxCommandsPerTick })` limits the commands applied to
one entity during one tick. It must be a positive safe integer. Omit it to drain
the entire available queue. A bounded drain preserves the ordered tail and
acknowledges only the applied prefix; `inject()` remains unpaced.

The client's `snapSpeedPerSec` also governs local authoritative corrections.
With `'auto'`, correction speed over `smoothTimeMs` is compared with eight times
the peak of the last 32 tick-like command intervals. Before two measured intervals
exist, only an explicit numeric ceiling applies. A numeric value adds a world-units-
per-second ceiling; `0` disables both automatic and numeric speed checks.
Snapping clears old rendering offsets while preserving unacknowledged command
replay. Full sync and reset clear the measured history.

## Operational events

Use the public observability entry to route structured runtime events to your
logging system. Register the sink during application initialization:

```js
import { setOperationalEventSink } from 'svelte-adapter-bunserve/observability';

setOperationalEventSink((event) => {
  logger.write(event);
});
```

Pass `null` to restore the console fallback. Events retain package identity,
severity and bounded diagnostic attributes. Treat application diagnostic text
according to your logging policy; identifier metadata does not expose raw topics.
See [the signal and diagnostic contract](docs/observability.md).

## Outbound URL policy

The `svelte-adapter-bunserve/safe-url` entry validates outbound HTTP destinations
before connecting. `classifyAddress` classifies addresses; `checkUrlResolved`
checks the URL and every address returned by the supplied `resolve` callback. Resolve and validate every destination and redirect,
then pin the validated address in the transport so a second DNS lookup cannot
change it. The policy's resolver can supply your deployment's DNS implementation,
and `nat64Prefix` identifies a deployment-specific NAT64 translation prefix.
The default `strict` mode refuses private and special-purpose destinations.
`allowlist` also requires a hostname in `allow`, while retaining address checks.
`off` explicitly disables address checks but still requires HTTP or HTTPS.

## TypeScript

The package ships root declarations for the adapter and its `AdapterOptions`,
`WebSocketOptions`, `WebSocketHandler`, hook contexts and `Platform` contracts.
Import these types from `svelte-adapter-bunserve`. Every public export ships declarations.
`UpgradeContext.traceContext` accepts the shared nullable trace-context shape;
this runtime supplies `null`.

Extend SvelteKit's application platform type in `src/app.d.ts`:

```ts
import type { Platform as RealtimePlatform } from 'svelte-adapter-bunserve';

declare global {
	namespace App {
		interface Platform extends RealtimePlatform {}
	}
}
export {};
```

The socket passed to WebSocket hooks exposes `publish(topic, message, isBinary?,
compress?)` with a boolean result. `true` means a publication has an eligible peer;
it does not guarantee delivery past that peer's backpressure limit. The publishing
socket is excluded, including for empty text or binary frames. A socket that has
released all its subscriptions can still publish to its peers. A socket that has
never subscribed returns `false` without publishing. `send()`
continues to return its numeric status: 0 buffered, 1 sent, or 2 dropped.

## WebSockets

Enable WebSockets in the SvelteKit adapter configuration:

```js
import bunserve from 'svelte-adapter-bunserve';
export default { kit: { adapter: bunserve({ websocket: true }) } };
```

Add the plugin to Vite so WebSocket hooks and server routes
share the same module instances, including `$lib` state and Vite transforms:

```js
import { sveltekit } from '@sveltejs/kit/vite';
import bunserve from 'svelte-adapter-bunserve/vite';
export default { plugins: [sveltekit(), bunserve()] };
```

With WebSockets enabled, the build discovers `src/hooks.ws.js`,
`src/hooks.ws.ts`, then `src/hooks.ws.mjs`. An explicit `websocket.handler`
wins. The Vite plugin uses that same option and resolves configured aliases;
conflicting explicit paths fail the build. The plugin runs a WebSocket server
during `vite dev` and adds the production SSR entry during builds. It inherits
`websocket.path`, `websocket.authPath` and `envPrefix` from the adapter. Explicit
plugin endpoint paths must agree with adapter paths. Security options such as
`allowedOrigins` and `authorizeWireSubscribe` are flat plugin options; repeat
them on the plugin when development must enforce the same policy.

Omitting `websocket` or setting it to `false` disables the built endpoint, even when a
hooks file exists. Set it to `true` or an options object to enable it. With no
hooks file, the built-in subscription protocol still runs; subscriptions are
allowed unless wire-subscribe authorization is armed.

The old `src/ws-handler.js` filename is no longer discovered. Rename it to
`src/hooks.ws.js` and enable `websocket: true`, or keep the file and configure
`websocket: { handler: 'src/ws-handler.js' }` explicitly.

A configured handler that cannot resolve fails the build. Missing relative
`./` or `../` paths produce an error naming the file; other specifiers reach the
bundler resolver, so another Vite plugin may supply a virtual module. To disable
WebSockets, omit `websocket` or use `false` instead of a nonexistent handler.

The endpoint takes a GET that tries to open a WebSocket - one carrying
`Upgrade: websocket` or a `Sec-WebSocket-Key` - and nothing else, as on
svelte-adapter-uws. One that no client could complete is refused before any
capacity, origin or hook decision: `400` without exactly one `Upgrade:
websocket` line, a `Connection` that lists `upgrade`, and exactly one key that
is the base64 of 16 bytes, or with more than one version line or a `#` in its
query, and `426` with `Sec-WebSocket-Version: 13` for any version but 13. Each
refusal is counted as `upgrade_rejected_total{reason="malformed_handshake"}`.
Browsers and the `ws` library send conforming handshakes.

Bun hands the adapter a repeated `Upgrade`, `Connection`, `Sec-WebSocket-Key`,
`Sec-WebSocket-Version` or `Accept` line joined into one value, where uWS reads
the first line, so a single line that lists several values reads here as
several lines. One `Sec-WebSocket-Version: 13, 8` line is refused `400` where
uws answers `426`; one `Upgrade: websocket, h2c` line with no key is refused
`400` where uws treats it as a request that is not a handshake; and two
`Accept` or two `Upgrade` lines on a browser navigation at capacity (below) can
get the page where uws sends the bare `503`, or the reverse.

Any other request on the path - a plain GET, a HEAD, a POST, a GET asking to
upgrade to another protocol - goes on to your routes, so a page or endpoint you
put there answers it. With any `upgradeAdmission` limit configured
(`maxConcurrent`, `maxConnections` or `perTickBudget`), a GET there that is not
trying to open a WebSocket is the adapter's again: `426` while there is room
and, at capacity, the `503` a shed upgrade gets (see below).

```js
// src/hooks.ws.js - every hook is optional
export async function upgrade({ cookies, headers, url, remoteAddress, requestId }) {
	const session = await lookupSession(cookies.session);
	if (!session) return false;
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
export async function authenticate({ request, cookies, platform, getClientAddress }) {
	const session = await refresh(cookies.get('sid'));
	if (!session) return false;
	cookies.set('sid', session.token, { path: '/', maxAge: 3600 });
}

// Once per process. `init` runs after the listener is up (a throw here is NOT
// swallowed - boot failure should be loud). `shutdown` runs at graceful stop
// BEFORE the sockets are drained, so it can still reach connected clients.
export function init({ platform, workerData }) {}
export function shutdown({ platform, reason, signal, deadline }) {}

export function open(ws, { platform }) {}
export function message(ws, { data, isBinary, msg, platform }) {}
export function drain(ws, { platform }) {}
// `close` also gets this connection's messagesIn/messagesOut and
// bytesIn/bytesOut. The out counters cover frames sent to this connection
// directly (control frames, directed platform sends, and a resume's replayed
// frames), not live topic broadcasts. Queued and written frames count; dropped
// and throwing sends add nothing. bytesIn is exact;
// bytesOut counts binary frames in bytes and text frames in UTF-16 code units,
// so non-ASCII text reads low.
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

**Authorize private topics.** Without a subscribe hook or wire-subscribe
authorization, topics are public. Export a `subscribe` or `subscribeBatch`
hook to decide access, or arm the grant gate below and grant membership from
the server.
```js
export const subscribe = () => null; // every topic in this app is public
```

The handler may export synchronous `attribution(userData)`, returning
`{ tenantId?, principalId?, entitlement? }` or `null`. Each provided value must
contain 1-64 ASCII letters, digits, underscores or hyphens. The runtime freezes
the result before `open` and shares it with plugins through the registered
attribution slot. Invalid results close the connection with code 1008.

Read that frozen attribution and the connection session ID through the public
connection helpers, including from the `open` hook:

```js
import { attribution as getAttribution, connectionSessionId } from 'svelte-adapter-bunserve/connection';

export function open(ws) {
	const tenantId = getAttribution(ws)?.tenantId;
	const sessionId = connectionSessionId(ws);
}
```

Unavailable metadata returns `null` from `attribution` and `undefined` from
`connectionSessionId`, including after the native connection handle is gone.

### Wire-subscribe authorization

A `subscribe` hook decides topics one at a time. When the server already knows
which topics a connection may have - because it granted them itself - the gate
can be the grant instead.

Set `websocket: { authorizeWireSubscribe: true }` (or call
`platform.authorizeWireSubscribe()` once at startup) and a client-initiated
`subscribe` / `subscribe-batch` is honoured only for a topic the server already
authorized for that connection through `platform.subscribe` - unless you export
your own `subscribe` / `subscribeBatch` hook, which then decides every topic
exactly as before.

```js
// hooks.ws.js - no subscribe hook at all: the server grants, the client asks.
export async function open(ws, { platform }) {
	const { rooms } = ws.getUserData();
	for (const room of await db.roomsFor(rooms)) await platform.subscribe(ws, room);
}
```

`'strict'` is the conjunctive form: the topic must be in that connection's
grant set **and** the hook must allow it. A permissive hybrid hook therefore
cannot stand in for a tenant or room grant, while a restrictive one can still
narrow a grant. Strict is latched for the worker lifetime, and a later
no-argument `platform.authorizeWireSubscribe()` cannot downgrade it.

The arming only ever rises, and every lane reads it fresh: a subscribe parked in
an app hook while the gate is armed underneath it is judged by the posture in
force when it lands, not the one it started under. A value that is not `true`,
`false` or `'strict'` is a build error rather than a silent "off", because
`authorizeWireSubscribe: process.env.WS_AUTHZ` is a string when the variable is
set and would otherwise arm nothing while the config reads as armed.

`platform.checkSubscribe(ws, topic, { requireGrant: true })` asks the same
question for an observer lane that wants to read what a connection already
holds. With the gate unarmed it falls through to the ordinary hook. The grant is
read again where the answer lands, so a revocation that arrives while your hook
is awaiting is a refusal rather than a stale yes.

The same grant decides the client-named `resume` frame, which yields a topic's
message history. An armed gate filters that frame's `lastSeenSeqs` down to the
topics this connection was granted before your `resume` hook sees it: a topic
refused on the live-subscribe path is not served on the history path either.
Filtered rather than refused whole, so a reconnect still fills the gaps it is
entitled to.

A hook that only observes a subscribe does not count as taking the decision
over. A plugin marks its own exported `subscribe` with
`Symbol.for('adapter-uws.hook.side-effect-only')`; a marked hook still runs, and
the gate stays armed behind it. Without that distinction, importing a
presence-style plugin and following its wiring would silently disarm the gate
you had just armed. Your own hooks are unmarked, and a wrapper you write around
a plugin's hook is your code - so it decides.

**Handshake headers use an explicit response wrapper.** Return
`upgradeResponse(userData, headers)` to attach headers to the 101 response.
A `headers` property on ordinary returned userData remains application data.
Return `false` from `upgrade` to refuse with 401. Returning a `Response` does
not send a custom HTTP refusal; use the `authenticate` preflight when you need
a custom HTTP response.
The helper validates header names and values; the runtime snapshots and
validates them again before handing them to Bun.

**The auth preflight is guarded against CSRF by default.** It accepts session
cookies and runs your credential check, so a page on any origin could otherwise
drive it with the visitor's cookie riding along on a credentialed `fetch`. The
request is accepted when it carries `x-requested-with: XMLHttpRequest` (a
cross-origin browser cannot set a custom header without a CORS preflight, and
this endpoint approves none), or `sec-fetch-site: same-origin` (browsers stamp
it and script cannot forge it), or an `Origin` your `allowedOrigins` allows. The
family client stamps the first. Custom middleware in front of this endpoint
must accept the `XMLHttpRequest` value; the old `svelte-adapter-uws` value alone
is refused. A request with none of these three origin signals is refused here,
where the upgrade door allows a missing `Origin` and leaves authentication to
your `upgrade` hook. Set `authPathRequireOrigin: false` for native clients that
send none of the three.

**The preflight is metered per client address**, at `authPathRateLimit` (30) per
`authPathRateLimitWindow` (10) seconds, so a credential check against a database
cannot be driven at raw server capacity from one address. Over the limit is
`429` with a `retry-after` of about one window, jittered (10 to 14 seconds at
the default) so the clients behind one address do not all return in the same
second, and the hook is never called. The
budget is separate from `upgradeRateLimit`'s and deliberately higher: every
reconnect that preflights also upgrades, so matching them 1:1 would make this
door the binding constraint on both. The identity is resolved exactly as the
upgrade limiter resolves it, with the same caveat behind an address-rewriting
proxy - and the server says so once per door and per cause, on the first
refusal that looks like one. Refusals are counted as
`upgrade_rejected_total{reason: "auth_rate_limit"}`.

Both hooks take the same single event object as svelte-adapter-uws.
`authenticate` receives `request`, a plain `headers` object, `cookies`, the
request target as `url`, `remoteAddress`, `getClientAddress`, and `platform`.
`upgrade` receives plain `headers` and `cookies` objects, `url`,
`remoteAddress`, `requestId`, and `traceContext` (always null in this adapter).
`userData.remoteAddress` defaults to the resolved client address. The response
helper has its own runtime import:

```js
import { upgradeResponse } from 'svelte-adapter-bunserve/upgrade-response';

export function upgrade({ cookies }) {
	return upgradeResponse({ sessionId: cookies.session }, {
		'x-region': 'eu',
		'set-cookie': ['first=1; Path=/; HttpOnly', 'second=2; Path=/; HttpOnly']
	});
}
```

Header values may be strings or arrays of strings; each `Set-Cookie` array
entry is emitted separately. `Connection`, `Upgrade`, `Sec-WebSocket-Accept`,
`Sec-WebSocket-Extensions`, and `Sec-WebSocket-Protocol` belong to the
handshake and cannot be supplied by the hook. For cookie refresh behind a
proxy that rejects cookies on a 101 response, use `authenticate` instead. The
adapter warns once per worker when an upgrade attaches `Set-Cookie`.

Accepted high-range header code points (U+0080 through U+00FF) are sent as
UTF-8 bytes. Bun joins non-`Set-Cookie` arrays and case-duplicate names with
commas and trims leading/trailing spaces and tabs; svelte-adapter-uws emits
those values as separate, untrimmed lines.

**`subscribe` is called with the per-connection `platform`**, the same one every
other hook receives, so `platform.requestId` correlates across the whole
connection.

A throwing `subscribe` hook denies with `INTERNAL_ERROR` rather than
`FORBIDDEN`, so a client can retry a transient failure without retrying a
deliberate refusal.

**An `open`, `message` or `drain` hook that throws, or returns a promise that
rejects, costs only its own connection**: it is closed with code 1011 and the
reason `Open handler error`, `Message handler error` or `Drain handler error`,
and the original error is printed server-side as `[ws] the open hook threw
[ADAPTER-ERR-OPEN-HOOK]` (and the same for the other two). A failing `close`
hook is only logged (`ADAPTER-ERR-CLOSE-HOOK`), and the adapter's own cleanup
for the connection still runs. Every other connection keeps being served. A
falsy `open` or `drain` export (`export const open = dev && fn`) is skipped;
one that is set to something other than a function fails like a throwing hook,
so a non-function `open` closes every connection.

**The `ws` the hooks receive is uWS-shaped**, so a hook moves between the two
adapters unchanged. Every method that sends, subscribes or closes throws a
`WsClosedError` once the connection has closed; `getUserData()` stays readable
through the `close` hook and `isSubscribed()` answers false. The two that
close it:

- `ws.end(code?, reason?)` - close with a close frame the client reads: `code`
  must be 1000-1003, 1007-1014 or 3000-4999 (anything else throws a
  `TypeError` and leaves the connection open, as does a reason without a code),
  a reason is text or UTF-8 bytes, and one over 123 UTF-8 bytes is shortened at
  a character boundary. With no code the frame carries no status, which the
  client reads as 1005.
- `ws.close()` drops the connection with no close frame, so the client reads
  1006 and reconnects. It takes no arguments; the graceful close with a code is
  `end`. (Bun's own API spells these the other way round, `close(code, reason)`
  and `terminate()`.)

The same `platform` reaches SSR, so a load function or form action publishes
without holding a socket:

```js
export function POST({ platform }) {
	platform.publish('room', 'said', { text: 'hello' });
	return new Response(null, { status: 204 });
}
```

### Joining topics outside the wire protocol

Code that joins or leaves a connection's topics on its own - a presence join, a
snapshot handshake, a plugin in another package - does it through
`trackedSubscribe(ws, topic)` and `trackedUnsubscribe(ws, topic)` from
`svelte-adapter-bunserve/subscriptions`, the entry svelte-adapter-uws declares
under the same name:

```js
import { trackedSubscribe, trackedUnsubscribe } from 'svelte-adapter-bunserve/subscriptions';

export function message(ws, { msg }) {
	if (msg?.type === 'join-lobby') trackedSubscribe(ws, 'lobby');
	if (msg?.type === 'leave-lobby') trackedUnsubscribe(ws, 'lobby');
}
```

They move native membership, the connection's subscription set, the
per-connection cap (65,536 topics), a shared-codec topic's cohort and the
instance's subscription total together. A bare `ws.subscribe`, or a registry
entry written by hand, leaves the total behind: `ws_subscriptions` and the
pressure reading never hear of it, and the close that releases it reports
`subs.total-negative`. `trackedSubscribe` returns `false` for a closed socket
or a new topic at the cap; `trackedUnsubscribe` returns `false` for a closed
socket, and also cancels a subscribe for the same topic still waiting on its
authorization hook. Neither runs the app's `subscribe` or `unsubscribe` hook:
they change membership, they do not authorize it. A server-side subscribe that
should go through the gate is `platform.subscribe`.

Use `releaseSubscription(ws, topic)` from the same entry when an admitted
framework loader or setup fails. It immediately removes physical and logical
membership, registered derived subscriptions, the publish grant and shared-codec
cohorts. It returns whether anything was removed and is safe to repeat or call
after close. Independently pending admissions can still finish their own
authorization; a prior explicit revocation remains effective.

This releases physical membership, not an ownership reference. Coordinate
already-completed concurrent admissions and perform framework-specific cleanup
yourself; no application unsubscribe hook runs. Use `platform.unsubscribe` or
`trackedUnsubscribe` when pending attempts must also be cancelled.

Every slot they touch is a `Symbol.for` key or a global hook under
svelte-adapter-uws's names, so a plugin that carries that adapter's own copy of
these helpers moves this runtime's state the same way.

### Platform surface

| member | notes |
|---|---|
| `publish(topic, event, data, options?)` | topic fan-out; `{ seq, jitterMs, compress }`. `seq` DEFAULTS to the per-topic counter - a call with no options stamps one; `{ seq: false }` is the only way to publish without |
| `publishBatched(messages, options?)` | batches `{ topic, event, data, options?, coalesceKey? }` entries when every recipient supports batch frames and sees the same topics; otherwise publishes entries separately. `{ compress: true }` opts into compression. Shared batches serialize every payload before advancing any sequence |
| `grantPublish(ws, topic)` / `revokePublish(ws)` / `publishGrant(ws)` | set, clear, or read a connection's single client-publish grant. Unsubscribing from the granted topic clears it. JSON `game` and binary `game:1` ingress resolve their topic from this grant |
| `publishGame(senderWs, topic, event, data, id?)` | trusted server game fan-out, excluding the sender; returns `{ seq, delivered }`. Client input IDs are echoed to peers. Requires a single socket-owning I/O worker |
| `send(ws, topic, event, data, options?)` | one connection; returns 0 enqueued / 1 sent / 2 dropped |
| `sendTo(filter, topic, event, data, options?)` | filtered fan-out; the filter MUST be synchronous. Returns the number of non-throwing sends, including dropped frames |
| `sendCoalesced(ws, { key, topic, event, data })` | one connection, coalesce-by-key: each `(connection, key)` holds at most one pending message and a newer value replaces it in place (latest wins, first insertion order kept), flushed at once and again on every drain, ahead of your `drain` hook. For latest-value streams (cursors, presence, price ticks): a backpressured client catches up to the latest value instead of every stale one. Immediate serialization failures preserve native Error identity; other failures become TypeErrors. Queued failures are dropped and reported as the `ws.send-coalesced.unserializable` operational event with `ADAPTER-ERR-COALESCED-UNSERIALIZABLE`, even if the reporter itself throws. Topic and event names are validated before replacing or evicting pending entries. Reentrant sends to the same connection only enqueue; superseded values are skipped and newer replacements survive backpressure. Repeated requeues yield to the event loop, and continuations stop after close. At most 1,000,000 keys per connection; a new key past that evicts the oldest pending one |
| `subscribe(ws, topic)` | server-side subscribe THROUGH the authorization hook; `null` on success or a closed socket, else a reason: `INVALID_TOPIC`, `INTERNAL_ERROR`, `FORBIDDEN` (what a hook returning `false` becomes, and the answer for a subscribe a revocation cancelled while its hook was awaited), `RATE_LIMITED`, or the hook's own string |
| `checkSubscribe(ws, topic, options?)` | run the hook without subscribing; the same reasons except `RATE_LIMITED`, which only an install can produce |
| `unsubscribe(ws, topic)` | remove membership or cancel an in-flight subscribe; returns true for either, dispatches every removed membership's app hook, and releases derived topic subscriptions |
| `metrics` | configured registry object, or `null`; `counter`, `gauge` and `histogram` factories follow `MetricsRegistry`. Serialize application metrics through that registry |
| `metricsSnapshot()` | promise resolving to canonical adapter metrics, or `null` when unconfigured |
| `adviseReconnect(options?)` | jittered reconnect advice, then drain. Returns completed advisory attempts, including dropped frames; a send or requested close that throws is not counted |
| `connections` / `subscribers(topic)` / `forEachSubscriber(topic, fn)` | live counts and the per-subscriber walk |
| `maxPayloadLength` / `bufferedAmount(ws)` / `closedWsAborts` | limits and backpressure telemetry |
| `assertions` | per-category count of framework invariant violations in this process: the live `Map`, read it and do not modify it. Empty on a healthy server; see below. On every build, with or without a WebSocket handler |
| `pressure` | the LIVE 1 Hz sample (mutated in place, never copied): `{ active, value, reason, subscriberRatio, publishRate, memoryMB, maxBufferedBytes, backpressuredConnections, psi, cpuThrottle, topPublishers }`; `reason` precedence is MEMORY > CAPACITY > CPU_QUOTA > PSI > PUBLISH_RATE > SUBSCRIBERS > NONE; kernel readings are `null` off-Linux |
| `protection` | `'normal'` for this process |
| `onPressure(cb)` | fires on `reason` TRANSITIONS with the live snapshot; throwing callbacks are contained; returns unsubscribe |
| `onPublishRate(cb)` | per-topic runaway-publisher reports `[{ topic, messagesPerSec, bytesPerSec }]` once per window; registering replaces the default throttled console warning; returns unsubscribe |
| `topic(name)` | scoped publisher: `platform.topic('chat').created(data)` |
| `requestId` | per-connection / per-request identity |
| `now()` / `monotonic()` / `random.float()` `.u32()` `.uuid()` `.bytes(n)` | determinism seams |
| `publishWire(topic, event, data, wire, options?)` | binary fan-out through a codec: capable clients get the `0x03` frame, everyone else the `publish()` envelope with the SAME seq; `{ seq, compress, excludeWs }` |
| `publishWireBatch(topic, event, entries, wire, options?)` | one tick's updates as ONE batch frame per capable connection (the codec's `<event>-batch` form), per-entry envelopes and seqs for the rest; per-entry `excludeWs` and `seq` |
| `sendWire(ws, topic, event, data, wire, options?)` | single-target codec frame (seq 0 unless an explicit seq is supplied), or the JSON envelope for a caps-less / degraded connection; returns the send tri-state; codec exceptions propagate |
| `sendWireBatch(ws, topic, event, entries, wire, options?)` | the per-subscriber twin of `publishWireBatch`, for culled per-viewer walks; stateful codecs batch as binary, stateless codecs send per-entry JSON; codec errors propagate |
| `registerWireCodec(wire)` | register a codec under its capability token; idempotent, last-wins |

`publishWire`, `publishWireBatch`, `sendWire` and `sendWireBatch` propagate
codec exceptions to the caller. An invalid non-null codec result throws
`TypeError` before that encode sends a wire-id announce or payload; `Uint8Array`
values from another JavaScript realm are accepted. A failed encode does not
poison the connection or send a JSON fallback. A broadcast may already have
reached earlier subscribers or entries when a later encode fails; it does not
roll those deliveries back. Handle the exception where the application can recover. `sendWireBatch` uses JSON for
stateless codecs and captures each stateful entry's data once before encoding.

The close-hook counters `messagesOut` and `bytesOut` include directed frames
accepted by the socket: both written and queued behind backpressure. Dropped
and throwing sends add nothing. The same rule applies to control frames,
coalesced sends and resume replay. These are local socket acceptance counters,
not peer delivery receipts.

`sendTo` and reconnect advice retain dropped attempts in their return counts.
`sendTo` charges non-throwing sends to egress; reconnect advice excludes attempts
where either the send or requested close throws. Close-hook counters still record
an accepted advisory when the subsequent close throws. `sendTo` admits the entire
filtered target set before sending; sockets that throw during delivery do not
consume the tenant budget.

`adviseReconnect` snapshots and filters its targets before sending any advice.
A missing, non-positive or sub-millisecond `windowMs` returns zero without
sending or closing, even with `{ close: true }`. Replace close-only calls with
a positive reconnect window when draining clients; use each socket's `end()`
when no advisory is wanted.

**The realtime tier checks its own invariants.** About twenty places verify
state that should never be wrong - a connection with no platform, a
subscription slot that is not a `Set`, a subscription total below zero, an
empty envelope. A violation increments `platform.assertions` and
`framework_assertion_violations_total{category,severity}` and logs one line,
`[lantean/diagnostic source=svelte-adapter-bunserve component=runtime.assertion event=invariant.violated severity=warn] <category> {...}`,
whose JSON names the category, plus what was found where the check records it
(the subscription total, the stats field types). The check itself does not
throw: a throw would abandon the socket callback it happened in. The few that
mean state which cannot heal - a second `open` on one connection, a socket
admitted without its connection permit, a message on a connection with no
platform, a subscribe onto a broken subscription set, an empty envelope on a
publish - are fatal: after the line (`severity=fatal`) the process exits with
code 78 on the next microtask, so a supervisor restarts it rather than letting
it run on. Under test
(`NODE_ENV=test`, or `VITEST` set) every violation throws instead, so the test
that caused it fails. The categories are svelte-adapter-uws's, so a report
reads the same on either adapter, and a non-zero count is worth an issue with
the category and the logged line.

```js
export function GET({ platform }) {
	const assertions = Object.fromEntries(platform.assertions);
	return Response.json({ healthy: Object.keys(assertions).length === 0, assertions });
}
```

**The memory signal is the family's, and its basis is distance to the nearest
memory wall.** `heapUsed / heapTotal` measures how tightly an engine keeps its
arena fitted, which is not memory pressure: a freshly booted, completely idle
server measures 0.90 to 0.94 on Bun 1.3.14 and 0.81 on 1.4.0 (the live suite
pins that it stays high), so a 0.85 threshold on that reading fires on a healthy
process and never clears. It also misses the death that actually happens - the
kernel's OOM killer charges the whole resident set against the cgroup limit,
which no heap ratio observes.

The sample is therefore the worst of two walls, each measured with the quantity
its wall kills on: `heapUsed` against the engine's reported allocation ceiling,
and the resident set against the tightest cgroup memory limit that applies to
the process (v2 `memory.max`, v1 `memory.limit_in_bytes`, on its own group and
each ancestor that enforces on it). The limits are re-read every sample, so one
changed on a running process is followed, and a limit file that fails to read
holds its last value rather than dropping out. JavaScriptCore reports no
allocation ceiling, so on this runtime the
container arm carries the reading. `memoryHeapUsedRatio` keeps its name and its
0.85 default, one reading feeds the `MEMORY` reason, the value fold, the gauge
and the send-gate window sizing, and every signal stays disableable with
`false`.

If a finite cgroup limit becomes unlimited, its gauge sample disappears. It
returns when a finite wall is known again.

**What that costs you, stated plainly:** a process with no discoverable wall on
either arm omits `heap_used_ratio` and contributes zero to memory pressure. On an uncontained host
(no cgroup limit, and JavaScriptCore contributing no engine arm) the memory
signal is silent, and a worker genuinely approaching OOM there reports
`reason: 'NONE'`. The signal degrades to silence, never to a false alarm. On
Linux, `psiMemoryFull` (default 15) is live and is the better memory signal
anyway: it measures kernel-observed stall time, which fires meaningfully earlier
than any OOM-adjacent ratio. In a limited container - the deployment this
matters most for - the container arm is live and warns before the resident-set
kill.

Bun 1.4's [`memoryPressure` notifications](https://bun.com/blog/bun-v1.4)
feed discovery on the next regular sampler tick. Both `warning` and `critical`
set the same pending hint; a burst causes one cgroup membership refresh before
that tick reads the walls. The notification starts no extra timer or sample and
assigns no pressure level. Measured wall ratios and PSI still determine pressure,
so a notification without a discoverable wall or measured PSI adds no saturation.
Disabling `memoryHeapUsedRatio` leaves configured PSI thresholds independent.

The listener is removed when the sampler stops. Runtimes that never emit the
event retain the normal sampling behavior. Controlled environments never install
a host memory-pressure listener.

Every other threshold, and the rest of the surface, is the family's.

`platform.subscribe(ws, topic)` and `platform.checkSubscribe(ws, topic)` pass
server-selected topics, including `__`-prefixed plugin channels, through the
application's subscribe hook. Registered plugin-owned channels retain their
own authorization. Other client-selected system topics remain refused unless
`allowSystemTopicSubscribe` enables them. An app that
forwards client input through these server APIs must authorize that topic in its
hook. `subscribe` takes no options argument; remove the former
`allowSystemTopic` escape. `checkSubscribe` retains its `{ requireGrant: true }`
observer mode. Observer checks follow the configured wire topic alphabet;
ordinary server checks permit non-ASCII topics.

Subscription topic names must contain valid UTF-16: unpaired high or low
surrogates return `INVALID_TOPIC` from `platform.subscribe` and `checkSubscribe`,
and from wire subscriptions when `allowNonAsciiTopics` is enabled. Replace those
names before upgrading. Valid surrogate pairs are accepted on non-ASCII lanes;
the 256-unit limit counts each astral symbol as two UTF-16 code units.

A bare `ws.subscribe(topic)` bypasses application authorization. The
check-then-subscribe pattern runs that authorization before loading data:

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

Set `websocket.metrics` to a module that exports a registry as `default`,
`metrics`, or `registry`. The adapter retains that object on `platform.metrics`.
When no registry is configured, both `platform.metrics` and the awaited
`platform.metricsSnapshot()` result are `null`.

```js
// src/lib/server/metrics.js
import { createMetrics } from 'svelte-adapter-uws-extensions/prometheus';
export const metrics = createMetrics();

// svelte.config.js
adapter({ websocket: { metrics: './src/lib/server/metrics.js' } });
```

Install `svelte-adapter-bunserve/vite` alongside the SvelteKit plugin to bundle
that module into the app's SSR graph. Routes importing it and
`platform.metrics` then use the same instance. Without the plugin the adapter
bundles the registry separately and warns; use `platform.metrics` to reach
that instance.

The configured registry holds adapter and application instruments. Its own
serializer may apply a name prefix. `metricsSnapshot()` returns only mirrored
adapter instruments under canonical family names; application instruments stay
in the configured registry and are not copied into that snapshot.

```js
// src/routes/metrics/+server.js
export async function GET({ platform }) {
	const body = await platform.metricsSnapshot();
	if (body === null) return new Response('metrics not configured', { status: 503 });
	return new Response(body, {
		headers: { 'content-type': 'text/plain; version=0.0.4' }
	});
}
```

With metrics configured, transport hooks record bounded-label completion counters
and monotonic durations. Live-state gauges and cumulative counters project from
the runtime state on the existing pressure sampler and during a snapshot. No
extra timer is installed. Without a registry, the sampler's metrics export hook and transport metric
hooks remain disabled.

Counters and immediately measurable gauges register at initialization; a throwing
factory fails startup. Sampled gauges register when their first measurement arrives.
Instrument emit failures are contained and reported once per instrument, while
the adapter mirror retains the recorded value. A gauge's optional `remove()`
method retracts unavailable samples. Registries without removal receive memory
wall samples only when a permanent engine wall makes them continuously available;
the adapter snapshot tracks wall availability independently. Gauge factories should
leave samples absent until `set()` is called. A factory that publishes a default
value without supporting removal cannot represent an unavailable measurement
in its own serializer.

Signals with no measurement are absent. Pressure gauges appear after the first
sampler tick; unavailable kernel readings and memory walls withdraw their earlier
samples. `pressure_sample_timestamp_seconds` gives the sample's age.
`metrics_snapshot_workers_expected` is 1 for this single-process adapter.
`metrics_snapshot_workers_reporting` counts a complete report only when every
required instrument is registered and each required gauge has a sample.
`metrics_snapshot_degraded` distinguishes a failed collection from an incomplete
report. Compare reporting with expected before treating absent series as zero.

Metric applicability follows the fixed runtime source inventory from
`createMetricProfile`, exported with `METRIC_SOURCE_GROUPS` and
`NATIVE_METRIC_PROFILE` from `svelte-adapter-bunserve/observability`. The adapter's
inventory is part of its implementation, not an application option. A build
without a WebSocket tier reports HTTP, process memory and framework assertions;
a realtime build also reports upgrade, rate-limit, admission, pacing, WebSocket,
subscription, publish, backpressure, direct-send drop, egress, pressure and OS
pressure sources. Missing samples from supported sources still make the report
incomplete. Sources without measurements, such as worker relay and state audit,
are absent rather than represented by zero.

In-flight upgrades are measured even without an admission ceiling. A server with
no pacing controller has an empty queue, with zero depth and age. Drop counters
cover direct socket sends; Bun does not expose per-recipient publish drops.
Snapshots identify this with `# metric_sources` and
`# ws_dropped_coverage direct-sends` comments. Preserve that coverage when comparing
drop rates. See [transport availability](docs/transport-availability.md#metric-sources)
for source and completeness rules.

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
	staticDotfiles: false,           // see Static files
	staticHeaders: undefined,        // extra response headers for static and prerendered files
	staticCacheControl: undefined,   // path-specific cache policies
	warmup: true,                    // warm '/' before readiness; false, or { paths: [...] }
	websocket: undefined             // the realtime endpoint; see below
})
```

**`warmup` renders your paths once before readiness reports ready.** A cold
SvelteKit SSR render costs about twenty times a warm one - measured on Bun
against this repository's fixture at 16.1-18.0 ms cold against a 0.75-0.92 ms
settled mean, 17-24x across runs - and the whole penalty lands on whichever
client arrives first after a deploy. The warmup runs in the `starting` window,
after your `init` hook and before readiness turns green, so a load balancer
cannot route anyone into the cold render. `true` (the default) warms `/`;
`false` disables it; `{ paths: ['/', '/dashboard'] }` names the routes, which
must be absolute pathnames.

It is bounded in every direction, because it sits on the readiness-critical
path: each render is aborted past a per-render budget, a never-ending body (an
SSE route) is cancelled rather than buffered, and the whole pass is raced
against a total budget so readiness commits even if a render ignores its abort.
A warmup that fails or times out is logged and readiness proceeds - an instance
that never reports ready is worse than one whose first render is cold.

The render goes through the same engine entry a real request reaches, so your
hooks run. `platform.isWarmupRequest(request)` tells them apart: the request is
tagged by object identity, never a header, so a real client cannot forge one.
Use it to skip what a real visit would incur - analytics, rate counting, an
audit log entry.

```js
export async function handle({ event, resolve }) {
	if (!event.platform.isWarmupRequest(event.request)) track(event);
	return resolve(event);
}
```

`healthCheckPath` answers liveness and `readinessCheckPath` answers readiness -
two distinct probes, so they must differ, and the build fails if they do not. A
readiness 503 during a drain is a signal to stop routing new traffic; if a
liveness probe read the same route, that drain would be answered with a restart
instead. Neither may collide with `websocket.path` or `websocket.authPath`: the
probe routes are matched first, so the endpoint behind the collision would never
be reached, and that fails the build rather than going quiet.

A request target that carries a `#` is refused with `400` on every path - the
probes, the auth path, the WebSocket handshake, the built assets and your own
routes - as svelte-adapter-uws refuses it: RFC 9112 does not allow a fragment
in a request line, and Bun would read the rest as one, so `/healthz#frag` would
be answered as the probe. A WebSocket handshake whose query carries one is
counted as `upgrade_rejected_total{reason="malformed_handshake"}`. Routing
uses the target after removing Bun's Host-derived URL prefix. Probes and
built assets do not need a valid Host; SSR and authentication reject an
invalid authority with `400` before calling application code. Configured
proxy protocol and port headers must carry `http` or `https` and decimal
digits respectively. A refused proxy header logs its setting once.
svelte-adapter-uws also refuses a raw byte outside visible ASCII in the target.
Bun answers a space or a byte below `0x20` there with its own `505` before the
adapter runs, and a bare CR with nothing. It hands DEL on as `%7F`, and every
byte from `0x80` up decoded as UTF-8 and escaped again, a byte that is not part
of UTF-8 as `%EF%BF%BD`: here a raw UTF-8 `caf` + `é` is served as `/caf%C3%A9`
would be. Browsers, and clients that build the target from a parsed URL, send
neither.

The paths the adapter answers ahead of your routes - the probes, the auth path
while your handler mounts it, and the WebSocket path while an
`upgradeAdmission` limit makes its GETs the adapter's - are matched exactly. A
request SvelteKit would route onto one of them without spelling it, its data or
route-resolution request (`/healthz/__data.json`, `/readyz/__route.js`) or an
escape of its letters (`/%68ealthz`), is refused with `400` whatever its method,
as svelte-adapter-uws refuses it, rather than handed to your router as that
path. A page one trailing slash further on, `/healthz/`, stays yours, and so
does its data, and a file of yours that sits at such a path is still served.
Bun resolves dot segments and backslashes before the adapter sees the target,
so a spelling through them is the path itself here, on every lane: a GET of
`/x/../healthz` is answered by the probe and a POST of it reaches your routes
as `/healthz`, a POST to `/x/../__ws/auth` reaches the auth endpoint, and a
handshake on `/x/../ws` opens a socket. uws refuses each of them with `400`,
the last only under a limit, where without one it hands the request to your
routes.

Files at or below 4 MiB are held in the in-memory static index; larger ones are
streamed from disk through `Bun.file`, which uses the kernel's own send path.
The threshold is fixed rather than an option, because the adapter this one
mirrors declares none.

Static negotiation reads `Accept-Encoding` weights and wildcard codings.
For example, `br;q=0, gzip;q=0.8` selects an available gzip copy; equal accepted
weights prefer Brotli. Identity is the fallback when neither available coding
is accepted. Byte ranges address those selected bytes, including precompressed
Brotli and gzip. A zero-length suffix (`bytes=-0`) is unsatisfiable and answers
416. `If-Range` requires a strong validator; the weak file validators cause a
full response when supplied in `If-Range`.

Conditional requests follow the same policy as svelte-adapter-uws.
`If-Match` accepts any validator issued for the asset's identity, Brotli or gzip
representation, including its `W/` prefix; `If-None-Match` compares the selected
representation weakly, so adding or removing `W/` preserves a match. Both accept
a comma-separated list or a standalone `*`. A wildcard also applies to immutable assets without
an ETag. `If-Match` takes precedence over `If-Unmodified-Since`, and
`If-None-Match` over `If-Modified-Since`. Date conditions accept only the
three HTTP-date forms, validate the calendar and weekday, and interpret RFC
850 two-digit years with a rolling fifty-year boundary. `Last-Modified` is
omitted for future or pre-1900 file timestamps; those files retain their ETags
and ignore date conditions.
A 304 carries the selected response headers except `Content-Type`, `Content-Encoding` and
`Content-Disposition`, preserving configured cache and security metadata.

`staticCacheControl` sets path-specific policies for static and prerendered files:

```js
adapter({
	staticCacheControl: [
		{ pattern: '/fonts/', cacheControl: 'public, max-age=31536000, immutable' },
		{ pattern: '/images/logo.svg', cacheControl: 'public, max-age=86400' }
	]
});
```

Patterns are literal asset paths relative to the configured SvelteKit base. A
trailing slash matches a directory tree; other patterns match one exact file.
The longest matching pattern wins, regardless of rule order. SvelteKit
`/_app/immutable/` files always retain their built-in immutable policy. Other
files default to `no-cache`. Configured files keep their ETags and byte ranges,
and their selected policy appears on both 200 and 304 responses. Use immutable
caching only when content changes also change the filename. Invalid paths,
duplicate patterns, empty policies and control characters fail at adapter
creation.

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
		handler: 'src/hooks.ws.js',       // discovered automatically
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
		allowNonAsciiTopics: false,
		allowSystemTopicSubscribe: false,
		authorizeWireSubscribe: false,      // true, or 'strict'
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
		// Publish-egress ceilings, per topic and per tenant over a rotation
		// window. Every ceiling is a non-negative safe integer; 0 (or omitted)
		// disables it deliberately. Omit the whole section for no ceilings.
		egress: {
			windowMs: 1000,                   // accounting window, rotated lazily
			maxKeys: 4096,                    // keys per scope ledger (rounded up to a power of two)
			evictionSample: 8,                // entries an at-cap eviction inspects
			topic: { messages: 0, bytes: 0, deliveries: 0 },
			tenant: { messages: 0, bytes: 0, deliveries: 0 }
		},
		// Pressure-sampler thresholds; each signal accepts `false` to
		// disable it. The sampler always runs - this only tunes it.
		pressure: {
			// The family default: distance to the nearest memory wall. See below.
			memoryHeapUsedRatio: 0.85,
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

This adapter also applies fixed per-connection limits and hook policies -
the adapter it mirrors declares none of them, so they are fixed constants and a
config carried between the two means the same thing in both. They are different
jobs rather than different sizes of the same one:

- `maxSubscriptionsPerConnection` bounds installed membership at 65,536 topics.
  Held topics do not consume another slot, and the cap is rechecked after
  authorization settles.
- `maxPendingSubscribesPerConnection` bounds pending authorization at 4096
  attempts, including repeated requests for the same topic. Single frames,
  batch entries and server subscribes share this bound. Recovery keeps its
  attempt counted until the subscription settles. Batch headroom follows valid
  topic order, including topics that the grant gate denies. Excess entries
  receive `FORBIDDEN` for permanent grant denials and `RATE_LIMITED` otherwise.
- Standalone resume calls reach the application hook without a separate
  concurrency ceiling. Server-side `checkSubscribe` does not install membership
  or consume subscription attempts. A permanently ungranted wire topic receives
  `FORBIDDEN` before pending-attempt pressure can return `RATE_LIMITED`.
- Unsubscribe hooks start directly for client and server releases. Synchronous
  throws and rejected promises are contained and reported. Released topics are
  not retained as teardown debt for the close hook. Applications must handle
  cleanup failures in their own hooks.
- `maxControlEgressBytes` bounds the ACK CHANNEL, in bytes per 10 s. Exceeding
  it closes the connection with code 4429 and writes nothing before the close;
  the server logs the connection's request id. It covers every
  frame the client's own input buys, which includes the `__replay:t`
  `truncated` marker: a resume or recover naming many topics can be answered
  with a marker per topic, so that lane amplifies the same way acks do. A
  marker the budget cannot afford therefore CUTS the connection rather than
  being dropped - a client that reconnects cold-resyncs, which is what the
  marker says. The `wire-id` announce that precedes a topic's first binary
  frame is charged too; one the budget cannot afford cuts the connection the
  same way.

`upgradeRateLimit` meters upgrades PER CLIENT ADDRESS - ten per ten seconds by
default, `0` to disable - on a sliding window, so a client cannot double its
rate by placing requests either side of a boundary. It is checked before the
Origin comparison and before your `upgrade` hook, because the Origin gate bounds
no rate at all (a non-browser client sends whatever Origin it likes) and the
hook is the expensive part. Over the limit is `429` without `Retry-After`.

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
with a jittered `retry-after` rather than accepting a socket it cannot serve -
`2..3` seconds normally, widening to `2..4` while the protection posture is at
siege, so a refused fleet comes back spread out instead of returning together
into the same full gate.

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
identically. One key is accepted without being honoured: uws serves a
self-polling holding PAGE at a crossed ceiling unless `waitingRoom: false`, and
this adapter has no holding page. It answers a browser that navigates to the
WebSocket path at capacity the way uws does with `waitingRoom: false`: `503`
with a short static page that says the server is at capacity and offers a
button to try again. A config that asks for the holding page builds and runs,
and says at build time that the page will not be served.

Both adapters count refusals on `upgrade_rejected_total{reason}`, so an alert
written against that counter works on either. The log line is this
adapter's alone: uws records a shed upgrade on the counter only, so a runbook
keyed on the line has nothing to match there.

Every one of these is PER CONNECTION, which is the honest scope and not the same
as per client. A peer that reconnects after being cut gets a fresh budget, so
none of them bounds an attacker who can open sockets in a loop; nothing here
limits connections per IP or handshake rate, and that belongs upstream, in the
load balancer or ingress, the way connection limiting normally does.

`egress` is the outbound half of what the admission ceilings bound on the way
in: what a single publisher can cost the whole process. Each scope (`topic`,
`tenant`) takes up to three per-window ceilings - `messages` (logical
publishes), `deliveries` (local recipients times messages, an excluded socket
deducted), and `bytes` (serialized frame bytes summed over recipients,
pre-compression). A refused publish delivers nothing, stamps no sequence, and
returns `false`; the refusal is counted in `egress_refused_total{scope}` and
said out loud at most once a minute per topic. The semantics worth knowing
before sizing one:

- A batch (`publishWireBatch`) is N logical publishes sharing ONE decision:
  admitted whole or refused whole. Size a ceiling above the largest single
  batch it must admit - a 10-entry batch under `messages: 5` can never fit any
  window and is refused on every attempt, reported every time.
- The `bytes` ceiling refuses once the window's charge has REACHED it: a
  publish's byte weight exists only after serialization, which must not happen
  before admission, so the publish that crosses the line is delivered and the
  next is refused. Overshoot is bounded by one publish's bytes.
- Ceilings are held per key in a ledger bounded per scope (`maxKeys`, default
  4096, rounded up to a power of two). Lapsed windows are reclaimed before the
  ledger fills, so the bound is on keys LIVE at once; above it the
  least-active key in a bounded sample (`evictionSample`) loses its ceiling
  for the rest of its window, counted in
  `egress_window_evicted_total{scope}`. A `tenant` ceiling stays the durable
  one for a high-cardinality topic space: tenant ids have to outnumber the
  ledger before that scope is affected at all.
- Tenant attribution comes from the WebSocket handler module: export
  `egressTenantOf(topic)` returning a tenant id (1..64 chars of
  `[a-zA-Z0-9_-]`) or null for an unattributed topic, which `topic` ceilings
  still cover. The resolver cannot be configured in `svelte.config.js` - a
  function would not survive the JSON round trip into the build.

The section is spelled as `svelte-adapter-uws` spells it, same defaults, same
disabled-on-zero rule, so a config carried between the adapters bounds the
same quantities in both.

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
`subscribe-batch` (both accept an optional `ref`), `unsubscribe`,
`hello` (`{"caps":[...]}` capability declaration; re-sends replace the set),
`request-n` (flow-control window replenish; the carried `n` is advisory - the
server sizes every window from its own posture),
and `resume` (`{"sessionId","lastSeenSeqs",{"lastSeenEpochs"?}}`).

**`epoch` is an opaque generation token, compared for equality only.** It rides
the `subscribed` ack and comes back on `resume` as `lastSeenEpochs`. A different
value than the one a client last saw means the server's seq space reset, and
that is the only fact any client reads from it. Never interpret it: do not treat
it as a timestamp, render it as a date, store it in a time-typed column, or
order by it. The value is a random 32-bit draw, not a boot time - a boot
timestamp would hand every unauthenticated client the exact millisecond the
process started, which is free uptime and deploy-timing intelligence and a
stable fingerprint for correlating instances behind a load balancer. It is drawn
once per process, never persisted, and both adapters in the family draw from the
same domain, so a client written against one reads the other unchanged.

A `hello` whose caps include `lease` arms flow control on that connection,
FIRST hello only: the server answers `{"type":"lease-ok"}` plus a
`{"type":"lease","count","ttlMs"}` window grant, and re-grants on each
`request-n`. Windows narrow with the worker's own readings - above a
`heap_used_ratio` of 0.7 they ramp down from the full 256 requests to half at
the default 0.85 MEMORY threshold and to a twentieth near the wall, and past 25
subscriptions per connection they shrink in proportion - and always floor, so
an opted-in client keeps making forward progress. A worker between 0.7 and
0.85 therefore grants smaller windows while `reason` still reads `NONE`:
backpressure applied before the alarm, by design. The server never gates its
own sends on the window - pacing is the client's job, which is what makes a
non-opting old client's behavior byte-identical to before.

`request-n` may include `queued`, the client's advisory backlog. The server
divides it by the fixed queue ceiling of 256, clamps the ratio to 0 to 1, and
folds it into the worker saturation peak used by `pressure.value`. Each
sampler pass halves the retained worker peak, so an old backlog report
fades. It never changes `reason` or decides a grant. A client that
omits it behaves as before.

A `subscribe-batch` applies its first **256 entries** and answers additional
string entries with `BATCH_OVERFLOW`. Per-topic authorization hooks run
concurrently; recovery and subscription activation wait for every decision and
then retain the original entry order.

Every control frame remains below 8192 bytes. A frame at or above that limit receives
`CONTROL_FRAME_TOO_LARGE` before application work.

A standalone `resume` carries a string `sessionId` and an object or array
`lastSeenSeqs`, plus an optional object or array `lastSeenEpochs`. The hook
receives these application-owned values unchanged. When server grants decide
authorization, both maps first drop topics without confirmed grants. The hook
owns validation of its session and history values.

Server to client:

| frame | when |
|---|---|
| `{"type":"welcome","sessionId":"..."}` | on open |
| `{"type":"wire-id","topic":"t","id":N}` | the numeric topic id for `0x03` frames, announced on the same socket before the first binary frame for its topic |
| `{"type":"resumed"}` | the standalone resume hook has settled, including a contained failure, or no hook is installed. The acknowledgement does not certify replay completeness |
| `{"topic":"__replay:t","event":"truncated","data":null}` | the gap-fill for `t` is INCOMPLETE - the buffered window overflowed its cap, or a frame was refused past the backpressure limit. Drop the stored per-topic offset and cold-resync; do not trust the partial flush. A socket that refuses this marker twice is closed instead of being acked, since there is no way left to tell it |
| binary `[0x03][schemaVersion:u8][topicId:varint][seq:varint][codec payload]` | a codec frame, for connections that declared the codec's capability in `hello` |
| `{"type":"subscribed","topic":"t","ref":N,"epoch":E}` | a subscription took. `epoch` is an OPAQUE per-process generation token, compared for equality only - see below |
| `{"type":"subscribe-denied","topic":"t","ref":N,"reason":"..."}` | it did not |
| `{"type":"error","code":"CONTROL_FRAME_TOO_LARGE","limit":L,"size":N}` | a control frame at or above 8192 BYTES |
| `{"type":"subscribe-denied","topic":"t","ref":R,"reason":"BATCH_OVERFLOW"}` | a string entry after the first 256 in a `subscribe-batch`; the first 256 are processed |
| `{"type":"reconnect","afterMs":N,"windowMs":W}` | shutdown advice, before the drain closes the socket; `afterMs` is omitted when the advice carries no delay |
| `{topic, event, data, seq?, j?}` | the data envelopes. On the publish lanes `seq` is present unless the call said `{ seq: false }`. The directed `send` and JSON fallback of `sendWire` include one only when explicitly supplied; `sendTo` and `sendWireBatch` have no seq option. An absent `seq` therefore does not by itself mean a publisher opted out. `j` is the per-subscriber jitter in ms, present only when `publish` was given `jitterMs` |

Unsubscribe frames with a string topic release membership and run the app's hook without
sending an acknowledgement, including when they carry a `ref`. Clients must not
wait for the former `unsubscribed` frame. Use an application message when a
release needs an explicit confirmation.

Acks are sent only when the client supplied a `ref`; a `ref` over 128 BYTES is
treated as absent. DENIALS follow the same rule, which is the sharp edge of it:
a subscribe sent without a `ref` that authorization or the pending-attempt cap
refuses installs nothing and is answered with nothing, so a client
that omits `ref` must treat every subscribe as unconfirmed rather than assuming
it took.

A subscribe carrying `recover` without a `ref` is refused before any gate or
hook with `{"type":"error","code":"RECOVER_REQUIRES_REF","topic":"<t>"}`.
The reply to a subscription names its topic; control-frame errors carry a
`code` instead.

Standalone `resume` installs no live membership. Its hook is awaited before
`resumed` is sent, including when the hook throws or rejects. Replay handlers
must report truncation or denial on the replay channel and check their send
results. The acknowledgement alone is not evidence that every historical frame
was delivered.

**Stamp the replayed frames.** A hook returning "the highest seq you actually
delivered" needs the client to have received those seqs, so pass each replayed
frame its own authority: `platform.send(ws, topic, event, data, { seq })`, and
`platform.sendWire(..., { seq })` for a codec frame. Both take the same explicit
number-or-bigint the publish lanes take, and both stay side-effect-free - no
counter advance, no max-seen record, no resume capture - because gap-fill
replays history that is already accounted. `{ seq: true }` throws here: this
lane has no counter to draw. Without a stamped seq the client has no value to
resume from next time, and the returned watermark is only a server-side dedup
floor.

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
will not take the retry either, the connection is closed rather than acked, and
no `subscribed` follows. The reconnect resumes from the last seq the client
actually received, so the tail it missed is re-delivered.

The close is asked for with **1013**, which is retry-class for the family
clients where 1008 is terminal - but do not write a client that depends on
reading that code here. A socket saturated enough to refuse the marker is torn
down before the close frame reaches it, and the client observes an abnormal
close (1006) instead; both supported Bun generations behave that way, and the
measurement is in `probe/bun-api-facts.report.md` under
`close-under-backpressure`. What this lane guarantees is the part that does not
have to travel over a full socket: no `subscribed` ack, and a connection that
ends. The family clients reconnect from either code.

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
wire under both. `{ seq: false }` and `{ seq: null }` are the spellings that
publish without: the envelope then omits the field entirely, and the opt-out
consumes no counter value, so the run continues where it left off. `null` is
there for the nullable authority column that reads as "no seq I know of".

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

One publish therefore WRITES A SEQ into at most one of the two maps: an
explicit number goes to the marks, `{ seq: false }` and `{ seq: null }` write
nothing anywhere, and a bare publish, `{}` or `{ seq: true }` draws the
counter. Those four spellings are the whole option - anything else THROWS,
naming them. A `{ seq: '742' }` that was meant as a cluster seq is the case
that rule exists for: a seq arrives as a string from JSON, a Redis reply, a
header or a form field often enough that the counter would answer it silently,
publishing a value from a different sequence space, leaving the topic unmarked
and costing the client its resume dedup with nothing on the wire to notice by.
Convert at the boundary with `Number()`.

The maps still overlap: a topic published both ways is in both, and the
recency touch described above means "writes no seq into a map" is not the same
as "does not touch it".

An explicit seq is written `{ seq: <number> }` or `{ seq: <bigint> }` - two
spellings of one authority, validated identically, so a caller reading an offset
out of a store that hands back `BigInt` does not convert at the call site. It
must be a POSITIVE INTEGER INSIDE THE SAFE-INTEGER RANGE (at most
`9007199254740991`).

Each excluded case makes the two wires disagree about one event: `0` is the
binary frame's "no seq" sentinel, so a stamped 0 vanishes for binary subscribers
while the envelope carries `"seq":0`; a negative seq parses back off the wire as
a different number (`-1` arrives as `127`); and a fractional one is truncated on
the frame while the JSON envelope prints it in full. The counter lane and every
shipped authority are 1-based, so a 0-based external source must offset by 1.

The upper bound is the seq SPACE, not the varint. The varint carries any
magnitude, but the space is IEEE-754 double everywhere else - the JSON envelope,
the frame's slot, the client's watermark reader - and above 2^53 a double stops
having a neighbour at distance one, so two ids you mean to be different land on
one value. Watermarks advance on a strict greater-than, so the second frame
never advances the client's and resume dedup goes ambiguous with nothing on the
wire to notice by. Snowflake ids and large log offsets are therefore refused
loudly: keep the wide id in the event data and give `seq` an authority inside
the range, or offset it by a per-topic base. Do not truncate - that destroys the
ordering `seq` exists for.

Exact representability is not the test, though it looks like the natural one.
`2 ** 60` is an exact double and still reaches a subscriber as
`1152921504606847000`, because the envelope serializes through `String(double)`;
and just above 2^53, where the gap is two, an exactness rule would accept your
even ids and refuse your odd ones.

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

A call-level `{ excludeWs }` is the default exclusion for every entry, on the
stateful lane and on the stateless reroute alike - the author of a tick's
updates is one socket for the whole batch, which is what the exclusion is for.
An entry carrying its own overrides it for that entry; a `null` entry exclusion
is absent and inherits the call-level one. One exclusion says the same thing
about every entry, which is why it is honoured here where a call-level seq is
refused.

An ENTRY seq speaks the same table as the batch option, and every form but
absent is an OVERRIDE for that entry: a number or bigint is its explicit
authority, `true` draws the counter for it alone, `false` and `null` publish it
seq-less (what a per-row authority column reads as when the row has none), and
absent inherits whatever the batch asked for. Anything else is refused naming
the entry's position. The
batch-level option follows the same four spellings as every other publish
lane, so a `{ seq: '742' }` there is refused before the first entry is
stamped rather than drawing the counter for all of them.

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
barrier is holding for it. (`test/fixture/src/hooks.ws.js` echoes it on
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

A `subscribe-batch` may carry `recover: { topic: { offset, epoch? } }`.
Authorization settles before one resume hook receives all allowed cursors.
Live frames published during recovery are buffered until each topic lands.
History requests require a `ref`, including recover entries outside the topic list.

`subscribe-batch` processes its first 256 entries. Each extra string entry is
answered with `subscribe-denied` and reason `BATCH_OVERFLOW` when a ref is
present. Replies use the same bounded control-egress path as other control
frames.

Within the limit the batch is answered PER ENTRY, which is an amplifier and
deliberately so - the family client keys its denial store and its per-topic
epochs off those frames and re-subscribes everything as a batch on reconnect, so
collapsing them loses every denial and degrades resume. The ACK CHANNEL as a
whole gets **4 MiB per 10 seconds per connection** (`maxControlEgressBytes`),
after which the connection closes with code 4429 and no preceding error frame.
4429 is the family client's reconnectable throttle code; 1008 is terminal.
Application data sent by `send` and `publish` is not charged to this budget.

`bench/control-egress.mjs` measures the amplification against the built server.
On Bun 1.3.14, 256 ordinary topics with a numeric ref cost roughly 17 KB of
replies. A near-8-KiB frame containing 256 compact topic names plus empty
overflow entries produced about 177 KB across 2,496 replies: **21.6x**, enough
to spend 4 MiB in ten seconds from roughly **20 KB/s** of inbound traffic.
That is a measured shape, not an upper bound: a 128-byte ref made the same
size request produce about 490 KB (**60x**). Sustained numeric-ref overflow
traffic closed at 4.00 MiB with code 4429. Batches without a ref produced no
acknowledgements. These are payload byte counts; network framing is excluded.

A control-shaped frame at or above 8192 BYTES is refused with
`CONTROL_FRAME_TOO_LARGE`; an oversized frame that merely *begins* `{"type"` but
carries a type the adapter does not consume is passed to the app hook untouched
rather than swallowed.

The Vite plugin builds the handler alongside server routes, including TypeScript
and SvelteKit virtual imports. Without it, the adapter bundles the handler with
Rollup, resolves `$lib` and configured aliases, and compiles TypeScript with
esbuild. This fallback does not share modules with SSR routes; the build warns
that the Vite plugin is needed for shared state.

## Client store API

Import the bundled Svelte client from `svelte-adapter-bunserve/client`. Topic
stores connect automatically and release their server subscription when their
last local subscriber leaves. The client works with both adapters' wire protocol.

```svelte
<script>
  import { on, status } from 'svelte-adapter-bunserve/client';
  const messages = on('chat');
</script>

<p>{$status}</p>
{#if $messages}
  <p>{$messages.event}: {JSON.stringify($messages.data)}</p>
{/if}
```

`on(topic)` starts at `null` and emits `{ topic, event, data }` envelopes.
`on(topic, event)` filters that event and emits `{ data }`, also starting at
`null`. Guard either store before reading its value. `on(topic).scan(initial,
reducer)` accumulates events into application state. `onDerived(topicFn, store)`
switches subscriptions when a source store changes.

| Helper | Store value and behavior |
| --- | --- |
| `crud(topic, initial = [], options?)` | Array updated by `created`, `updated`, and `deleted` events; `key` defaults to `'id'`, `prepend` to `false` |
| `lookup(topic, initial = [], options?)` | Object keyed by `options.key` (default `'id'`), updated by the same CRUD events |
| `latest(topic, max = 50, initial = [])` | Last `max` event envelopes |
| `count(topic, initial = 0)` | Counter updated by `set`, `increment`, and `decrement` events |
| `once(topic, event?, options?)` | Promise for the first matching event, then unsubscribes; `options.timeout` is in milliseconds |

`crud` and `lookup` accept an optional `maxAge` in milliseconds. Entries expire
when they have received no create/update within that window. The sweep interval
is half `maxAge`, with a one-second minimum; its timer stops when the last local
subscriber leaves. Seed stores from your SvelteKit load data when the UI needs a
current value before the first live event.

### Connection options and state

Call `connect(options)` before any auto-connecting helper when using custom
options. It returns a singleton; later option changes do not replace an existing
connection. After `connection.close()`, a later explicit `connect(options)` creates
a replacement. Module topic and diagnostic stores, accumulated helpers, and
managed ingress handles follow it; stores obtained from the old connection stay
attached to that closed connection. Reading stores or constructing plugins after
close stays inert until an explicit connect.

With no explicit URL, browser connections use the current page's
origin and `/ws`. Without a browser or explicit URL, SSR stays inert.

```js
import { connect, ready } from 'svelte-adapter-bunserve/client';

const connection = connect({
  path: '/ws',
  auth: true,
  reconnectInterval: 3000,
  maxReconnectInterval: 300000,
  maxReconnectAttempts: Infinity,
  debug: false
});
await ready();
const admitted = connection.send({ type: 'message', text: 'Hello' });
```

All options are optional. `auth` defaults to `false`; use `true` when your server
exports `authenticate`, or a string for a custom auth path. `url` takes precedence
over `path` and enables native clients without `window`, for example
`connect({ url: 'wss://example.com/ws' })`. Reconnect defaults are 3000 ms base,
300000 ms cap before jitter, and unlimited attempts. Delays grow by a factor of
2.2 and apply proportional jitter of +/-25%. `debug` defaults to `false`.

The `status` readable, also available as `connection.status`, has five values:

- `connecting`: an initial connection or retry is being established.
- `open`: the socket is connected.
- `suspended`: the socket is open while the browser tab is in the background.
- `disconnected`: the socket was lost or the connection is temporarily paused.
- `failed`: permanent refusal, exhausted retries, or explicit `close()`.

`ready()` resolves when the connection opens, resolves immediately during inert
SSR, and rejects if the connection closes permanently before opening. Handle that
rejection where refusal is possible. `failure` describes a disconnect using
stable `kind`, `class`, `code`, and HTTP `status` fields. Its `diagnosticReason`
and deprecated `reason` alias are diagnostic text, not localized UI messages.
An intentional `close()` leaves `failure` at `null`. `denials` exposes the latest
subscription denial; `overloads` exposes established-message shedding responses.

The optional auth preflight runs before each connection attempt. It includes
credentials and the adapter's `x-requested-with: XMLHttpRequest` CSRF marker.
Explicit WebSocket URLs determine the corresponding HTTP auth endpoint. A 429
is retried no sooner than `Retry-After`, while network errors and 5xx responses
retry with backoff. Other 4xx refusals are terminal.

### Sending and temporary offline simulation

`connection.send(value)` returns `true` only when serialization completed and the
same open socket accepted the local send call. It returns `false` while
connecting, disconnected, paused, or closed, including when `toJSON()` closes or
pauses the connection. This is local admission, not a server receipt.
Serialization and transport exceptions propagate. JSON values become text frames;
`ArrayBuffer` and `ArrayBufferView` values are sent as binary frames unchanged.

Import `onReplay` from `svelte-adapter-bunserve/plugins/replay/client` and call
`onReplay(topic, { since })` to request history from an SSR sequence and report truncation.
An unanswered replay resumes after reconnection from its last delivered replay
sequence. Presence, cursor and replay helpers keep a permanently closed client
offline until an explicit `connect()`.

`connection.sendSerialized(text)` sends a complete JSON message already encoded
as text without parsing or serializing it again. It requires a primitive string,
returns the same boolean local admission result as `send()`, never queues a
message, and preserves transport exceptions.

`connection.sendQueued(value)` sends immediately when connected or retains the
serialized payload for FIFO delivery on reconnect. The queue holds at most 1000
messages; overflow drops the oldest. Binary views remain binary when queued.

```js
connection.simulateOffline();
connection.sendQueued({ type: 'message', text: 'Deliver after resume' });
connection.resumeOnline();
```

`simulateOffline()` reports `disconnected` immediately, cancels the current socket
or auth attempt, and suppresses reconnect timers and browser reconnect triggers.
Subscriptions, listeners, recovery offsets, and queued messages survive. A
cancelled scheduled or active retry refunds its reservation. `resumeOnline()`
starts a fresh attempt with the configured URL and fresh auth, then restores
subscriptions and queued sends. Both calls are idempotent and inert during SSR
without a URL. Permanent close, refusal, and retry exhaustion cannot be resumed.
Use `connection.close()` for permanent disconnection.

Recovery keeps the requested offset until a matching topic/ref acknowledgement,
even if newer live frames arrive first. Denial discards speculative progress.
Replay truncation and relay gaps clear the offset while retaining its epoch;
rehydration adopts the announced epoch. Standalone and inline truncation are
reported once per outstanding replay request.

The client also handles browser offline/online and visibility events, suspended
devices, silent sockets, batched subscriptions, and recovery on reconnect.
Advanced protocol consumers can use `onRequest`, `registerWireCodec`,
`setTopicManaged`, and `bindIngress`; their typed contracts are in
[`src/client.d.ts`](src/client.d.ts).
Module-level `onRequest` handlers and unresolved `once` listeners follow an
explicit `connect()` after `close()`.

## HTTP requests

The application's `request.signal` aborts when a client disconnects before the
native request body's completion has been observed. After that, a disconnect
does not abort the signal, so work already accepted by the application can
finish. Bodyless requests remain sensitive to disconnect while the response is
pending. Streaming responses remain registered until they finish or are
cancelled, so graceful shutdown waits for them up to `SHUTDOWN_TIMEOUT`. When
shutdown stops waiting, it aborts any application request signals still active
with an `AbortError` whose message names the shutdown.
A response that finishes releases its registration and cancels any unread
request body.

An encoded separator inside the admin prefix stays encoded when passed to
`admin()`: `/__realtime/..%2Freflect` reaches that handler unchanged. Split
the pathname on `/` before decoding each segment, so a decoded `..` cannot
walk the application's routing.

Request bodies read ahead into a 64 KiB queue, with at most one native chunk
beyond that watermark, then honor consumer backpressure. Bun exposes body
completion through its readable stream. For a larger unread body, the signal
remains sensitive to disconnect until that completion has been observed. An
application that cancels its body before completion keeps the same disconnect
behavior. Native body errors abort the signal even while the queue is full.

`bodyLimits` narrows the request body budget before application parsing:

```js
adapter({
 bodyLimits: [
  { path: '/app/avatar', bytes: 64 * 1024 },
  { path: '/app/admin', prefix: true, methods: ['POST', 'PUT'], bytes: 16 * 1024 }
 ]
});
```

Paths are decoded absolute paths including SvelteKit's base and are matched before
an application reroute. Queries and trailing slashes do not affect matching; a
prefix ends at a segment boundary. Every matching rule narrows the process-wide
`BODY_SIZE_LIMIT`; rules cannot raise it. `BODY_SIZE_LIMIT=0` disables that global
ceiling while route rules still apply. A rule with `bytes: 0` accepts no body bytes.
GET and HEAD bodies are not read, so rules cannot explicitly name those methods.

Declared and chunked uploads use the same budget for SSR, authentication, and
admin requests. Authentication also retains its 64 KiB ceiling. An oversized
upload receives 413 even when a handler catches the body error or remains pending;
an already-started streaming response is cut short instead. The application's
request signal aborts on overflow. A response sent before upload completion closes
its connection. Input pauses when the application queue reaches 64 KiB. As on the
lead transport, a full-queue pause lasts at most ten seconds before one further
native read checks queued input; finite route budgets continue to apply during
these checks. Unread excess bytes are detected on those checks rather than eagerly
buffering an entire configured budget. Consumer demand resumes input immediately.
The Vite dev plugin applies these rules to its auth and admin endpoints; preview
owns its transport. Verify SSR behavior against the generated Bun server.

HEAD responses omit the body while retaining available GET metadata. Static
responses keep their known byte length. SSR HEAD responses cancel the body
without reading or compressing it, including a buffered GET fallback. They
retain a declared `Content-Length`; when none was supplied, the adapter leaves
it unset. SSR GET compression uses the same weighted `Accept-Encoding`
negotiation as static responses. Every HEAD response gets the current server `Date`. Application-supplied
Date values are removed from SSR, authentication and admin responses.

Bun writes `Transfer-Encoding: chunked` on an unknown-length HEAD, although no
body follows; svelte-adapter-uws omits both framing headers there. A declared
HEAD length is preserved without reading the application body. A 304 without a
declared representation length omits Content-Length.

HTTP/1.1 pipelining follows the transport's response lifetime. On Bun 1.4.4,
two synchronous `/healthz` requests in one TCP write receive two responses.
A delayed SvelteKit response followed immediately by another request closes
the connection without a response, as with svelte-adapter-uws. Use sequential
keep-alive requests or separate connections for asynchronous handlers.
`test/live/http-pipelining-check.mjs` pins both cases against the built server.

## Static files

Static and prerendered `.css`, `.csv`, `.htm`/`.html`, `.ics`, `.js`/`.mjs`,
`.md`, `.txt`, `.vtt` and `.yaml`/`.yml` files declare `charset=utf-8` in
`Content-Type`. Their bytes are served unchanged; store these text assets as
UTF-8. The declaration also appears on compressed responses; 304 responses omit Content-Type.

A static path with a dot-prefixed segment (`/.env`, `/deep/.hidden`,
anything under `/.git/`) is left out of the static index and answers `404`.
The files that land in `static/` by accident are exactly the sensitive ones -
a stray `.env`, an `.htpasswd`, editor backups, an unpacked `.git` - and
`adapter-node` refuses plain dotfiles too, so an app migrating from it keeps
that posture. The exclusion is segment-wise and decided once while the index
is built: there is no per-request check to bypass. An encoded request
(`/%2Eenv`) reaches nothing either - the static lane looks the pathname up
as a Map key, decoded only to find a file by its own name, and `/.env` was
never a key. A refused directory is not descended into, so an unpacked
`.git` is never even read.

A file whose name a browser percent-encodes - a space, or a letter outside
ASCII such as `Übersicht.pdf` - is served for that encoded spelling, as under
SvelteKit's Node adapter and svelte-adapter-uws: `/My%20Report.pdf`,
`/%C3%9Cbersicht.pdf`, with the escapes in either letter case. It is decoded
with `decodeURI`, so an escaped `/` and the other characters it leaves encoded
(`#`, `?`, `&` among them) stay encoded: `/My%2FReport.pdf` does not reach into
a directory `My/`, and a name carrying a `#` or `?` is not served for an
escaped spelling. A name written decomposed, as some macOS tools write it, is
found for the composed spelling a browser sends too. With `staticDotfiles` on,
an escaped dotfile (`/%2Ehtpasswd`) is served like its plain spelling. A
download's `Content-Disposition` carries its file name as UTF-8 bytes, as
svelte-adapter-uws writes it.

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

## Response bodies

SSR responses accept strings, ArrayBuffers and exact typed-array/DataView
ranges as body chunks. Direct responses collect a single ready chunk followed
by EOF for compression; a second chunk or pending continuation streams
uncompressed. Anonymous GET deduplication can collect several ready chunks
within one shared check-phase turn, up to 512 KiB, and skips collection when
the declared Content-Length exceeds that cap. Disconnects cancel the source
and release its reader even when the source's cancel promise never settles.
A fully read POST keeps its completed request signal intact.

HEAD preserves a supplied Content-Length without pulling the body. Application
Transfer-Encoding is removed from SSR and authentication responses so Bun
chooses wire framing.

## Extra server entries

A Vite plugin can put code in front of the handler by writing a file into the
SvelteKit server output whose name starts with `__` and ends in `.js`
(svelte-realtime's generated registry is one). The adapter bundles each such
file as its own entry and imports all of them at the top of the built
`index.js`, in file-name order, before the handler loads, so the order is the
same on every filesystem. They are static ES module imports: one whose top
level awaits does not hold back the next, so an entry that needs another's
finished work should import that entry itself. Each is imported by the file
name Rollup wrote for it, which differs from the entry name when the name
holds a character Rollup will not put in a file name.

An entry's top level, up to its first `await`, runs before SvelteKit's server
is initialized, so `$env/dynamic/*` is still empty there; read `process.env`,
or read the dynamic env inside a function called later.

## Plugins and testing helpers

Every entry below includes TypeScript declarations and uses the
`svelte-adapter-bunserve` package prefix.

| Entry | Purpose |
|---|---|
| `./plugins/replay`, `./plugins/replay/client` | Retained topic history and replay-aware client stores |
| `./plugins/presence`, `./plugins/presence/client` | Presence rosters and client updates |
| `./plugins/channels`, `./plugins/channels/client` | Typed topic event channels |
| `./plugins/cursor`, `./plugins/cursor/client` | Cursor state, codecs and rendering |
| `./plugins/groups`, `./plugins/groups/client` | Group membership and client stores |
| `./plugins/throttle`, `./plugins/ratelimit` | Message throttling and rate limits |
| `./plugins/middleware`, `./plugins/queue` | Hook composition and bounded work queues |
| `./plugins/lock`, `./plugins/session`, `./plugins/dedup` | Locks, sessions and duplicate suppression |
| `./plugins/crdt`, `./plugins/crdt/client`, `./plugins/crdt/replica`, `./plugins/crdt/channel` | Shared CRDT documents, authority and channels |
| `./plugins/smooth`, `./plugins/smooth/client`, `./plugins/smooth/random` | Authoritative motion, interpolation and seeded randomness |
| `./plugins/webhooks` | Controlled outbound webhook delivery |
| `./safe-url` | URL and IP policy checks, including resolved-address validation |
| `./observability` | Telemetry declarations, diagnostic envelopes and trace-context helpers |
| `./platform-contract` | Generated public Platform member inventory |
| `./testing` | A native Bun test server and protocol helpers |
| `./sim` | Seeded in-memory simulation, replay and golden comparisons |

The CRDT authority's `applyUpdate()` returns `null` for updates and resync
snapshots already held by the replica. These merges trigger neither fan-out nor
persistence. Out-of-order inserts and deletes still count as durable changes:
they are forwarded and stored while waiting for their missing predecessors.

Use `createTestServer` from `svelte-adapter-bunserve/testing` in Bun tests. It
starts on an available port and exposes `url`, `wsUrl`, `platform`, tracked
connections and async `close()`. Always await `close()` during teardown. No
native uWebSockets addon is required. Set `host: '127.0.0.1'` to bind a specific
address and use it in the returned URLs; omission keeps the wildcard listener
and `localhost` URLs. The optional `ws` peer supports Node-style client sockets
in test code.

Use `runSim`, `runSimMany` and `replaySim` from
`svelte-adapter-bunserve/sim` for deterministic protocol scenarios without
opening a network listener. Public simulator helpers and the production
runtime's internal golden runner have separate entrypoints. `LEAK_LANE_THRESHOLDS`,
`judgeLeakLane` and `judgeLeakLaneSelfCheck` expose the shared memory-growth,
retention, connection and measurement-health checks for custom leak lanes.

`npm test` includes public plugin and simulator tests. `npm run test:public-native`
checks native server and wire contracts under Bun.

## Platform member inventory

`svelte-adapter-bunserve/platform-contract` exports the frozen
`PLATFORM_MEMBERS` array and the TypeScript `PlatformMember` name union.
They are generated from this adapter's complete public `Platform` declaration,
including contextual `requestId`. Symbol-keyed internals and plugin-added
members are outside the inventory.

Wrappers read through the original object to retain live getters and invoke
methods with their original receiver:

```js
import { PLATFORM_MEMBERS } from 'svelte-adapter-bunserve/platform-contract';

export function forwardPlatform(source) {
	const forwarded = {};
	for (const name of PLATFORM_MEMBERS) {
		if (!(name in source)) continue;
		Object.defineProperty(forwarded, name, {
			enumerable: true,
			get() {
				const value = source[name];
				return typeof value === 'function' ? value.bind(source) : value;
			}
		});
	}
	return forwarded;
}
```

The inventory describes declared members. It does not certify an arbitrary
object or infer which adapter produced it. Preserve absent members: HTTP-only
builds have a smaller surface, and per-request fields belong to a request or
connection platform. Require only capabilities supplied by the adapter and
context in use; plugin-added fields follow their plugin's contract.

After changing `Platform`, run `node scripts/generate-platform-contract.js`.
`npm run check:platform` rejects stale generated files, and the native suite
compares the inventory with a production connection platform.

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
`envPrefix` must be a string; another type throws `TypeError` when configuring
the adapter. Proxy warnings name the settings with this prefix.

| variable | default | what it does |
|---|---|---|
| `HOST` | `0.0.0.0` | listen address |
| `PORT` | `3000` | listen port |
| `ORIGIN` | unset | the public origin, e.g. `https://example.com`. Set it behind a proxy so redirects and the CSRF check use the address clients actually used |
| `CANONICAL_HOST_ALIASES` | disabled | Comma-separated host authorities that redirect to `ORIGIN` with 308. Matching is case-insensitive and port-sensitive. Requires an absolute HTTP(S) origin with no path, credentials, query or fragment; the canonical authority cannot also be an alias |
| `PROTOCOL_HEADER` | unset | header carrying the client's protocol, e.g. `x-forwarded-proto` |
| `HOST_HEADER` | unset | header carrying the client's host, e.g. `x-forwarded-host` |
| `PORT_HEADER` | unset | header carrying the client's port |
| `ADDRESS_HEADER` | unset | header carrying the client address, e.g. `x-forwarded-for` |
| `XFF_DEPTH` | `1` | which entry of the forwarded chain to trust, counted from the right - `1` is the rightmost, the address your nearest proxy appended. Read only when `ADDRESS_HEADER` is set; a value that cannot select a hop throws at boot where it would be read, and warns where it would not |
| `TRUSTED_PROXIES` | unset | comma-separated IPs and CIDR ranges, IPv4 and IPv6. When set, an address claim is honoured only from a peer in this set, and one from anywhere else is ignored in favour of the socket address, once with a warning. Unset trusts the header verbatim |
| `BODY_SIZE_LIMIT` | `512K` | largest request body accepted, with `K`/`M`/`G` suffixes and an optional trailing `B`. `0` disables the cap; a negative or non-finite value such as `Infinity` is refused rather than read as "no limit" |
| `IDLE_TIMEOUT` | `120` | seconds a connection may go idle before Bun closes it. See Timeouts |
| `SHUTDOWN_TIMEOUT` | `30` | shared shutdown budget in seconds for the hook, in-flight drain and async cleanup listeners; `0` waits without a deadline. A second SIGTERM or SIGINT aborts active requests and exits with code 1, including while startup is pending. |
| `SHUTDOWN_DELAY_MS` | `0` | milliseconds to keep serving after the signal arrives, so a load balancer notices the readiness 503 before connections are cut |
| `SHUTDOWN_RECONNECT_WINDOW_MS` | `3000` | the window advertised in the `reconnect` frame sent to WebSocket clients before the drain closes them |
| `SSL_CERT` | unset | path to a TLS certificate. TLS is enabled only when both this and `SSL_KEY` are set |
| `SSL_KEY` | unset | path to the matching TLS private key |

`PROTOCOL_HEADER`, `HOST_HEADER` and `PORT_HEADER` are trusted as given. Set
them only behind a proxy that overwrites those headers on every request;
otherwise a client can choose its own origin by sending them.

For example, `ORIGIN=https://example.com CANONICAL_HOST_ALIASES=www.example.com,old.example.com`
redirects listed aliases while preserving the path and query. Health/readiness
probes and unlisted hosts keep their normal behavior. With configured host,
port or protocol headers, Bun exposes the final repeated header line as the
incoming authority. A comma inside a single configured value is rejected with
400 rather than interpreted as a proxy chain. Set those headers only behind a
proxy that replaces untrusted client values.

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

Requires [Bun](https://bun.com) installed. The supported floor is **Bun 1.4.4**
(`engines.bun`). Earlier Bun 1.3.14 leaves an incomplete upload's TCP connection
open after sending an early response with `Connection: close`; cancelling its
native body does not close it either. Bun 1.4.4 closes it and passes the generated
server's body-budget and incomplete-upload tests. Historical probe and benchmark
reports retain the runtime versions on which they were measured.
CI pins Bun 1.4.4 for the API probe, live and leak
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
under Node, and again under Bun in CI (`bun scripts/bun-test-lane.mjs unit`).
It also covers the WebSocket demux and the authorization gate, which reach the
app through a specifier the build injects: under the `bunserve-test` condition
the `#ws-handler` package import resolves that specifier to a stub
(`test/helpers/ws-handler-stub.mjs`), so `handler/ws.js` and
`handler/platform.js` can be driven without a build. Put frame-shape and
hook-contract assertions there - it is the fast lane:

```sh
npm test   # requires Node 22+ for the test-runner glob
```

The unit and sim suites run in test mode on both runtimes (`NODE_ENV=test`:
preloaded by `test/helpers/test-env.mjs` on Node, set by
`scripts/bun-test-lane.mjs` on Bun), and so do the golden corpora under
`npm run sim:golden` and in CI. In test mode a framework invariant violation
throws rather than logging. A test that drives the runtime into one therefore
fails, and a stand-in socket has to carry what a real upgrade hands `open` -
`test/helpers/upgrade-data.mjs` builds that.

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
a path, and two hundred distinct unencoded ones, add no decodes at all. The one
exception is the lookup of an asset by its encoded name, which decodes once per
request, as svelte-adapter-uws's does, and only after both cached lookups
missed.

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
and gates the way the svelte-adapter-uws lane gates, so a record from either
runtime reads the same. The verdict rules are pure functions in
`test/leak/rules.mjs`, unit-tested in milliseconds; the lane itself spends
minutes, because a slope needs a window to be fitted over.

Three gates are the family's, constant for constant. Resident-set growth is
judged by the shared `detectGrowth` kernel: the least-squares slope over the
window must exceed 256 KiB per sample, the total delta 16 MiB, and the fit's
r-squared must reach 0.5 - a runner whose memory merely wanders produces no
fit and cannot fail the build. Beside it an error-rate ceiling of 0.5% and a
p95-creep ceiling of 50% over the warmed baseline, because a window that lost
its requests has not shown the memory is flat, it has shown the server
stopped answering.

The family also gates two signals RSS cannot give on this runtime.
Retention is heap plus external, read after forcing the collector until two
readings agree, at both ends of the run: what survives a settled collection
is held on purpose by something, and a typed array lives outside the JS
heap, so buffers - which are what a server retains - move `external` and
barely touch `heapUsed`. One forced collection is not settled: comparing
single readings made a healthy run's growth swing between +7.5% and +67.6%.
It fails only past BOTH a 30% ratio and a 2 MiB floor, because a bounded
structure filling once is not a leak, and on a single-digit-MiB baseline the
ratio alone cannot tell the two apart. And the live WebSocket count after
every client has closed, because a close path that fails to release leaves
connections registered while the allocator quietly reuses their pages. An
unreadable live count is a lane health failure, never a zero-connections pass.

The `ws` scenario holds four sockets and cycles through 512 topic names at
200 subscribe/publish/unsubscribe operations per second, matching the family
workload. The subscribe acknowledgement and the fixture application's
unsubscribe-hook confirmation must arrive for a unit to succeed. The sockets close before cooldown and the final live count.
The separate `churn` scenario opens a connection, subscribes to one of 32
topics and closes it per unit. Its rate comes from the fixture's upgrade
limit: 80% of the configured allowance per second, floored to one, or 50/s
when that limit is disabled. A denied subscription counts as a failed unit.

The measurement has a shape, and each phase exists because its absence
produces a confident wrong answer: a sixty-second warmup; a forced-collection
baseline; a worked but UNSAMPLED resettle, since sampling straight after a
collection measures the climb back to the working set (303 KB/s at
r-squared 0.996 here - a textbook leak, drawn by the measurement); a settle
loop that opens the window only once the reading has held inside a band for
eight rounds in a row; then the window, sampled every two seconds. A run that
never settled, could not read the probe, or lost its warmup is reported as
the lane's problem (exit 2), not the server's (exit 1), and CI fails on both.

It ends with a self-check that settles a clean server and then plants a real
leak for the window, and requires the GROWTH gate itself to have caught it. A
verdict failing on error rate or p95 does not count, and neither does the
retention gate: a deliberately leaking server degrades in those ways too, and
a self-check satisfied by any of them would certify a lane whose family gate
had gone blind.

It has its own CI job and is not part of `npm run test:live`, because it
spends minutes by design and a gate that slow in the dev loop is one people
stop running. The flags are the uws lane's, and a JSON record with every
sample and settle reading is written per run:

```sh
npm run test:leak                              # four scenarios, 3-minute windows
npm run test:leak -- --scenario ws             # one scenario, for investigating a trend
npm run test:leak -- --minutes 8               # a longer window settles a plateau question
npm run test:leak -- --out ./leak-records      # where the record goes (default: test/leak/records/)
```

`--minutes` accepts finite numbers from 1 to 60 inclusive, including `1.5`
and `1e1`. The default is 3. Each flag accepts `--name value` or `--name=value`;
values may contain `=`, and the first occurrence of each flag wins. The first
value must be present, nonempty and valid; errors fail before the fixture build.
`--scenario` accepts `http`, `ws`, `churn`, `selfcheck` or `all`.

The fixture's probe is `/__leak?op=mem|gc|retain|release`, armed by
`LEAK_PROBE=1` on the server the lane spawns and answering 404 on every other
server; `op=gc` forces a synchronous full collection, which is why it is not
reachable in anything anyone deploys.

WHAT A HEALTHY RUN MEASURES on Bun, so the headroom is legible and a future
reader can tell drift from a threshold that was always loose. The rules are
the family's; the readings are this runtime's, and JavaScriptCore's allocator
is not V8's - per-runtime calibration is expected and stated rather than
hidden. Use the default three-minute window for calibration; a one-minute
window can fail the p95-creep gate before the workload settles. This machine:

| Scenario (window)   | RSS slope / fit                          | Growth verdict          | Retained (heap+external)          | p95 warmed -> window | Settle rounds |
|---------------------|------------------------------------------|-------------------------|-----------------------------------|----------------------|---------------|
| http (3 min)        | flat, 104-109 MiB, r-squared 0.00        | delta-within-tolerance  | 8.5 -> 8.6 MiB (+0.7%)            | 4.9 -> 3.9 ms        | 19            |
| ws (3 min)          | 202 -> 170 MiB (fell), r-squared 0.68    | delta-within-tolerance  | 5.2 -> 5.6 MiB (+8.3%)            | 8.4 -> 6.7 ms        | 18            |
| churn (3 min)       | 110 -> 100 MiB (fell), r-squared 0.62    | delta-within-tolerance  | 4.8 -> 5.9 MiB (+23.6%, +1.1 MiB) | 20.1 -> 21.0 ms      | 10            |
| churn (8 min)       | 108 -> 102 MiB (fell), r-squared 0.32    | delta-within-tolerance  | 4.8 -> 5.9 MiB (+24.3%, +1.1 MiB) | -                    | 9             |
| selfcheck (3 min)   | 111 -> 683 MiB, r-squared 1.00           | growth-detected         | 9.4 -> 1134 MiB                   | 5.5 -> 3.9 ms        | 9             |

Bun 1.3.14 on Windows, one run each; the record for every run is in its JSON
file. The held-socket `ws` run completed 35,909 operations with no failures
and ended with zero live connections. The connection-churn runs predate the
separate held-socket scenario. Two things the table says that the thresholds alone would not.
Connection churn retains the same 1.1 MiB whether it churns nine thousand connections or
twenty-four thousand, which is a bounded structure reaching its bound rather
than growth per connection - a per-connection leak would have tripled between
the rows - and it is why the retention gate has a byte floor as well as a
ratio. And the resident set under both healthy workloads FELL across the
window while the settled heap held still: Bun's allocator hands pages back
mid-run, which is one more reason the family gate needs a fit and not just a
slope.

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
node -C bunserve-sim --import ./test/helpers/test-env.mjs scripts/sim-golden.js \
  --corpus adapter-single \
  --against ../svelte-adapter-uws/test/dst-goldens/adapter-single.golden.json
```

The `-C bunserve-sim` condition resolves the WebSocket handler to the
simulator's stub, and the preload runs the corpus in test mode, as
`npm run sim:golden` does. A framework invariant check that fires during a seed
is recorded as a violation of that run whether or not a boundary contained its
throw, so it moves the fingerprint and fails the verification.

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
`node -C bunserve-sim --import ./test/helpers/test-env.mjs scripts/sim-golden.js --corpus <name> --update`,
and the corpus diff is the reviewable
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
