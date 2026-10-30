// Generated from src/index.d.ts and src/testing.d.ts by scripts/generate-platform-contract.js.
import { definePlatformContract } from './platform-contract-validation.js';
import { CANONICAL_PLATFORM_CONTRACTS } from './runtime/platform-contract-data.js';
export { definePlatformContract, assertPlatformContract, INVALID_PLATFORM_CONTRACT, PLATFORM_ACTIVATION_FAILED } from './platform-contract-validation.js';

/**
 * All public Platform member names, including per-request and per-connection
 * context fields. This inventory describes the Bun contract, not the
 * capabilities implemented by another adapter or an arbitrary platform object.
 */
export const PLATFORM_MEMBERS = Object.freeze([
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
]);

/** Complete production platform requirements, including connection context. */
export const PLATFORM_CONTRACT = definePlatformContract(CANONICAL_PLATFORM_CONTRACTS['svelte-adapter-bunserve']);

/** Capabilities supplied by the in-process test server. */
export const TEST_PLATFORM_CONTRACT = definePlatformContract(CANONICAL_PLATFORM_CONTRACTS['svelte-adapter-bunserve/testing']);
