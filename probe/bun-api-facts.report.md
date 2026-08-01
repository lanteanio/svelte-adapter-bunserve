# Bun server API facts

Generated 2026-08-01T02:49:00.146Z by `probe/bun-api-facts.mjs`.

- Bun version: **1.3.14** (revision 0d9b296af33f2b851fcbf4df3e9ec89751734ba4)
- Platform: win32/x64

Observed behavior only; interpretation lives in the adapter design docs.
Re-run after every Bun upgrade; review any diff before trusting the upgrade.

## send-return-codes

- send("ping") on an open socket returns
  - 4
- send(64-byte binary) on an open socket returns
  - 64
- send("") on an open unburdened socket returns
  - 0
- getBufferedAmount() right after that empty send
  - returned 0
- send(0-byte binary) on an open unburdened socket returns
  - 0
- zero-length frames the client actually RECEIVED from those two sends
  - ["text","binary"]
- distinct send() return values during a 1MiB-frame burst (value -> first iteration)
  - 1048576 @ 0, -1 @ 1, 0 @ 17
- getBufferedAmount() right after the burst
  - returned 16777366
- readyState of the fresh socket after its client closed
  - returned 3
- send("late") on that fresh client-closed socket returns
  - returned 0

## backpressure-limit

- send() results with backpressureLimit=64KiB during a 16x1MiB burst
  - 1048576, -1, 0
- send("") on the socket while it is past the backpressure limit returns
  - 0
- drain() handler invocations after the burst settled
  - 1
- getBufferedAmount() after settle
  - returned 0
- zero-length frames the client received after the drain settled
  - []

## publish

- server.publish("room", "hello") returns
  - 5
- server.publish to a topic with zero subscribers returns
  - 0
- subscriber count that received the server.publish
  - AB (A=1, B=1)
- wsA.publish("room", "from-A") returns
  - returned 6
- default publishToSelf: did the publishing socket receive its own ws.publish?
  - A=0, B=1
- ws.isSubscribed("room") on the open socket
  - returned true
- typeof server.subscriberCount
  - function
- server.subscriberCount("room") with both sockets subscribed
  - returned 2
- server.subscriberCount on a topic nobody subscribed
  - returned 0
- server.subscriberCount("room") after one unsubscribe
  - returned 1

## publish-backpressure

- distinct server.publish return values during a 24x1MiB burst (value -> first iteration)
  - 1048576 @ 0
- getBufferedAmount() on the subscriber right after the burst
  - returned 1048586
- server.publish("room", "small") once the socket is saturated
  - returned 5

## wire-transport

- ws.subscribe on a topic containing a NUL byte returns
  - returned true
- ws.isSubscribed on the NUL topic
  - returned true
- server.subscriberCount on the NUL topic
  - returned 1
- server.publish(NUL topic, 7-byte binary) returns
  - returned 7
- server.publish(NUL topic, "text") returns
  - returned 17
- server.publish(NUL topic, binary, compress=true) returns
  - returned 7
- what the NUL-topic subscriber received (binary frames byte-exact / text frames)
  - binary=2 byteExact=true, text=["text-on-nul-topic"]
- ws.unsubscribe on the NUL topic returns
  - returned true
- server.subscriberCount on the NUL topic after unsubscribe
  - returned 0

## close-vs-terminate

- client close event after server ws.close(4001, "probe-close")
  - {"code":4001,"reason":"probe-close","wasClean":false}
- ws.terminate exists
  - function
- client close event after server ws.terminate()
  - {"code":1006,"reason":"Connection ended","wasClean":false}
- ws.close(1001, "draining") on the server
  - returned undefined
- client close event after ws.close(1001)
  - {"code":1000,"reason":"draining","wasClean":false}
- ws.close(1012, "draining") on the server
  - returned undefined
- client close event after ws.close(1012)
  - {"code":1012,"reason":"draining","wasClean":false}

## closed-socket-behavior

- readyState on the dead server socket
  - returned 3
- subscribe("t") on a closed socket
  - returned true
- unsubscribe("room") on a closed socket
  - returned true
- isSubscribed("room") on a closed socket
  - returned false
- getBufferedAmount() on a closed socket
  - returned 0
- send("x") on a closed socket
  - returned 0
- publish("room","from-closed") on a closed socket, with one LIVE subscriber on the topic
  - returned 11
- frames the live subscriber actually RECEIVED from that closed-socket publish
  - ["from-closed"]

## prototype-patch

- prototype constructor name
  - ServerWebSocket
- prototype is extensible
  - true
- stamped method resolves ws.data on the already-open socket
  - true
- second server shares the same prototype object
  - true
- socket opened AFTER the stamp, on the other server, sees the method
  - true
- ws.data holds the upgrade-time data object
  - {"probe":true}

## idle-timeout-cap

- Bun.serve accepts websocket.idleTimeout=960
  - accepted
- Bun.serve accepts websocket.idleTimeout=961
  - THREW: websocket expects idleTimeout to be 960 or less
- Bun.serve accepts websocket.idleTimeout=1200
  - THREW: websocket expects idleTimeout to be 960 or less

## http-idle-timeout

- DEFAULT (unset), stream idle 12s
  - "CUT: The socket connection was closed unexpectedly. For more info"
- DEFAULT (unset), stream idle 2s
  - "first\nsecond\n"
- idleTimeout=30s, stream idle 12s
  - "first\nsecond\n"
- idleTimeout=0, stream idle 12s
  - "first\nsecond\n"
- Bun.serve accepts idleTimeout=0
  - accepted
- Bun.serve accepts idleTimeout=255
  - accepted
- Bun.serve accepts idleTimeout=256
  - THREW: Bun.serve expects idleTimeout to be 255 or less

## max-payload

- client close event after sending 4KiB with maxPayloadLength=1024
  - {"code":1006,"reason":"Connection ended","wasClean":false}

## message-buffer-lifetime

- binary message arrives as
  - Buffer
- first buffer mutated after 8 subsequent messages (non-mutation is NOT proof of safety)
  - false

## upgrade-flow

- await before server.upgrade() still upgrades
  - true
- custom upgrade header present on the 101 response
  - true
- raw 101 status line + headers
  - HTTP/1.1 101 Switching Protocols | x-probe-upgrade: yes | Upgrade: websocket | Connection: Upgrade | Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo= | Date: Sat, 01 Aug 2026 02:48:56 GMT

## subprotocol

- sec-websocket-protocol header as seen in fetch()
  - alpha, beta
- client.protocol after server selected "alpha" via upgrade headers
  - "alpha"

## routes-option

- static routes entry served /ping
  - "pong"
- fetch() fallback still serves unrouted paths
  - "fallback"

## stop-drain

- in-flight request outcome across graceful stop()
  - "slow-done"
- echo round-trip over the open WebSocket AFTER graceful stop()
  - "rt-probe"
- open WebSocket close event across graceful stop() (waited up to 4s)
  - {"timeout":"timeout after 4000ms: client close event"}
- open WebSocket outcome across stop(true)
  - {"code":1006,"reason":"Connection ended","wasClean":false}

## serve-options

- Bun.serve accepts reusePort: true
  - accepted
- Bun.serve accepts websocket.perMessageDeflate: true
  - accepted
- Bun.serve accepts websocket.perMessageDeflate: { compress: true, decompress: true }
  - accepted
- Bun.serve accepts websocket.sendPings: false
  - accepted
- Bun.serve accepts websocket.publishToSelf: true
  - accepted
- Bun.serve accepts maxRequestBodySize: 1048576
  - accepted
- TLS surface (SNI, multiple certs, passphrase)
  - MANUAL - needs real certificates; probe before claiming TLS parity

## body-read-scheduling

- in-memory string body classified as
  - complete
- in-memory bytes body classified as
  - complete
- large (4 MiB) in-memory body classified as
  - complete
- multi-chunk already-enqueued body classified as
  - complete
- shell-then-await body classified as
  - streaming

