# node:cluster under Bun.serve, measured

What Bun's `node:cluster` socket sharing gives a `Bun.serve` WebSocket server,
measured by `probe/cluster-probe.mjs`: a primary forks two workers onto one
listen socket, clients connect and subscribe, every worker is ordered to
publish, and the primary attempts the SharedArrayBuffer hand-off that
svelte-adapter-uws's `primaryInit` contract needs.

Re-run with `bun probe/cluster-probe.mjs` on the generation under test. The
probe self-reports and exits; 25s timeout.

## Transcript, Bun 1.4.0 (Windows x64)

```
bun = 1.4.0
distribution = all 14 clients landed on one worker
publishes heard by the client = ["topic:pid-69440"]
client pid = pid:69440
client A worker = pid:69440
client B worker = pid:69440
clients landed on the same worker = true
client A saw the publish = true
client B saw the publish = true
worker observation = pid 69440: sab arrived as [object Object] (structured-clone copy or serialization)
worker observation = pid 75740: sab arrived as [object Object] (structured-clone copy or serialization)
```

## What each observation settles

- **`sab arrived as ... structured-clone copy`, both workers.** A
  `SharedArrayBuffer` sent over cluster IPC does not arrive as shared memory:
  each worker receives a dead copy. uws's `primaryInit` contract promises
  every worker the SAME buffer (its typings' example mutates it cross-worker),
  which is a thread-shaped promise this process-shaped primitive cannot carry.
- **`publishes heard by the client = ["topic:pid-69440"]`.** BOTH workers were
  ordered to publish to the topic the client subscribes to; the client heard
  only the publish made by its own worker. `Bun.serve`'s topic registry is
  per-process, so under N workers every topic silently serves N disjoint
  audiences. This is placement-independent: it holds whichever worker a
  client lands on.
- **`all 14 clients landed on one worker` (Windows).** Sequential loopback
  connections did not distribute across workers here. Anything driving
  cross-worker behaviour on Windows must order the workers over primary IPC
  (as this probe does for the publishes) rather than relying on client
  placement.

## What this decides

The socket-sharing primitive is real, and it is not the blocker for the
`workers` / `primaryInit` adapter options. The blockers are the two
observations above - the shared-memory init and the cross-worker publish
relay are what those options MEAN in uws, and the process primitive carries
neither - plus the per-process protective state (the admission ceiling, both
rate limiters) that would silently become N times looser per worker.
Cross-worker fan-out and shared accounting are what the extensions bus
provides for multi-node; the same answer covers multi-worker. The adapter
stays single-process per instance; scale out by instances.

`WS_OPTION_GAPS` in `test/unit/api-parity.test.mjs` carries this as the
recorded reason for both options.
