// Generated from src/index.d.ts and src/testing.d.ts by scripts/generate-platform-contract.js.
import type { PlatformContract, PlatformMemberRequirement } from './platform-contract-validation.js';
export { definePlatformContract, assertPlatformContract, INVALID_PLATFORM_CONTRACT, PLATFORM_ACTIVATION_FAILED } from './platform-contract-validation.js';
export type { PlatformContract, PlatformMemberRequirement, PlatformValueKind, PlatformActivationError, PlatformActivationFailure } from './platform-contract-validation.js';

/**
 * All public Platform member names, including per-request and per-connection
 * context fields. This inventory describes the Bun contract, not the
 * capabilities implemented by another adapter or an arbitrary platform object.
 */
export declare const PLATFORM_MEMBERS: readonly [
	"adviseReconnect",
	"assertions",
	"authorizeDelivery",
	"authorizeWireSubscribe",
	"bufferedAmount",
	"bumpTopicEpoch",
	"checkSubscribe",
	"closedWsAborts",
	"connections",
	"forEachSubscriber",
	"grantPublish",
	"isWarmupRequest",
	"maxPayloadLength",
	"metrics",
	"metricsSnapshot",
	"monotonic",
	"now",
	"onPressure",
	"onPublishRate",
	"pressure",
	"protection",
	"publish",
	"publishBatched",
	"publishGame",
	"publishGrant",
	"publishWire",
	"publishWireBatch",
	"random",
	"registerWireCodec",
	"requestId",
	"revokePublish",
	"send",
	"sendCoalesced",
	"sendTo",
	"sendWire",
	"sendWireBatch",
	"subscribe",
	"subscribers",
	"topic",
	"topicEpoch",
	"unsubscribe"
];

/** A public Platform member name. */
export type PlatformMember = typeof PLATFORM_MEMBERS[number];

/** Complete production platform requirements, including connection context. */
export declare const PLATFORM_CONTRACT: PlatformContract & { readonly members: Readonly<Record<PlatformMember, PlatformMemberRequirement>> };

/** Capabilities supplied by the in-process test server. */
export declare const TEST_PLATFORM_CONTRACT: PlatformContract & { readonly members: Readonly<Record<Exclude<PlatformMember, "onPressure" | "onPublishRate">, PlatformMemberRequirement>> };
