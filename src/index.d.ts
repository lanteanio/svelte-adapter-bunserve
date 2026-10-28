import type { Adapter } from '@sveltejs/kit';
import type { upgradeResponse } from './upgrade-response.js';

/** The supported connection methods exposed to WebSocket hooks. */
export interface WebSocket<UserData> {
	getUserData(): UserData;
	send(message: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean, compress?: boolean): number;
	publish(topic: string, message: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean, compress?: boolean): boolean;
	subscribe(topic: string): boolean;
	unsubscribe(topic: string): boolean;
	isSubscribed(topic: string): boolean;
	getBufferedAmount(): number;
	end(code?: number, message?: string | ArrayBuffer | ArrayBufferView): void;
	close(): void;
}

/**
 * A native HTTP transport body budget, selected before request bytes are buffered.
 * Rules match the path the client requested, before any SvelteKit `reroute` hook.
 */
export interface BodyLimitRule {
	/** Decoded absolute pathname including SvelteKit's base. No query, fragment or dot segments. */
	path: string;
	/** Match this path and descendants at a segment boundary. Exact match by default. */
	prefix?: boolean;
	/**
	 * Uppercase HTTP methods, compared with the request method in upper case. Omit
	 * to match every method. A fallback handler can receive any method, so list every
	 * method that should share the budget. GET and HEAD bodies are never read, so no
	 * rule applies to them and neither may be listed.
	 */
	methods?: string[];
	/** Maximum received bytes, including multipart framing. A nonnegative safe integer. */
	bytes: number;
}

/** A path-specific cache policy for static build output. */
export interface StaticCacheControlRule {
	/**
	 * Asset path relative to SvelteKit's configured base. A trailing slash
	 * matches that directory tree; otherwise the path matches one exact file.
	 * @example '/fonts/'
	 * @example '/logo.v2.svg'
	 */
	pattern: string;

	/** A complete Cache-Control field value. */
	cacheControl: string;
}

export interface AdapterOptions {
	out?: string;
	precompress?: boolean;
	envPrefix?: string;
	healthCheckPath?: string | false;
	readinessCheckPath?: string | false;
	warmup?: boolean | {
		paths: string[];
	};
	staticHeaders?: Record<string, string>;
	/** Path rules relative to the configured base; longest match wins. Built-in immutable policy takes precedence. */
	staticCacheControl?: StaticCacheControlRule[];
	staticDotfiles?: boolean;

	/**
	 * Narrow the native request body ceiling per route before application parsing.
	 * Every matching rule applies; the smallest budget and BODY_SIZE_LIMIT win.
	 * Paths include SvelteKit's base, ignore queries and trailing slashes, and
	 * match prefix rules at segment boundaries. GET and HEAD bodies are not read.
	 * Authentication also retains its 64 KiB maximum. A zero rule permits no bytes.
	 * Vite dev applies these rules to its auth and admin endpoints; preview owns
	 * its transport. Omit to retain the process-wide ceiling.
	 */
	bodyLimits?: BodyLimitRule[];
	websocket?: boolean | WebSocketOptions;
}
export interface EgressCeilings {
	messages?: number;
	bytes?: number;
	deliveries?: number;
}
export interface MessageAdmissionOptions {
	/** Maximum application-work frames accepted per connection in `rateWindowMs`. `0` disables. */
	perConnectionRate?: number;
	/** Maximum application-work frames accepted across this worker in `rateWindowMs`. `0` disables. */
	globalRate?: number;
	/**
	 * Maximum application-work payload bytes accepted per connection in
	 * `rateWindowMs`, charged by each incoming frame's byte length. `0`
	 * disables. Refusals use the same `rate_limit` reason and scopes as the
	 * per-frame rates. A single frame larger than the whole window's byte
	 * allowance can never afford its own cost and is refused every time, so
	 * size the allowance against `maxPayloadLength` deliberately.
	 */
	perConnectionBytesRate?: number;
	/**
	 * Maximum application-work payload bytes accepted across this worker in
	 * `rateWindowMs`, charged by each incoming frame's byte length. `0`
	 * disables. Same refusal semantics as `perConnectionBytesRate`.
	 */
	globalBytesRate?: number;
	/** Token-bucket refill window in milliseconds. @default 1000 */
	rateWindowMs?: number;
	/** Maximum concurrently-running application frames per connection. `0` disables. */
	perConnectionConcurrent?: number;
	/** Maximum concurrently-running application frames across this worker. `0` disables. */
	globalConcurrent?: number;
	/**
	 * Maximum messages waiting for a concurrency permit across this worker.
	 * `0` sheds immediately. Queued payloads are retained within the
	 * `maxQueue * maxPayloadLength` ingress memory budget.
	 * @default 0
	 */
	maxQueue?: number;
}

export interface EgressOptions {
	windowMs?: number;
	maxKeys?: number;
	evictionSample?: number;
	topic?: EgressCeilings;
	tenant?: EgressCeilings;
}
export interface WebSocketOptions {
	handler?: string;
	path?: string;
	authPath?: string;
	/**
	 * Prefix for the reserved admin / observability route. When your WebSocket
	 * handler exports an `admin(request)` function (svelte-realtime's auth-gated
	 * introspection handler is the canonical one), the adapter auto-mounts it at
	 * `<adminPath>/*`, registered before the SSR catch-all so it never hits page
	 * routing. The handler is mount-prefix agnostic, so relocating it is a
	 * one-place change here.
	 *
	 * Set `false` to disable the auto-mount entirely - for apps that mount the
	 * `admin` handler themselves (e.g. a SvelteKit `+server.js` route with their
	 * own middleware) and do not want a second, adapter-owned mount point. No
	 * effect unless the handler exports `admin`.
	 *
	 * Must be an absolute path (starting with `/`) that differs from `path` and
	 * `authPath`.
	 * @default '/__realtime'
	 */
	adminPath?: string | false;

	/**
	 * Silence the boot warning that the auto-mounted admin route carries no
	 * adapter-level authentication.
	 *
	 * The adapter mounts `admin` without gating it - whether requests are
	 * authenticated is entirely up to the handler, and the adapter cannot
	 * inspect that - so it warns once at startup. Set this to `true` after
	 * confirming the handler validates a session cookie, bearer token or
	 * equivalent, so the line stops appearing in logs an operator has already
	 * acted on. It changes nothing about routing or authorization.
	 *
	 * @default false
	 */
	adminAuthAcknowledged?: boolean;

	maxPayloadLength?: number;
	idleTimeout?: number;
	maxBackpressure?: number;
	closeOnBackpressureLimit?: boolean;
	compression?: boolean | number;
	sendPingsAutomatically?: boolean;
	upgradeTimeout?: number;
	allowedOrigins?: 'same-origin' | '*' | string[];
	upgradeRateLimit?: number;
	upgradeRateLimitWindow?: number;
	authPathRateLimit?: number;
	authPathRateLimitWindow?: number;
	egress?: EgressOptions;
	upgradeAdmission?: {
		maxConcurrent?: number;
		maxConnections?: number;
		perTickBudget?: number;
		maxDeferred?: number;
		cursorLane?: {
			fraction?: number;
		};
		waitingRoom?: false | {
			path?: string;
			admitCheckPath?: string;
			retryAfterSeconds?: number;
			pollIntervalMs?: number;
			appName?: string;
			statusUrl?: string;
			supportUrl?: string;
			incidentId?: string;
			renderer?: string;
			template?: string;
		};
	};
	/** Module exporting the metrics registry as default, metrics, or registry. */
	metrics?: string;
	pressure?: {
		memoryHeapUsedRatio?: number | false;
		publishRatePerSec?: number | false;
		subscriberRatio?: number | false;
		sampleIntervalMs?: number;
		topicPublishRatePerSec?: number | false;
		topicPublishBytesPerSec?: number | false;
		psiCpuSome?: number | false;
		psiMemoryFull?: number | false;
		psiIoFull?: number | false;
		cpuThrottledRatio?: number | false;
	};
	allowSystemTopicSubscribe?: boolean;
	authorizeWireSubscribe?: boolean | 'strict';
	allowNonAsciiTopics?: boolean;
	authPathRequireOrigin?: boolean;
	compressCredentialedResponses?: boolean;
}
export interface CookieSerializeOptions {
	path: string;
	domain?: string;
	expires?: Date;
	maxAge?: number;
	httpOnly?: boolean;
	secure?: boolean;
	partitioned?: boolean;
	sameSite?: 'strict' | 'lax' | 'none' | boolean;
	encode?: boolean;
}
export interface AuthenticateCookies {
	get(name: string): string | undefined;
	getAll(): Record<string, string>;
	set(name: string, value: string, options: CookieSerializeOptions): void;
	delete(name: string, options: CookieSerializeOptions): void;
}
export interface WaitingRoomContext {
	queueDepth: number;
	estimatedSeconds: number;
	pollIntervalMs: number;
	retryAfterSeconds: number;
	admitCheckPath: string;
	appName: string;
	statusUrl: string;
	supportUrl: string;
	incidentId: string;
}
export interface WaitingRoomRequestContext {
	readonly method: string;
	readonly url: string;
	readonly headers: {
		get(name: string): string | null;
	};
}
export interface WaitingRoomRendererContext extends WaitingRoomContext {
	readonly request: WaitingRoomRequestContext;
}
export interface AccessibleWaitingDocument {
	body: string;
	lang: string;
	dir: 'ltr' | 'rtl' | 'auto';
	headers?: Record<string, string>;
}
export interface WaitingRoomRendererResult extends AccessibleWaitingDocument {
}
export type WaitingRoomRenderer = (context: WaitingRoomRendererContext) => AccessibleWaitingDocument;
export interface MetricsRegistry {
	counter(
		name: string,
		help: string,
		labelNames?: string[]
	): {
		/**
		 * Increment the counter. `value` defaults to 1; a registry that ignores it
		 * will under-count any metric the runtime increments in bulk (the relay-gap
		 * counter reports FRAMES lost, not incidents), so implement it.
		 */
		inc(labels?: Record<string, string>, value?: number): void;
	};
	gauge(
		name: string,
		help: string
	): {
		set(value: number): void;
		/**
		 * Remove this gauge's sample when its source becomes unavailable.
		 * Optional. Without it, a cgroup-only heap_used_ratio is omitted from
		 * this registry; a permanent engine ceiling remains supported.
		 */
		remove?(): void;
	};
	/**
	 * Observe a distribution. Optional: a registry without this method omits duration histograms.
	 *
	 * It is declared because a registry that omits it cannot be TOLD what
	 * buckets to use, and a duration histogram is worthless with the wrong
	 * ones. Bucket bounds are the caller's to choose and are always in the
	 * metric's own unit.
	 *
	 * Unit convention: durations are `seconds`, named with a `_seconds`
	 * suffix, with bucket bounds written as fractions of a second
	 * (`0.001`, `0.005`, `0.01`, ...). Milliseconds are not used in a metric
	 * name or value even where the source clock reports them, so a bound
	 * always reads in the same unit as the sample. Sizes are `bytes` with a
	 * `_bytes` suffix. A histogram of sub-second work whose buckets start at
	 * `1` records every sample in the first bucket and measures nothing.
	 */
	histogram?(
		name: string,
		help: string,
		options?: { labelNames?: string[]; buckets?: number[] }
	): { observe(labels?: Record<string, string>, value?: number): void };
	/**
	 * Render all metrics in Prometheus text exposition format. Present on the
	 * `createMetrics()` registry from `svelte-adapter-uws-extensions/prometheus`;
	 * optional here because the adapter itself only ever calls `counter`/`gauge`.
	 * Read it from a scrape route via `platform.metrics`.
	 *
	 * NOT required for `platform.metricsSnapshot()`, which is built from the
	 * values the adapter wrote rather than from rendered text.
	 */
	serialize?(): string;
}

/**
 * Context passed to the `upgrade` handler.
 */
export interface UpgradeContext {
	headers: Record<string, string>;
	cookies: Record<string, string>;
	url: string;
	remoteAddress: string;
	requestId: string;
	traceContext: {
		readonly traceparent: string;
		readonly tracestate?: string;
	} | null;
}
export interface AuthenticateContext {
	request: Request;
	headers: Record<string, string>;
	cookies: AuthenticateCookies;
	url: string;
	remoteAddress: string;
	getClientAddress: () => string;
	platform: Platform;
}
export interface OpenContext {
	platform: Platform;
}
export interface MessageContext {
	data: ArrayBuffer;
	isBinary: boolean;
	msg?: any;
	platform: Platform;
}
export interface CloseContext {
	code: number;
	message: ArrayBuffer;
	platform: Platform;
	subscriptions: Set<string>;
	id?: string;
	duration?: number;
	messagesIn?: number;
	messagesOut?: number;
	bytesIn?: number;
	bytesOut?: number;
}
export interface SubscribeContext {
	platform: Platform;
}
export type SubscribeDenialReason = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_TOPIC' | 'RATE_LIMITED';
export interface ResumeContext {
	sessionId: string;
	lastSeenSeqs: Record<string, number>;
	lastSeenEpochs?: Record<string, number>;
	platform: Platform;
}
export interface Attribution {
	readonly tenantId?: string;
	readonly principalId?: string;
	readonly entitlement?: string;
}
export interface WebSocketHandler<UserData = unknown> {
	authenticate?: (ctx: AuthenticateContext) => Response | false | void | Promise<Response | false | void>;
	init?: (ctx: {
		platform: Platform;
		workerData: any;
	}) => void | Promise<void>;
	shutdown?: (ctx: {
		platform: Platform;
		reason?: string | null;
		signal?: AbortSignal | null;
		deadline?: number | null;
	}) => void | Promise<void>;
	upgrade?: (ctx: UpgradeContext) => UserData | false | ReturnType<typeof upgradeResponse<UserData>> | Promise<UserData | false | ReturnType<typeof upgradeResponse<UserData>>>;
	attribution?: (user: UserData) => Attribution | null | undefined;
	egressTenantOf?: (topic: string) => string | null | undefined;
	open?: (ws: WebSocket<UserData>, ctx: OpenContext) => void;
	message?: (ws: WebSocket<UserData>, ctx: MessageContext) => void;
	subscribe?: (ws: WebSocket<UserData>, topic: string, ctx: SubscribeContext) => boolean | void | SubscribeDenialReason | string | Promise<boolean | void | SubscribeDenialReason | string>;
	subscribeBatch?: (ws: WebSocket<UserData>, topics: string[], ctx: SubscribeContext) => Record<string, boolean | SubscribeDenialReason | string> | void | Promise<Record<string, boolean | SubscribeDenialReason | string> | void>;
	unsubscribe?: (ws: WebSocket<UserData>, topic: string, ctx: SubscribeContext) => void | Promise<void>;
	drain?: (ws: WebSocket<UserData>, ctx: OpenContext) => void;
	resume?: (ws: WebSocket<UserData>, ctx: ResumeContext) => void | Record<string, number> | number | Promise<void | Record<string, number> | number>;
	close?: (ws: WebSocket<UserData>, ctx: CloseContext) => void;
}
export interface PressureSnapshot {
	readonly sampledAt: number | null;
	readonly active: boolean;
	readonly value: number;
	readonly subscriberRatio: number;
	readonly publishRate: number;
	readonly memoryMB: number;
	readonly reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY';
	readonly psi: {
		cpuSome10: number;
		memoryFull10: number;
		ioFull10: number;
	} | null;
	readonly cpuThrottle: {
		throttledRatio: number;
		nrThrottledDelta: number;
	} | null;
	readonly maxBufferedBytes: number;
	readonly backpressuredConnections: number;
	readonly droppedFrames: number;
	readonly droppedBytes: number;
	readonly egress: {
		deliveries: number;
		bytes: number;
		refusedTopic: number;
		refusedTenant: number;
	};
	readonly topPublishers: TopicPublishRate[];
}
export interface TopicPublishRate {
	topic: string;
	messagesPerSec: number;
	bytesPerSec: number;
	deliveriesPerSec: number;
}
export interface Platform {
	readonly requestId: string;
	publish(topic: string, event: string, data?: unknown, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		jitterMs?: number;
	}): boolean;
	publishWire(topic: string, event: string, data: unknown, wire: {
		capability: string;
		schemaVersion: number;
		encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
		shared?: boolean;
		state?: {
			onAttach: (ws: WebSocket<any>) => unknown;
			onDetach?: (ws: WebSocket<any>, state: unknown) => void;
		};
	}, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		excludeWs?: WebSocket<any>;
	}): boolean;
	sendWire(ws: WebSocket<any>, topic: string, event: string, data: unknown, wire: {
		capability: string;
		schemaVersion: number;
		encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
		state?: {
			onAttach: (ws: WebSocket<any>) => unknown;
			onDetach?: (ws: WebSocket<any>, state: unknown) => void;
		};
	}, options?: {
		compress?: boolean;
		seq?: number | bigint | false | null;
	}): number;
	publishWireBatch(topic: string, event: string, entries: Array<{
		data: unknown;
		excludeWs?: WebSocket<any>;
		seq?: boolean | number | bigint | null;
	}>, wire: {
		capability: string;
		schemaVersion: number;
		encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
		state?: {
			onAttach: (ws: WebSocket<any>) => unknown;
			onDetach?: (ws: WebSocket<any>, state: unknown) => void;
		};
	}, options?: {
		seq?: boolean | null;
		relay?: boolean;
		compress?: boolean;
		excludeWs?: WebSocket<any>;
	}): boolean;
	sendWireBatch(ws: WebSocket<any>, topic: string, event: string, entries: Array<{
		data: unknown;
	}>, wire: {
		capability: string;
		schemaVersion: number;
		encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
		state?: {
			onAttach: (ws: WebSocket<any>) => unknown;
			onDetach?: (ws: WebSocket<any>, state: unknown) => void;
		};
	}, options?: {
		compress?: boolean;
	}): number;
	registerWireCodec(wire: {
		capability: string;
		schemaVersion: number;
		encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
		shared?: boolean;
		state?: {
			onAttach: (ws: WebSocket<any>) => unknown;
			onDetach?: (ws: WebSocket<any>, state: unknown) => void;
		};
	}): void;

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
	send(ws: WebSocket<any>, topic: string, event: string, data?: unknown, options?: {
		compress?: boolean;
		seq?: number | bigint | false | null;
	}): number;
	/**
	 * Keep the latest pending value per connection and key, in first-insertion order.
	 * Names are validated before replacing or evicting any pending entry.
	 * Immediate serialization failures preserve native Error identity; other
	 * failures become TypeErrors. Queued failures are dropped and reported.
	 * Reentrant sends to the same connection only enqueue: superseded values
	 * are skipped and repeated requeues yield to the event loop. Continuations
	 * stop after close.
	 */
	sendCoalesced(ws: WebSocket<any>, message: {
		key: string;
		topic: string;
		event: string;
		data?: unknown;
	}): void;
	/** Returns non-throwing sends, including frames the socket reports dropped. */
	sendTo(filter: (userData: any) => boolean, topic: string, event: string, data?: unknown, options?: {
		compress?: boolean;
	}): number;
	/** Returns completed advisory attempts, including drops; a throwing send or requested close is excluded. */
	adviseReconnect(options?: {
		windowMs?: number;
		afterMs?: number;
		close?: boolean;
		filter?: (userData: any) => boolean;
		compress?: boolean;
	}): number;
	readonly connections: number;
	readonly closedWsAborts: number;
	readonly assertions: ReadonlyMap<string, number>;
	subscribers(topic: string): number;
	isWarmupRequest(request: Request): boolean;
	forEachSubscriber(topic: string, fn: (ws: WebSocket<unknown>, userData: any) => void): void;
	readonly maxPayloadLength: number;
	bufferedAmount(ws: WebSocket<unknown>): number;
	subscribe(ws: WebSocket<unknown>, topic: string): Promise<string | null>;
	checkSubscribe(ws: WebSocket<unknown>, topic: string, options?: {
		requireGrant?: boolean;
	}): Promise<string | null>;
	authorizeWireSubscribe(): 'legacy' | 'strict';
	authorizeWireSubscribe(mode: 'legacy' | 'strict'): 'legacy' | 'strict';


	unsubscribe(ws: WebSocket<unknown>, topic: string): boolean;

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

	readonly pressure: PressureSnapshot;
	readonly protection: 'normal' | 'elevated' | 'siege';
	readonly metrics: MetricsRegistry | null;
	metricsSnapshot(options?: {
		timeoutMs?: number;
	}): Promise<string | null>;
	onPressure(cb: (snapshot: PressureSnapshot) => void): () => void;
	onPublishRate(cb: (events: TopicPublishRate[]) => void): () => void;
	topic(topic: string): TopicHelper;
	topicEpoch(topic: string): number;
	bumpTopicEpoch(topic: string): number;
	now(): number;
	monotonic(): number;
	random: {
		float(): number;
		u32(): number;
		uuid(): string;
		bytes(n: number): Uint8Array;
	};
}
export interface TopicHelper {
	publish(event: string, data?: unknown, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		jitterMs?: number;
	}): void;
	created(data?: unknown, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		jitterMs?: number;
	}): void;
	updated(data?: unknown, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		jitterMs?: number;
	}): void;
	deleted(data?: unknown, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		jitterMs?: number;
	}): void;
	set(value: number, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		jitterMs?: number;
	}): void;
	increment(amount?: number, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		jitterMs?: number;
	}): void;
	decrement(amount?: number, options?: {
		relay?: boolean;
		seq?: boolean | number | bigint | null;
		compress?: boolean;
		jitterMs?: number;
	}): void;
}
export default function adapter(options?: AdapterOptions): Adapter;

export interface RuntimeVersionInfo {
	/** Adapter version read from the package metadata that produced this runtime. */
	adapter: string | null;
	/** Frozen wire revision parsed from protocol.schema.json. */
	protocolRevision: number | null;
	/**
	 * Actually resolved svelte-realtime version. `null` when the resolver
	 * reports the package absent; the literal `'unresolvable'` when something
	 * is present that cannot be read (a broken exports map, an invalid
	 * package config) - a configuration to fix, not an absence.
	 */
	realtime: string | null;
	/**
	 * Actually resolved extensions version. `null` when the resolver reports
	 * the package absent; the literal `'unresolvable'` when something is
	 * present that cannot be read - a configuration to fix, not an absence.
	 */
	extensions: string | null;
}
