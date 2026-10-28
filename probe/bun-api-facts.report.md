# Bun server API facts

Generated 2026-10-28T22:45:08.550Z by `probe/bun-api-facts.mjs`.

- Bun version: **1.4.4** (revision 38afee6c84fcf48c0edb2466aa4b27d287a59c30)
- Platform: linux/x64

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
  - 1048576 @ 0, -1 @ 2, 0 @ 19
- getBufferedAmount() right after the burst
  - returned 17202686
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
  - 1048576 @ 0, -1 @ 2, 0 @ 3
- getBufferedAmount() on the subscriber right after the burst
  - returned 472734
- server.publish("room", "small") once the socket is saturated
  - returned 0

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
  - {"code":4001,"reason":"probe-close","wasClean":true}
- ws.terminate exists
  - function
- client close event after server ws.terminate()
  - {"code":1006,"reason":"","wasClean":false}
- ws.close(1001, "draining") on the server
  - returned undefined
- client close event after ws.close(1001)
  - {"code":1001,"reason":"draining","wasClean":true}
- ws.close(1012, "draining") on the server
  - returned undefined
- client close event after ws.close(1012)
  - {"code":1012,"reason":"draining","wasClean":true}
- ws.close with code below the range on the server
  - returned undefined
- client close event after the code below the range
  - {"code":1006,"reasonBytes":0,"wasClean":false}
- ws.close with code reserved for no-status on the server
  - returned undefined
- client close event after the code reserved for no-status
  - {"code":1005,"reasonBytes":0,"wasClean":true}
- ws.close with code above the range on the server
  - returned undefined
- client close event after the code above the range
  - {"code":1006,"reasonBytes":0,"wasClean":false}
- ws.close with reason one byte over the cap on the server
  - returned undefined
- client close event after the reason one byte over the cap
  - {"code":4000,"reasonBytes":123,"wasClean":true}

## closed-socket-behavior

- readyState on the dead server socket
  - returned 3
- subscribe("t") on a closed socket
  - returned false
- unsubscribe("room") on a closed socket
  - returned false
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
  - "CUT: ECONNRESET: The socket connection was closed unexpectedly. F"
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

## close-under-backpressure

- client close event after ws.close(1013) on a healthy socket
  - {"code":1013,"reason":"probe-close","wasClean":true}
- client close event after ws.close(1013) on a socket past its backpressure limit
  - {"code":1013,"reason":"probe-close","wasClean":true}, send() returned [1048576,-1,0], 17202852 bytes buffered

## connection-close

- handler returns a Response synchronously
  - closed after 4ms
- handler is async but settles without yielding
  - closed after 1ms
- handler awaits a macrotask first
  - closed after 2ms
- handler awaits a macrotask, response body is bytes
  - closed after 2ms

## max-payload

- client close event after sending 4KiB with maxPayloadLength=1024
  - {"code":1009,"reason":"Received too big message","wasClean":true}

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
  - HTTP/1.1 101 Switching Protocols | x-probe-upgrade: yes | Upgrade: websocket | Connection: Upgrade | Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo= | Date: Wed, 28 Oct 2026 22:44:35 GMT

## upgrade-abort

- request.signal on an upgrade request is an AbortSignal
  - true
- and is not already aborted when fetch() is entered
  - true
- client hangs up 60ms into a 300ms hook: signal.aborted afterwards
  - true
- delay from the hang-up to the abort event, bucketed
  - under 50ms
- server.upgrade() on a request whose client already left
  - returned false, open handler fired: false

## upgrade-dispatch-order

- order of events around server.upgrade() when `open` closes its socket
  - before upgrade -> open enters -> abort -> close -> open exits -> upgrade returned true
- server.upgrade() return value when the socket closed inside `open`
  - true
- userData still readable in the close callback
  - true
- an `open` handler that throws: does it escape server.upgrade()
  - escaped: false, upgrade returned true, close handler fired: true

## header-values

- server.upgrade() with a header value containing printable ASCII
  - upgrades (returned true)
- server.upgrade() with a header value containing accented Latin-1 (an ordinary name)
  - upgrades (returned true)
- server.upgrade() with a header value containing above Latin-1 (an emoji)
  - throws
- server.upgrade() with a header value containing CR LF (the response-splitting set)
  - throws
- server.upgrade() with a header value containing NUL
  - throws

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
  - {"code":1001,"reason":"Server closed","wasClean":true}

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

## request-url-host

- Host: example.test:8080
  - HTTP/1.1 200 OK url="http://example.test:8080/p?q=1" pathname="/p" get(host)="example.test:8080"
- no Host line, HTTP/1.1
  - HTTP/1.1 400 Bad Request
- no Host line, HTTP/1.0
  - HTTP/1.1 200 OK url="/p" pathname="new URL threw TypeError" get(host)=null
- empty Host value
  - HTTP/1.1 200 OK url="/p" pathname="new URL threw TypeError" get(host)=""
- Host carrying a path and a ?: a/healthz?
  - HTTP/1.1 200 OK url="/p" pathname="new URL threw TypeError" get(host)="a/healthz?"
- Host carrying a #: a#b
  - HTTP/1.1 200 OK url="/p" pathname="new URL threw TypeError" get(host)="a#b"
- Host carrying userinfo: u@h
  - HTTP/1.1 200 OK url="/p" pathname="new URL threw TypeError" get(host)="u@h"
- Host with the default port: h:80
  - HTTP/1.1 200 OK url="http://h/p" pathname="/p" get(host)="h:80"
- Host with a port past 65535: h:99999
  - HTTP/1.1 200 OK url="http://h:99999/p" pathname="new URL threw TypeError" get(host)="h:99999"
- Host with an empty port: h:
  - HTTP/1.1 200 OK url="http://h/p" pathname="/p" get(host)="h:"
- Host with raw UTF-8 bytes (caf + 0xc3 0xa9)
  - HTTP/1.1 200 OK url="/p" pathname="new URL threw TypeError" get(host)="cafÃÂ©"
- Host with a backslash: a\b
  - HTTP/1.1 200 OK url="/p" pathname="new URL threw TypeError" get(host)="a\\b"
- Host with a space: a b
  - HTTP/1.1 200 OK url="/p" pathname="new URL threw TypeError" get(host)="a b"
- Host with two ports: a:80:80
  - HTTP/1.1 200 OK url="http://a:80:80/p" pathname="new URL threw TypeError" get(host)="a:80:80"
- Host with a malformed punycode label: xn--zz
  - HTTP/1.1 200 OK url="http://xn--zz/p" pathname="new URL threw TypeError" get(host)="xn--zz"
- Host with upper case and a trailing dot: EXAMPLE.com.
  - HTTP/1.1 200 OK url="http://example.com./p" pathname="/p" get(host)="EXAMPLE.com."
- Host as a bracketed IPv6 literal: [::1]:8080
  - HTTP/1.1 200 OK url="http://[::1]:8080/p" pathname="/p" get(host)="[::1]:8080"
- two Host lines
  - HTTP/1.1 200 OK url="http://one.test/p" pathname="/p" get(host)="one.test, two.test"
- absolute-form target with a different Host
  - HTTP/1.1 200 OK url="http://h.test/abs" pathname="/abs" get(host)="h.test"

## request-target

- plain /p
  - HTTP/1.1 200 OK url="http://h.test/p" pathname="/p" search=""
- raw 0xc3 0xa9 in the path
  - HTTP/1.1 200 OK url="http://h.test/caf%C3%A9" pathname="/caf%C3%A9" search=""
- raw 0xc3 0xa9 in the query
  - HTTP/1.1 200 OK url="http://h.test/p?x=%C3%A9" pathname="/p" search="?x=%C3%A9"
- raw 0x80 in the path
  - HTTP/1.1 200 OK url="http://h.test/a%EF%BF%BDb" pathname="/a%EF%BF%BDb" search=""
- tab in the path
  - HTTP/1.1 505 HTTP Version Not Supported
- 0x01 in the path
  - HTTP/1.1 505 HTTP Version Not Supported
- 0x7f in the path
  - HTTP/1.1 200 OK url="http://h.test/a%7Fb" pathname="/a%7Fb" search=""
- 0x01 in the query
  - HTTP/1.1 505 HTTP Version Not Supported
- NUL in the path
  - HTTP/1.1 505 HTTP Version Not Supported
- 0x1f in the path
  - HTTP/1.1 505 HTTP Version Not Supported
- CR in the path
  - HTTP/1.1 505 HTTP Version Not Supported
- raw 0xff in the path
  - HTTP/1.1 200 OK url="http://h.test/a%EF%BF%BDb" pathname="/a%EF%BF%BDb" search=""
- raw 0xe9 alone (Latin-1 e-acute) in the path
  - HTTP/1.1 200 OK url="http://h.test/caf%EF%BF%BD" pathname="/caf%EF%BF%BD" search=""
- raw 0xe9 alone in the query
  - HTTP/1.1 200 OK url="http://h.test/p?x=%EF%BF%BD" pathname="/p" search="?x=%EF%BF%BD"
- a space inside the target
  - HTTP/1.1 505 HTTP Version Not Supported
- # in the path
  - HTTP/1.1 200 OK url="http://h.test/a#b" pathname="/a" search=""
- # in the query
  - HTTP/1.1 200 OK url="http://h.test/p?x=1#y" pathname="/p" search="?x=1"
- an empty fragment: /p#
  - HTTP/1.1 200 OK url="http://h.test/p#" pathname="/p" search=""
- /x/../healthz
  - HTTP/1.1 200 OK url="http://h.test/healthz" pathname="/healthz" search=""
- /./healthz
  - HTTP/1.1 200 OK url="http://h.test/healthz" pathname="/healthz" search=""
- /x/%2E%2E/healthz
  - HTTP/1.1 200 OK url="http://h.test/healthz" pathname="/healthz" search=""
- /x/..%2Fhealthz
  - HTTP/1.1 200 OK url="http://h.test/x/..%2Fhealthz" pathname="/x/..%2Fhealthz" search=""
- backslashes: /x\..\healthz
  - HTTP/1.1 200 OK url="http://h.test/healthz" pathname="/healthz" search=""
- /%68ealthz
  - HTTP/1.1 200 OK url="http://h.test/%68ealthz" pathname="/%68ealthz" search=""
- //double
  - HTTP/1.1 200 OK url="http://h.test//double" pathname="//double" search=""
- /healthz/__data.json
  - HTTP/1.1 200 OK url="http://h.test/healthz/__data.json" pathname="/healthz/__data.json" search=""
- /ma%C3%9F.txt
  - HTTP/1.1 200 OK url="http://h.test/ma%C3%9F.txt" pathname="/ma%C3%9F.txt" search=""
- /My%20Report.pdf
  - HTTP/1.1 200 OK url="http://h.test/My%20Report.pdf" pathname="/My%20Report.pdf" search=""

## pathname-encoding

- visible ASCII characters changed in req.url
  - " -> /a%22b  < -> /a%3Cb  > -> /a%3Eb  \ -> /a/b  ^ -> /a%5Eb  ` -> /a%60b  { -> /a%7Bb  } -> /a%7Db
- visible ASCII characters changed in new URL(req.url).pathname
  - " -> /a%22b  < -> /a%3Cb  > -> /a%3Eb  \ -> /a/b  ^ -> /a%5Eb  ` -> /a%60b  { -> /a%7Bb  } -> /a%7Db

## repeated-headers

- Headers.get('Upgrade') for "first" then "second"
  - "first, second"
- Headers.get('Connection') for "first" then "second"
  - "first, second"
- Headers.get('Sec-WebSocket-Key') for "first" then "second"
  - "first, second"
- Headers.get('Sec-WebSocket-Version') for "first" then "second"
  - "first, second"
- Headers.get('X-Forwarded-Proto') for "first" then "second"
  - "first, second"
- Headers.get('X-Forwarded-Host') for "first" then "second"
  - "first, second"
- Headers.get('X-Forwarded-For') for "first" then "second"
  - "first, second"
- Headers.get('Forwarded') for "first" then "second"
  - "first, second"
- Headers.get('X-Custom') for "first" then "second"
  - "first, second"
- Headers.get('Cookie') for "first" then "second"
  - "first; second"
- Headers.get('Accept') for "first" then "second"
  - "first, second"
- Headers.get('Origin') for "first" then "second"
  - "first, second"
- Headers.get('Authorization') for "first" then "second"
  - "first, second"
- Headers.get('Proxy-Authorization') for "first" then "second"
  - "first, second"
- Headers.get('Content-Type') for "first" then "second"
  - "first, second"
- Headers.get for one line "Sec-WebSocket-Version: 13, 8"
  - "13, 8"
- Headers.get('Sec-WebSocket-Version') for "13" then an empty line
  - "13, "
- Headers.get('Sec-WebSocket-Version') for an empty line then "13"
  - ", 13"
- Headers.get('Sec-WebSocket-Version') for one empty line
  - ""
- char codes of Headers.get('Upgrade') for "websoc" + the UTF-8 bytes of U+212A + "et"
  - 77 65 62 73 6f 63 e2 84 aa 65 74
- a vertical tab inside a Connection value
  - HTTP/1.1 400 Bad Request

## handshake-cases

- a complete handshake
  - upgrade() true; wire: HTTP/1.1 101 Switching Protocols; accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
- no Upgrade
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- no Connection
  - upgrade() true; wire: HTTP/1.1 101 Switching Protocols; accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
- no key
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- an Upgrade naming another protocol
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- a Connection without upgrade
  - upgrade() true; wire: HTTP/1.1 101 Switching Protocols; accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
- a 24-character key that is not base64
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- a short key
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- a key with its unused bits set
  - upgrade() true; wire: HTTP/1.1 101 Switching Protocols; accept Zgw8jYXtqX5qJr7MJ1Q/MqzeSRI=
- Upgrade twice
  - upgrade() true; wire: HTTP/1.1 101 Switching Protocols; accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
- the key twice (the same value)
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- two different keys, the reference key first
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- the version twice
  - upgrade() false; wire: HTTP/1.1 426 Upgrade Required
- version 12
  - upgrade() false; wire: HTTP/1.1 426 Upgrade Required
- version 8
  - upgrade() false; wire: HTTP/1.1 426 Upgrade Required
- a version that is not a number
  - upgrade() false; wire: HTTP/1.1 426 Upgrade Required
- upgrade listed on a second Connection line
  - upgrade() true; wire: HTTP/1.1 101 Switching Protocols; accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
- no version
  - upgrade() false; wire: HTTP/1.1 426 Upgrade Required
- a websocket Upgrade with no key
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- a complete handshake sent as POST
  - upgrade() false; wire: HTTP/1.1 418 I'm a Teapot
- reference accepts for the two-key case
  - first (reference) key s3pPLMBiTxaQ9kYGzzhZRbK+xOo=; second key ICX+Yqv66kxgM0FcWaLWlFLwTAI=
- fetch() returns 426 with sec-websocket-version: 13 on a complete handshake
  - HTTP/1.1 426 Upgrade Required; sec-websocket-version "13"

## close-codes

- ws.close() with no arguments
  - returned undefined; on the wire {"code":1000,"reasonHex":"","payloadLength":2}; server close handler [1000]
- ws.close(1000, a lone surrogate)
  - returned undefined; on the wire {"code":1000,"reasonHex":"61efbfbd62","payloadLength":7}; server close handler [1000]
- ws.close(1000, a Uint8Array reason)
  - returned undefined; on the wire {"code":1000,"reasonHex":"3131312c313037","payloadLength":9}; server close handler [1000]
- ws.close(1000, a reason that is not UTF-8 bytes)
  - returned undefined; on the wire {"code":1000,"reasonHex":"3235352c323534","payloadLength":9}; server close handler [1000]
- ws.close(999)
  - returned undefined; on the wire {"code":999,"reasonHex":"","payloadLength":2}; server close handler [999]
- ws.close(1005)
  - returned undefined; on the wire {"code":null,"reasonHex":"","payloadLength":0}; server close handler [1005]
- ws.close(1000.5)
  - returned undefined; on the wire {"code":1000,"reasonHex":"","payloadLength":2}; server close handler [1000]
- ws.terminate()
  - returned undefined; on the wire {"error":"socket closed with no close frame"}; server close handler [1006]
- ws.close(1011, "Open handler error") inside open
  - on the wire {"code":1011,"reasonHex":"4f70656e2068616e646c6572206572726f72","payloadLength":20}; server order ["open","close 1011","after close()"]

## request-signal

- GET, client disconnects while the handler holds
  - aborted after 100ms: DOMException name=AbortError message="The connection was closed."
- POST with its whole body sent, client disconnects while the handler holds
  - aborted after 100ms: DOMException name=AbortError message="The connection was closed."
- POST mid-body (5 of 100 bytes), client disconnects
  - aborted after 100ms: DOMException name=AbortError message="The connection was closed."
- the mid-body read itself
  - body read rejected: DOMException "The connection was closed."
- response completed, then the client disconnects
  - not aborted within 1500ms
- streaming response, client disconnects mid-stream
  - aborted after 200ms: DOMException name=AbortError message="The connection was closed."
- streaming response that the server errors mid-stream
  - not aborted within 1500ms; last bytes on the wire "\r\n6\r\nchunk\n\r\n6\r\nchunk\n\r\n"
- server.stop(true) while the handler holds
  - aborted after 100ms: DOMException name=AbortError message="The connection was closed."
- new Request(req.url, req).signal when the client disconnects
  - aborted after 100ms: DOMException name=AbortError message="The connection was closed."

## pipelining

- GET /a and GET /b in one write
  - ["HTTP/1.1 200 OK","HTTP/1.1 200 OK"] /a first (quiet)
- GET /slow then GET /healthz in one write
  - [] not both answered total 1ms (closed)
- GET /slow, then GET /healthz written 50ms later on the same connection
  - [] not both answered total 51ms (closed)
- a 400 that leaves a 10-byte body unread, then GET /after
  - ["HTTP/1.1 400 Bad Request","HTTP/1.1 200 OK"] after-answered=true (quiet)

## upgrade-data

- server.upgrade(req, { data }) then ws.data in open
  - same object true; symbol key "symbol value"; plain 1

