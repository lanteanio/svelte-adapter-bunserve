import type { RuntimeVersionInfo } from './index.js';
import type { TraceContext, TraceOperationOptions, TraceSpan } from './observability.js';
import type { WebSocket } from './index.js';
import type {
	MetricsRegistry,
	MessageAdmissionOptions,
	EgressOptions,
	Platform,
	WaitingRoomRenderer,
	WebSocketHandler,
	UpgradeContext
} from './index.js';

export interface TestServerOptions<UserData = unknown> {
	/** Port to listen on. Defaults to 0 (random available port). */
	port?: number;
	/** Optional bind address. Omit to preserve the native wildcard listener. */
	host?: string;
	/** WebSocket endpoint path. @default '/ws' */
	wsPath?: string;
	/** WebSocket handler hooks (same shape as hooks.ws.ts exports). */
	handler?: TestWebSocketHandler<UserData>;
	/**
	 * Arm wire-subscribe authorization, mirroring
	 * `adapter({ websocket: { authorizeWireSubscribe: true } })`. A client may
	 * then only (re)subscribe to a topic the server already granted for that
	 * connection, unless the app ships its own subscribe hook.
	 *
	 * Declared here because an app verifying its own tenancy boundary against
	 * this server must be able to ARM the same posture production runs. Without
	 * it a TypeScript caller writes `createTestServer({})`, the grant conjunct
	 * never fires, and the double answers permissively where production denies -
	 * the exact shape of green false negative this harness exists to avoid.
	 * Use `'strict'` to require BOTH the server grant and an application-hook
	 * allow. Any other non-boolean value throws, matching adapter and Vite.
	 */
	authorizeWireSubscribe?: boolean | 'strict';
	/**
	 * Allow clients to subscribe to `__`-prefixed system topics, mirroring
	 * `adapter({ websocket: { allowSystemTopicSubscribe: true } })`.
	 */
	allowSystemTopicSubscribe?: boolean;
	/**
	 * Allow non-ASCII topic names, mirroring
	 * `adapter({ websocket: { allowNonAsciiTopics: true } })`.
	 */
	allowNonAsciiTopics?: boolean;
	/** Path of the auto-mounted admin route. @default '/__realtime' */
	adminPath?: string;
	/** Readiness probe path. @default '/readyz' */
	readinessCheckPath?: string;
	/** Liveness probe path. @default '/healthz' */
	healthCheckPath?: string;
	/** Spread client reconnect attempts over this window in milliseconds. */
	reconnectDispersalMs?: number;
	/**
	 * Three-layer admission control on the WebSocket upgrade path. Same
	 * wiring as the production handler's `wsOptions.upgradeAdmission`
	 * setting. The layers are opt-in and default to disabled (`0`);
	 * `maxDeferred` defaults to `1024` only while pacing is enabled.
	 *
	 * - `maxConcurrent` caps how many upgrades may be in flight at once.
	 *   Crossed requests get a fast `503 Service Unavailable` before
	 *   any per-request work (no header walk, no cookie parsing).
	 * - `maxConnections` caps reserved upgrades plus live sockets and
	 *   holds each permit through the close callback.
	 * - `perTickBudget` caps how many `res.upgrade()` calls run per
	 *   event-loop tick. Once spent, subsequent calls are deferred via
	 *   `setImmediate`; `maxDeferred` bounds those retained callbacks and
	 *   sheds overflow with `503 Service Unavailable`.
	 *
	 * Useful in integration tests that want to assert the admission
	 * shed-shape under a real connection storm without booting a full
	 * SvelteKit app. Production users configure the same options via
	 * `adapter({ websocket: { upgradeAdmission: { ... } } })`.
	 */
	upgradeAdmission?: {
		maxConcurrent?: number;
		maxConnections?: number;
		perTickBudget?: number;
		/** Finite pacing-queue ceiling; default `1024`, and `0` retains none. */
		maxDeferred?: number;
		waitingRoom?: false | {
			path?: string;
			admitCheckPath?: string;
			retryAfterSeconds?: number;
			pollIntervalMs?: number;
			appName?: string;
			statusUrl?: string;
			supportUrl?: string;
			incidentId?: string;
			/** Full HTML document satisfying the public `AccessibleWaitingDocument` baseline. */
			template?: string;
			/**
			 * In-process equivalent of the production renderer module. The
			 * production adapter accepts a module path; the test server accepts
			 * the renderer function itself so locale behavior can be exercised.
			 */
			renderer?: WaitingRoomRenderer;
		};
	};
	/** Established-message admission settings. */
	messageAdmission?: MessageAdmissionOptions;
	/** Publish-egress ceilings for the test server. Fan-out charges serialized bytes times local recipients and refuses over-budget delivery before publishing. The handler can supply egressTenantOf for tenant accounting. */
	egress?: EgressOptions;
	/** Protection posture for the test server. Siege refuses new upgrades; auto resolves from the admission gate. platform.__setProtection() changes the level while a test runs. */
	protection?: 'normal' | 'elevated' | 'siege' | 'auto';
	/** Prometheus-style registry for test-server upgrade, message-admission and egress instruments. The harness emits event-driven values and runs no production pressure sampler. */
	metrics?: MetricsRegistry;
	/** In-process initialization hook, called once before handler.init. Its return value becomes workerData in the init context; omission supplies null. No worker threads are started. */
	primaryInit?: (ctx: { env: NodeJS.ProcessEnv }) => any;
	/** Inbound WebSocket payload ceiling in bytes, enforced by Bun and reported by platform.maxPayloadLength. @default 1048576 */
	maxPayloadLength?: number;
	/** Idle timeout in seconds, passed to the native Bun listener. Zero disables the idle reaper. @default 120 */
	idleTimeout?: number;
	/** Maximum entries in the test-server topic sequence registry. Eviction skips live subscriptions and open resume buffers, and later publication retains the evicted sequence floor. Zero disables the bound. @default 1000000 */
	maxTopicSeqEntries?: number;
}

/**
 * Chaos / fault-injection scenario passed to `platform.__chaos`.
 *
 * Continuous scenarios (consulted on every outbound frame):
 * - `'drop-outbound'` discards outbound frames before they reach the wire
 *   with the configured `dropRate` (a probability in [0, 1]).
 * - `'slow-drain'` defers outbound frames by `delayMs` milliseconds via
 *   `setTimeout`. Order is preserved (every frame waits the same delay).
 * - `'ipc-reorder'` defers each outbound frame by an independently-random
 *   delay in `[0, maxJitterMs)`. Adjacent frames can arrive out of order,
 *   simulating cross-worker relay reordering or queue jitter. Use to
 *   verify protocol code (seq gap detection, idempotency keys, resume
 *   tokens) handles disordered delivery. `maxJitterMs` is capped at
 *   60_000 ms.
 *
 * One-shot trigger (does NOT change continuous chaos state):
 * - `'worker-flap'` closes every currently-live WebSocket connection
 *   with the configured `code` (default `1012`) and `reason` (default
 *   `'worker restart'`). The server stays alive and accepts new
 *   connections. Use to verify clients reconnect and resume correctly
 *   after a worker process restart in cluster mode. A numeric `code` and a
 *   string `reason` follow the `ws.end()` rule: a code that cannot be sent
 *   throws a TypeError before any connection is closed. A `code` that is not
 *   a number, or a `reason` that is not a string, falls back to the default.
 *
 * Pass `null` (or call with no argument) to clear the active continuous
 * scenario; the harness returns to its zero-overhead fast paths.
 *
 * **Scope.** This is a WebSocket-frame outbound chokepoint. It intercepts
 * what the test harness sends to its connected WS clients - every frame
 * routed through `sendOutboundT` (`platform.publish`, `platform.send`,
 * `platform.sendTo`, `platform.request`, the welcome envelope, subscribe
 * acks, the resumed ack). It does NOT cover transport-level traffic
 * outside the harness: an ioredis client, a pg connection, a NATS
 * subscription, or any backend you've wired up alongside the adapter
 * stays untouched. For cross-wire fault injection, wrap the transport
 * client at the integration layer using the same `createChaosState`
 * factory exported from `svelte-adapter-bunserve/testing` - see the README
 * "Wrap your own transport for cross-wire chaos" pattern.
 */
export type ChaosScenario =
	| { scenario: 'drop-outbound'; dropRate: number }
	| { scenario: 'slow-drain'; delayMs: number }
	| { scenario: 'ipc-reorder'; maxJitterMs: number }
	| { scenario: 'worker-flap'; code?: number; reason?: string };

/**
 * Worker platform exposed by `createTestServer`. Request IDs belong to hook
 * connection contexts. This server has no pressure sampler: use the built
 * runtime to test `onPressure` and `onPublishRate` subscriptions. Tests can use the
 * harness to simulate broken-network conditions while exercising protocol
 * code (subscribe acks, session resume, sendCoalesced under backpressure,
 * request/reply timeouts, etc).
 */
export interface TestPlatform extends Omit<TestConnectionPlatform, 'requestId'> {
	/**
	 * Validated W3C context for the currently active HTTP, WebSocket, RPC, bus,
	 * or durable-work operation. Concurrent operations on one connection remain
	 * isolated. Null when tracing is not configured or no valid context exists.
	 */
	readonly traceContext: TraceContext | null;
	/**
	 * Vendor-neutral trace boundary. run() creates a provider span and keeps its
	 * context active across async work; inject() writes traceparent/tracestate to
	 * an outbound carrier. With no configured provider these methods are no-op
	 * compatible and do not allocate spans.
	 */
	readonly trace: Readonly<{
		readonly enabled: boolean;
		current(): TraceContext | null;
		extract(carrier: Headers | Record<string, unknown>): TraceContext | null;
		inject<T extends Headers | Record<string, string>>(carrier: T, context?: TraceContext | null): T;
		run<T>(name: string, options: TraceOperationOptions, fn: (span: TraceSpan | null) => T): T;
		withContext<T>(context: TraceContext | null, fn: () => T): T;
	}>;
	/**
	 * Publish multiple messages, returning per-message delivery results.
	 *
	 * **NOT wire-level batching.** Under the hood this is a `for` loop
	 * calling `publish()` once per message, so N submitted messages still
	 * produce N WebSocket frames per subscribed connection. For
	 * one-frame-per-subscriber wire batching, use `publishBatched()`.
	 *
	 * Two distinct contracts:
	 * - `batch(messages)` -> N frames per subscriber, returns `boolean[]`.
	 * - `publishBatched(messages)` -> 1 frame per subscriber (events
	 *   array), returns `void`; opt-in by client capability.
	 *
	 * @example
	 * ```js
	 * export async function POST({ platform, request }) {
	 *   const { items } = await request.json();
	 *   platform.batch(items.map(item => ({ topic: 'orders', event: 'created', data: item })));
	 * }
	 * ```
	 */
	batch(messages: {
		topic: string;
		event: string;
		data?: unknown;
		options?: { relay?: boolean; seq?: boolean | number | bigint | null; compress?: boolean; jitterMs?: number };
	}[]): boolean[];
	/**
	 * <!-- API_DOC:platform.publishBatched:START -->
	 * ### `platform.publishBatched(messages, options?)`
	 *
	 * Publish a list of events as one `{type:'batch', events:[...]}` WebSocket
	 * frame per affected subscriber when the local subscriber shape permits it.
	 * The method returns `void`. Each message has `topic`, `event`, optional
	 * `data`, optional `coalesceKey`, and per-message `options.relay` / `options.seq`;
	 * call-level `options.compress` opts the resulting frames into compression.
	 *
	 * ```js
	 * platform.publishBatched([
	 *   { topic: 'org:42:items', event: 'updated', data: a },
	 *   { topic: 'org:42:items', event: 'updated', data: b },
	 *   { topic: 'org:42:audit', event: 'created', data: c, options: { seq: false } }
	 * ], { compress: false });
	 * ```
	 *
	 * Each subscriber receives only events for topics it holds, in surviving call
	 * order; a subscriber with no overlap receives nothing. The fast path is used
	 * when every interested local subscriber advertised the `batch` capability
	 * and every interested subscriber sees the same event slice (a single topic
	 * always has one slice). Otherwise that worker safely falls back to individual
	 * event envelopes. The bundled client advertises `batch` automatically and
	 * dispatches each contained event through the ordinary per-topic store path.
	 *
	 * **Cross-worker contract.** The relay mirrors the origin's own path
	 * selection. When the origin takes the fast path, it sends one
	 * `publish-batched` IPC frame carrying the complete relay-eligible event
	 * list, and every receiving worker reruns capability and subscriber-slice
	 * detection against its own sockets - so a peer may emit one local batch
	 * frame or fall back locally. When the origin itself falls back (a
	 * subscriber without the `batch` capability, or interested subscribers
	 * seeing different event slices), each surviving event relays
	 * individually and peers deliver individual event envelopes. An event
	 * with `{ relay: false }` is kept in origin-local delivery and omitted
	 * from the cross-worker list either way.
	 *
	 * **Coalescing, order, and sequence.** Events sharing a string `coalesceKey`
	 * collapse before framing; only the latest survives at its latest occurrence,
	 * while unkeyed events never collapse. Each survivor is independently stamped
	 * like `publish()`. `{ seq: false }` omits the stamp; a positive integer stamps
	 * that exact externally authoritative value. In a multi-worker runtime every
	 * survivor must use `seq:false` or an authoritative number with `relay:false`;
	 * the entire surviving batch is validated before any counter or delivery can
	 * occur. `sendCoalesced` remains a separate per-connection queue and produces
	 * separate frames.
	 *
	 * **Frame and compression budget.** A batch envelope larger than 256 KB emits
	 * a throttled warning; split it into multiple calls. Compression defaults to
	 * false. `{ compress: true }` applies consistently to the shared-frame fast
	 * path and every individual-frame fallback when WebSocket compression is
	 * configured.
	 *
	 * Do not confuse this with `platform.batch(messages)`: that method is a
	 * `publish()` loop, returns one boolean per message, and always produces
	 * individual event frames. Use `publishBatched()` for wire batching.
	 * <!-- API_DOC:platform.publishBatched:END -->
	 */
	publishBatched(messages: Array<{
		topic: string;
		event: string;
		data?: unknown;
		/**
		 * Optional coalesce key. When two events in the same call share
		 * a `coalesceKey`, only the latest one survives - the earlier
		 * value is dropped before the batch frame is built. Use this
		 * for high-frequency streams where intermediate values are
		 * noise (cursor positions, price ticks, presence, typing
		 * indicators). Events without a `coalesceKey` are never
		 * coalesced.
		 *
		 * @example
		 * ```js
		 * platform.publishBatched(positions.map(p => ({
		 *   topic: 'cursors',
		 *   event: 'move',
		 *   data: p,
		 *   coalesceKey: 'cursor:' + p.userId  // latest position per user
		 * })));
		 * ```
		 */
		coalesceKey?: string;
		/** Per-message `seq`: `false`/`null` omits it, a positive safe-integer `number` or `bigint` stamps that exact authoritative seq, omitted/`true` uses the in-memory counter, anything else throws - as does an integer past the safe-integer range, which the double seq space cannot carry unchanged. Multi-worker runtimes require `false` or an authoritative number with `relay:false`. */
		options?: { relay?: boolean; seq?: boolean | number | bigint | null };
	}>, options?: {
		/**
		 * Compress the batch frame when `websocket.compression` is configured.
		 * Default `false`: a batched frame mixes event types, so compression is
		 * opt-in. Applies to the whole batch (the shared-frame fast path and the
		 * per-event slow-path fallback alike).
		 */
		compress?: boolean;
	}): void;
	/**
	 * Send a request to a single connection and await its reply.
	 *
	 * The server picks a fresh `ref`, sends `{type:'request', ref, event, data}`,
	 * and the returned Promise resolves with whatever the client's
	 * `onRequest` handler returned (or rejects with an `Error` carrying
	 * the message the client sent back if its handler threw / rejected).
	 *
	 * Rejects with `Error('request timed out')` after `timeoutMs`
	 * (default `5000`) and with `Error('connection closed')` if the
	 * WebSocket closes before a reply arrives. The closed rejection
	 * appends which side of transmission the close landed on: a frame
	 * that was `never sent` or `could not be sent` leaves the remote
	 * outcome known and is safe to retry after reconnect, while one
	 * `handed to the transport and no reply had arrived` must be
	 * reconciled or retried only through an idempotent operation.
	 * Pending requests are tracked per-connection, so close cleanup
	 * is automatic.
	 *
	 * Pairs with the client store's `onRequest(handler)`. Use this for
	 * server-driven confirmations, capability challenges, or
	 * push-driven state queries.
	 *
	 * @example
	 * ```js
	 * // In a hook on the server:
	 * const reply = await platform.request(ws, 'confirm-action', { op: 'delete' }, {
	 *   timeoutMs: 5000
	 * });
	 * if (reply.confirmed) await actuallyDelete();
	 * ```
	 */
	request<TReply = unknown>(
		ws: WebSocket<any>,
		event: string,
		data?: unknown,
		options?: { timeoutMs?: number }
	): Promise<TReply>;
	/**
	 * Broadcast a request to EVERY connection subscribed to `topic` on this
	 * instance and collect their replies - the request/reply analog of
	 * `publish`. Each subscriber's client `onRequest` handler runs; partial
	 * success is the contract, so a subscriber that times out, errors, or
	 * whose socket closed lands in the result as `{ ok: false, error }` and
	 * never fails the whole call. Returns one entry per subscribed socket.
	 *
	 * `timeoutMs` (default 5000) bounds each request; since they run
	 * concurrently it is effectively the whole-fan-out budget. Walks THIS
	 * worker's subscriber set (cluster-wide broadcast is the extensions layer).
	 *
	 * @example
	 * ```js
	 * const results = await platform.requestTopic('room:42', 'ping', {});
	 * const live = results.filter((r) => r.ok).map((r) => r.reply);
	 * ```
	 */
	requestTopic<TReply = unknown>(
		topic: string,
		event: string,
		data?: unknown,
		options?: { timeoutMs?: number }
	): Promise<Array<{ ok: true; reply: TReply } | { ok: false; error: string }>>;
	/**
	 * A PII-free snapshot of this worker's transport-layer health: connection
	 * count, backpressure posture, protection level, payload cap, and the
	 * framework-invariant counters. Counts and enums only - never a topic
	 * name, never a user id, never a socket handle. Counts, enums, and package
	 * versions only. Pure read (a fresh plain object each call), so it is safe
	 * to expose behind an auth-gated admin route or feed to a dashboard.
	 *
	 * The scalar pressure signals are reported but `topPublishers` is omitted
	 * (topic names can embed ids); read `pressure` directly with your own
	 * authorization when you need per-topic detail.
	 *
	 * svelte-realtime's `introspect()` composes this under a `transport` key
	 * when present, so an app-level admin route surfaces the dispatch snapshot
	 * and this transport snapshot from one call.
	 *
	 * @example
	 * ```js
	 * export function GET({ platform }) {
	 *   return Response.json(platform.introspect());
	 * }
	 * ```
	 */
	introspect(): {
		connections: number;
		closedWsAborts: number;
		protection: 'normal' | 'elevated' | 'siege';
		maxPayloadLength: number;
		versions: RuntimeVersionInfo;
		pressure: {
			/** `null` until the first sample; see `PressureSnapshot.sampledAt`. */
			sampledAt: number | null;
			active: boolean;
			reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY';
			value: number;
			subscriberRatio: number;
			publishRate: number;
			memoryMB: number;
			maxBufferedBytes: number;
			backpressuredConnections: number;
			droppedFrames: number;
			droppedBytes: number;
			egress: {
				deliveries: number;
				bytes: number;
				refusedTopic: number;
				refusedTenant: number;
			};
		};
		assertions: Record<string, number>;
		diagnostics: {
			retained: number;
			recent: Array<{
				diagnosticId: string;
				kind: 'state-divergence';
				observedAt: number;
				complete: boolean;
				affectedStreamCount: number;
				evidenceTruncated: boolean;
			}>;
		};
	};
	/**
	 * Resolve a bounded state-divergence diagnostic by the opaque id emitted in
	 * the primary log. The returned stream identifiers are process-lifetime
	 * HMACs, never raw topic names. This is sensitive operational evidence:
	 * expose it only through an authenticated admin route.
	 */
	diagnostic(diagnosticId: string): {
		diagnosticId: string;
		kind: 'state-divergence';
		epoch: number;
		observedAt: number;
		complete: boolean;
		evidenceTruncated: boolean;
		explainedBySequenceSummary: boolean;
		expectedWorkers: number;
		reportingWorkers: number;
		workers: Array<{
			threadId: number;
			role: 'majority' | 'minority';
			totalStreams: number;
			sampledStreams: number;
			truncated: boolean;
		}>;
		affectedStreams: Array<{
			streamId: string;
			classification: 'tail-sequence-gap' | 'stream-presence-mismatch';
			gapLowerBound: number | null;
			workers: Array<{
				threadId: number;
				role: 'majority' | 'minority';
				sequence: number | null;
			}>;
		}>;
	} | null;
	/**
	 * Authorize a connection to publish to `topic` via the client-driven relay
	 * (`game`) lane - the trusted server-side dual of `platform.subscribe`. Bind
	 * this at join, after the connection is authorized for the room.
	 *
	 * A client `game` frame carries NO topic; the server derives it from this
	 * binding, so a client can only publish to a room it was granted. A
	 * connection holds at most one publish binding (one room per socket); a
	 * second call re-binds to the new topic. This is the general
	 * publish-authorization primitive - a real-time game session is its first
	 * consumer, but any app can grant a client the right to publish to a room.
	 *
	 * The client sends `{ type: 'game', event, data, id? }`; the server stamps a
	 * monotonic per-room `seq` and fans `{ topic, event, data, seq, id? }` out to
	 * the room's other subscribers (the sender is excluded - it predicts locally
	 * from its own input). An ungranted or malformed frame is answered to the
	 * sender with `{ type: 'game-denied', reason, id? }`.
	 *
	 * Closed-WS safe: returns `false` (and bumps `platform.closedWsAborts`) if the
	 * socket has already closed, otherwise binds and returns `true`.
	 * Throws when the runtime has more than one I/O worker: this lane's sequencer
	 * is deliberately single-home. A clustered deployment may keep one I/O
	 * worker and use the remaining workers as compute workers, or supply an
	 * external authoritative room sequencer instead.
	 */
	grantPublish(ws: WebSocket<unknown>, topic: string): boolean;
	/**
	 * Clear a connection's client-publish binding - the dual of `unsubscribe`,
	 * for session end. After this the connection's `game` frames are denied
	 * (`game-denied` `FORBIDDEN`) until re-granted. Idempotent: returns `true` if
	 * a binding was cleared, `false` if there was none (or the socket had closed).
	 */
	revokePublish(ws: WebSocket<unknown>): boolean;
	/**
	 * The topic a connection is currently bound to publish to via the `game`
	 * lane, or `null` when it holds no grant. Read-only introspection.
	 */
	publishGrant(ws: WebSocket<unknown>): string | null;
	/**
	 * Relay a `game`-lane message to a topic's local subscribers from
	 * server-side code, EXCLUDING `senderWs` and echoing its client `id`. The
	 * server stamps the per-room `seq`. This is the same primitive the wire-level
	 * `game` handler calls after resolving the topic from the sender's grant;
	 * call it directly to inject a server-authored frame into the relay sequence
	 * (e.g. a bot's input). Returns the stamped `seq` and the number of
	 * subscribers delivered to.
	 * Throws in a topology with more than one I/O worker for the same reason as
	 * `grantPublish`: local fan-out cannot satisfy the cluster-wide contract.
	 *
	 * Egress note: this is the one publish with a socket in hand, so its
	 * `websocket.egress` tenant is the SENDER's frozen `attribution` tenant
	 * id (never the `egressTenantOf` topic resolver). A ceiling refusal
	 * returns `{ seq: null, delivered: 0 }` with no sequence consumed.
	 */
	publishGame(
		senderWs: WebSocket<unknown> | null,
		topic: string,
		event: string,
		data?: unknown,
		id?: number | string
	): { seq: number | null; delivered: number };
	/**
	 * Activate or clear a chaos / fault-injection scenario. Pass `null`
	 * to reset; the harness returns to its zero-overhead fast paths.
	 *
	 * Scope is the WS-frame outbound chokepoint inside the test harness;
	 * see the `ChaosScenario` JSDoc for what is and is not covered.
	 *
	 * @example
	 * ```js
	 * server.platform.__chaos({ scenario: 'drop-outbound', dropRate: 0.5 });
	 * // ... assert client recovers from 50% packet loss ...
	 * server.platform.__chaos(null);
	 * ```
	 */
	__chaos(cfg: ChaosScenario | null): void;
}

/** Connection-scoped platform with a request ID and no pressure sampler. */
export type TestConnectionPlatform = Omit<Platform, 'onPressure' | 'onPublishRate'>;

type TestHookArgument<Argument, ContextPlatform> = Argument extends { platform: Platform }
	? Omit<Argument, 'platform'> & { platform: ContextPlatform }
	: Argument;
type TestHook<Hook, ContextPlatform> = Hook extends (...args: infer Arguments) => infer Result
	? (...args: { [Index in keyof Arguments]: TestHookArgument<Arguments[Index], ContextPlatform> }) => Result
	: Hook;

/** Handler hooks with the platform members this in-process server supplies. */
export type TestWebSocketHandler<UserData = unknown> = {
	[Key in keyof WebSocketHandler<UserData>]: TestHook<
		WebSocketHandler<UserData>[Key],
		Key extends 'init' | 'shutdown' ? TestPlatform : TestConnectionPlatform
	>;
};

export interface TestServer {
	/** HTTP URL of the test server (e.g. 'http://localhost:12345'). */
	url: string;
	/** WebSocket URL of the test server (e.g. 'ws://localhost:12345/ws'). */
	wsUrl: string;
	/** The port the server is listening on. */
	port: number;
	/** Platform API for publishing, sending, and querying connections. */
	platform: TestPlatform;
	/**
	 * Live set of currently connected WebSocket facades. Useful in
	 * tests that need to call `platform.request(ws, ...)` or otherwise
	 * target a specific connection.
	 */
	wsConnections: Set<import('./index.js').WebSocket<any>>;
	/**
	 * Stop the server and close all connections. Tracked client sockets are
	 * terminated and JOINED (their terminal event awaited, bounded) before
	 * the port is released, and the server-side close callbacks of the
	 * connection kicks are joined too - a resolved close() means the
	 * sockets are gone, not merely told to go.
	 */
	close(): Promise<void>;
	/**
	 * Register a client socket (any `ws`-shaped object with `once`,
	 * `terminate`/`close`, and `readyState`) that this server owns for
	 * teardown: `close()` terminates it and awaits its terminal event
	 * before releasing the port, so an in-flight dial can never race the
	 * next test's listen. Returns the socket for inline use:
	 * `const ws = server.track(new WebSocket(server.wsUrl))`.
	 */
	track<T>(sock: T): T;
	/** Wait for a WebSocket client to connect. */
	waitForConnection(timeout?: number): Promise<void>;
	/** Wait for the next WebSocket message (after subscribe/unsubscribe handling). */
	waitForMessage(timeout?: number): Promise<{ data: string; isBinary: boolean }>;
}

/**
 * Create a lightweight test server backed by a native Bun server.
 *
 * Starts on a random port and provides a Platform-compatible API for
 * publishing, sending, and asserting on WebSocket behavior. The server
 * uses the same subscribe/unsubscribe protocol as the production handler.
 * It is a separately implemented public test harness, not an import of the
 * production handler: it does not exercise the adapter build, worker/cluster
 * lifecycle, TLS, static serving, or every production admission branch. Use a
 * built-fixture integration test as well when the assertion is specifically
 * about production wiring or a runtime security boundary.
 *
 * @example
 * ```js
 * import { createTestServer } from 'svelte-adapter-bunserve/testing';
 * import { describe, it, expect, afterEach } from 'vitest';
 *
 * let server;
 * afterEach(() => server?.close());
 *
 * it('rejects unauthenticated upgrades', async () => {
 *   server = await createTestServer({
 *     handler: {
 *       upgrade({ cookies }) {
 *         return cookies.session ? { id: 'user-1' } : false;
 *       }
 *     }
 *   });
 *
 *   const res = await fetch(server.wsUrl, {
 *     headers: { upgrade: 'websocket', connection: 'upgrade' }
 *   });
 *   expect(res.status).toBe(401);
 * });
 *
 * it('broadcasts to subscribers', async () => {
 *   server = await createTestServer();
 *   const ws = new WebSocket(server.wsUrl);
 *   await server.waitForConnection();
 *
 *   ws.send(JSON.stringify({ type: 'subscribe', topic: 'chat' }));
 *   // small delay for subscribe to process
 *   await new Promise(r => setTimeout(r, 10));
 *
 *   server.platform.publish('chat', 'new-message', { text: 'hello' });
 *   const msg = await server.waitForMessage();
 *   expect(JSON.parse(msg.data)).toMatchObject({
 *     topic: 'chat', event: 'new-message', data: { text: 'hello' }
 *   });
 * });
 * ```
 */
export function createTestServer<UserData = unknown>(options?: TestServerOptions<UserData>): Promise<TestServer>;

// - Re-exported pure helpers -----------------------------------------------
// Curated for downstream test code asserting on wire shape, userData
// state, or chaos / fault-injection behavior. Production-internal helpers
// (mime lookup, byte parsing, sampler internals) deliberately stay
// unexported so the test surface can evolve without churning production.

/**
 * JSON-quote a topic or event name for use inside a wire envelope. Throws
 * on control characters, double-quotes, or backslashes - the same
 * validation the production handler enforces. Pure.
 */
export function esc(s: string): string;

/**
 * Append the JSON-encoded `data` (and optional `seq`) plus the closing
 * brace to a prebuilt envelope prefix. Pairs with the wire shape
 * `{topic, event, data, seq?}`. When `seq` is `null` / `undefined` the
 * field is omitted entirely so the envelope matches the legacy
 * `{topic,event,data}` shape verbatim. An optional `jitterMs` stamps a `j`
 * de-herd window the client uses to roll its own dispatch delay. Pure.
 */
export function completeEnvelope(prefix: string, data: unknown, seq?: number | null, jitterMs?: number | null): string;

/**
 * Wrap an array of pre-built per-event envelope strings into a single
 * `{"type":"batch","events":[...]}` wire frame. Each input is a complete
 * `{topic, event, data, seq?}` envelope as produced by `completeEnvelope`.
 * The output is the wire format `platform.publishBatched` emits. Pure.
 */
export function wrapBatchEnvelope(eventEnvelopes: string[]): string;

/**
 * True if the topic name is safe to interpolate into a wire envelope:
 * no control characters, no quotes, no backslashes, max 256 chars.
 * Pure helper used to validate subscribe / unsubscribe inputs.
 */
export function isValidWireTopic(topic: unknown): boolean;

/**
 * Build a `TopicHelper`-shaped scoped publisher bound to a single topic.
 * Used internally by `platform.topic(name)`; useful in tests that want to
 * exercise the `created` / `updated` / `deleted` / `set` / `increment` /
 * `decrement` shorthands without going through a real platform. Pure.
 */
export function createScopedTopic(
	publish: (topic: string, event: string, data?: unknown) => unknown,
	name: string
): {
	publish(event: string, data?: unknown): void;
	created(data?: unknown): void;
	updated(data?: unknown): void;
	deleted(data?: unknown): void;
	set(value: number): void;
	increment(amount?: number): void;
	decrement(amount?: number): void;
};

/**
 * Collapse events that share a `coalesceKey` so only the latest value
 * survives, preserving the latest occurrence's position. Events without a
 * `coalesceKey` pass through unchanged. Pure helper that drives the
 * coalesce-by-key behavior of `platform.publishBatched`.
 */
export function collapseByCoalesceKey<T extends { coalesceKey?: string }>(messages: T[]): T[];

/**
 * Sanitize a possibly-present `X-Request-ID` header value into a value
 * safe to expose as `platform.requestId`. Returns `null` for absent /
 * empty / over-128-char / control-char inputs; trims and validates
 * printable-ASCII otherwise. Pure.
 */
export function resolveRequestId(value: string | undefined | null): string | null;

/**
 * Chaos / fault-injection state machine consulted by the test harness.
 * The `createTestServer` instance owns one of these; callers normally
 * drive it via `server.platform.__chaos(cfg)`. Exposed directly here for
 * tests that want a unit-level helper with deterministic RNG injection.
 */
export function createChaosState(opts?: { random?: () => number }): {
	readonly scenario: 'drop-outbound' | 'slow-drain' | 'ipc-reorder' | null;
	readonly dropRate: number;
	readonly delayMs: number;
	readonly maxJitterMs: number;
	/**
	 * Activate a continuous scenario (`drop-outbound`, `slow-drain`,
	 * `ipc-reorder`) or pass `null` to clear. The `worker-flap`
	 * one-shot trigger is NOT routed through here; it is handled by
	 * `platform.__chaos` directly inside the test server.
	 */
	set(cfg: Exclude<ChaosScenario, { scenario: 'worker-flap' }> | null): void;
	reset(): void;
	shouldDropOutbound(): boolean;
	getDelayMs(): number;
};

// - Per-connection userData slot constants ---------------------------------
// Symbol-keyed slots the adapter stamps on `ws.getUserData()` for its own
// per-connection bookkeeping. Tests asserting on connection state read
// userData via these to avoid coupling to Symbol identity tricks.
//
// `WS_REQUEST_ID_KEY` names no slot any more: the request id crosses
// `res.upgrade()` on a key private to the runtime and lives on
// `userData[WS_PLATFORM].requestId` from `open` on, which is where test code
// reads it.

/** Set of topics a connection is subscribed to. Stamped before `open` fires. */
export const WS_SUBSCRIPTIONS: unique symbol;

/** `Map<key, {topic,event,data}>` of pending `sendCoalesced` messages. Lazy. */
export const WS_COALESCED: unique symbol;

/** Per-connection session UUID. Stamped in `open` and announced to the client. */
export const WS_SESSION_ID: unique symbol;

/** `Map<ref, {resolve,reject,timer}>` of in-flight `platform.request()` promises. Lazy. */
export const WS_PENDING_REQUESTS: unique symbol;

/** Per-connection traffic counters. Only allocated when a `close` hook is registered. */
export const WS_STATS: unique symbol;

/** Per-connection `TestConnectionPlatform` clone carrying the connection's `requestId`. */
export const WS_PLATFORM: unique symbol;

/** Set of capabilities the client advertised via `{type:'hello', caps:[...]}`. */
export const WS_CAPS: unique symbol;

/**
 * The connection's server-resolved attribution: a frozen
 * `{ tenantId?, principalId?, entitlement? }`, stamped once at open from the
 * handler module's `attribution(user)` export; absent when unattributed.
 * Read this value from the connection userData when testing attribution.
 */
export const WS_ATTRIBUTION: unique symbol;

/**
 * Legacy request-id key retained for family compatibility. New connections
 * store the request identity on a private runtime key. Read
 * userData[WS_PLATFORM].requestId instead.
 *
 * @deprecated Names no slot; kept so an import of it still resolves.
 */
export const WS_REQUEST_ID_KEY: '__adapter_uws_request_id__';
