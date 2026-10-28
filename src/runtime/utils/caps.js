// Per-connection caps the subscription lanes and the tracked helpers enforce.
// Pure constants, so the helpers in ws-symbols.js can read them without
// loading the runtime's configuration.

/**
 * Per-connection subscription cap: svelte-adapter-uws's figure, so a
 * connection is refused at the same point on either adapter, and a copy of
 * that adapter's `trackedSubscribe` - which checks its own constant - grows a
 * connection here exactly as far as this runtime's lanes would.
 *
 * A real bound, not a formality. A landed subscription is not only a Set entry
 * and a string: it is an entry in Bun's native topic registry as well, measured
 * at about 530 bytes resident each on Bun 1.3.14 (one connection, 65,536
 * distinct topics, 33 MB), so a cap set high enough to never fire (the family's
 * historical 1,000,000) leaves single-connection memory exhaustion available to
 * any client, and `upgradeAdmission.maxConnections` cannot see it. Fixed
 * rather than configurable, as on svelte-adapter-uws; a capped client is
 * answered RATE_LIMITED and keeps everything it has.
 */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 65_536;

/**
 * Subscribe attempts one connection may hold IN FLIGHT - entered the authorization gate,
 * not yet landed.
 *
 * Independent from landed membership. Every topic in
 * flight is a live authorization-hook call (typically a session or database
 * lookup) plus a record entry, and the landed cap cannot see attempts that
 * never land. A batch frame carries up to `MAX_BATCH_TOPICS`; repeated topics
 * consume one slot per attempt, just like distinct topics. 4096 is
 * svelte-adapter-uws's figure: sixteen full batch frames in flight at once,
 * far above a healthy reconnect's resubscribe.
 */
export const MAX_PENDING_SUBSCRIBES_PER_CONNECTION = 4096;

export const MAX_PENDING_REQUESTS_PER_CONNECTION = 1_000_000;

export const MAX_COALESCED_KEYS_PER_CONNECTION = 1_000_000;

export const TOPIC_SEQS_WARN_THRESHOLD = 1_000_000;

export const PUBLISH_WARN_DEDUP_MAX = 1_000_000;

export const MAX_INGRESS_BINDINGS_PER_CONNECTION = 32;

export const MAX_INGRESS_TARGET_BYTES = 1024;
