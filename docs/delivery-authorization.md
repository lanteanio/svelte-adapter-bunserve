# Delivery authorization

Install one worker-wide policy from `hooks.ws.init` to check access immediately
before an adapter-built application frame reaches each connection:

```js
export function init({ platform }) {
	platform.authorizeDelivery((ws, delivery) => {
		const session = ws.getUserData().session;
		return session.active && session.topics.has(delivery.topic);
	}, { timeoutMs: 5000 });
}
```

Only `true` admits a delivery. A false answer closes that connection with 1013;
a throw, rejected promise, non-boolean answer or timeout closes it with 1011.
Admission hooks run again when the client reconnects. Unsubscribe connections
when their access changes; the delivery policy catches frames racing that change.

The frozen context contains `topic`, `event`, `data`, `binary` and `kind`. Replay
frames name their application topic, without `__replay:`, and use kind `replay`.
Binary frames name their logical topic and have no parsed event or data. Each
event in a batch is checked. Shared text frames reuse one parsed context across
recipients; payload data is not frozen.

A promise holds the frame and all later frames for that connection in order.
Control frames and payload-free adapter markers bypass the policy but stay
behind held frames. Frames waiting on native backpressure are checked after
drain. Adapter-initiated close and shutdown wait for held deliveries, bounded by
`timeoutMs` (default 5000, maximum 2147483647 milliseconds).

`maxPendingBytes` defaults to `websocket.maxBackpressure` (1 MiB). The bound
counts native buffered bytes and held entries: application text costs twice its
encoded size, binary/control frames once, plus 128 bytes per entry. A frame
offered when existing backlog already exceeds the bound returns send status 2;
`closeOnBackpressureLimit` also closes the connection. A frame is not refused
for its own size when the queue is empty. `platform.bufferedAmount` and pressure
samples include held payload bytes. Direct transport drops and delivery queue
overflows feed the pressure drop window even without a metrics registry.

Policies may issue adapter operations. Those operations run after the complete
call being decided, including deferred serialization, codec work and sequence
allocation. Scalar options and entry references are captured; keep payload
objects and codecs unchanged until that enclosing call returns. Nested wire
sends return 0, and nested game publication returns `{ seq: null, delivered: 0 }`.

An installed policy changes native topic fan-out into an O(connections) walk.
An armed publication reports whether subscribers existed, independently of their
decisions. Without a policy, publishing retains native fan-out. Raw socket
`send`, `publish` and direct `end` calls remain outside the policy; a direct
`end` only flushes frames already handed to the transport.

Refusal emits `delivery-authorization.denied`; failures emit
`delivery-authorization.failed`. Their `reason` distinguishes denial, callback
failure, invalid result and timeout. `closeCode` is null when the connection had
already closed before the decision settled. Diagnostics do not include payloads.
