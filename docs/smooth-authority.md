# Smooth authority delivery

**Decision:** Use the authority drain result to deliver committed updates,
acknowledgements and one-shot events. Each tick belongs to the application;
[the Smooth overview](../README.md#smoothing-controls)
describes prediction, pacing and client setup.

## Deliver one completed result

**Required action:** Deliver the committed result once, including a partial
result returned with a callback failure, before applying the application's
failure policy. Owner acknowledgements use `sendWire`; updates and events use
`publishWire` with their owner-exclusion and `toAuthor` rules.

```js
// Server: the authoritative command processor + the binary codec.
import {
  createSmoothAuthority,
  createSmoothWireCodec,
  SmoothDrainError,
  SMOOTH_TOPIC_PREFIX,
} from "svelte-adapter-bunserve/plugins/smooth";

const authority = createSmoothAuthority({ apply }); // apply: (state, command, ctx) => state
const codec = createSmoothWireCodec();

// Per tick (the caller owns the cadence). The wire topic is the room name
// behind the reserved smooth prefix - the same topic the client's tap binds.
const wireTopic = SMOOTH_TOPIC_PREFIX + room;
let result;
let failure;
try {
  result = authority.drain();
} catch (error) {
  if (!(error instanceof SmoothDrainError)) throw error;
  result = error.partial;
  failure = error;
}
const { updates, acks, events, idle } = result;
for (const u of updates)
  platform.publishWire(
    wireTopic,
    "update",
    { key: u.key, data: u.state },
    codec,
    u.commanded ? { excludeWs: u.ws } : undefined,
  );
for (const a of acks)
  platform.sendWire(
    a.ws,
    wireTopic,
    "ack",
    { id: a.id, state: a.state, t: Date.now() },
    codec,
  );
// Discrete one-shot events (ctx.emitEvent): author-excluded by default - the
// owner drew its own copy optimistically - unless the event opted into toAuthor.
// The codec declines 'event', so this rides the JSON fallback, which honors excludeWs.
for (const e of events)
  platform.publishWire(
    wireTopic,
    "event",
    { type: e.type, key: e.key, data: e.data, id: e.id },
    codec,
    !e.commanded || e.opts?.toAuthor ? undefined : { excludeWs: e.ws },
  );
// Publish the committed prefix before applying the application's failure policy.
if (failure) throw failure.cause;
```

## Handle callback failures

**Mechanics:** `drain()` wraps a thrown `apply` or `onMissing` value in
`SmoothDrainError` (`code: 'SMOOTH_DRAIN_FAILED'`). Its `cause` is the exact
original value, even `undefined`. Its non-enumerable `partial` contains only
committed updates, acknowledgements and events, with `idle: false`.

**Required action:** Publish that partial result through the ordinary delivery
path exactly once. It includes earlier entities and a committed owner or
`onMissing` phase before a failed injection. Calling `drain()` again does not
recover the committed output.

**Limits:** The failed batch's state and events are discarded. Its queued
commands remain subject to `queueCap`. Keep `apply` pure and return immutable
state; callback side effects are not rolled back.

**Required action:** Own failure handling and tick scheduling, including whether
retained work should be retried after an error. A repeated failure needs an
application policy; it does not replay output already committed by an earlier
drain.
