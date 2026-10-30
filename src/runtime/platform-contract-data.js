// Generated from src/index.d.ts and src/testing.d.ts by scripts/generate-platform-contract.js.
const production = {
	schemaVersion: 1,
	adapter: "svelte-adapter-bunserve",
	members: {
		"adviseReconnect": {"kind":"function","context":"worker"},
		"assertions": {"kind":"object","context":"worker"},
		"authorizeDelivery": {"kind":"function","context":"worker"},
		"authorizeWireSubscribe": {"kind":"function","context":"worker"},
		"bufferedAmount": {"kind":"function","context":"worker"},
		"bumpTopicEpoch": {"kind":"function","context":"worker"},
		"checkSubscribe": {"kind":"function","context":"worker"},
		"closedWsAborts": {"kind":"number","context":"worker"},
		"connections": {"kind":"number","context":"worker"},
		"forEachSubscriber": {"kind":"function","context":"worker"},
		"grantPublish": {"kind":"function","context":"worker"},
		"isWarmupRequest": {"kind":"function","context":"worker"},
		"maxPayloadLength": {"kind":"number","context":"worker"},
		"metrics": {"kind":"object|null","context":"worker"},
		"metricsSnapshot": {"kind":"function","context":"worker"},
		"monotonic": {"kind":"function","context":"worker"},
		"now": {"kind":"function","context":"worker"},
		"onPressure": {"kind":"function","context":"worker"},
		"onPublishRate": {"kind":"function","context":"worker"},
		"pressure": {"kind":"object","context":"worker"},
		"protection": {"kind":"string","context":"worker"},
		"publish": {"kind":"function","context":"worker"},
		"publishBatched": {"kind":"function","context":"worker"},
		"publishGame": {"kind":"function","context":"worker"},
		"publishGrant": {"kind":"function","context":"worker"},
		"publishWire": {"kind":"function","context":"worker"},
		"publishWireBatch": {"kind":"function","context":"worker"},
		"random": {"kind":"object","context":"worker"},
		"registerWireCodec": {"kind":"function","context":"worker"},
		"requestId": {"kind":"string","context":"connection"},
		"revokePublish": {"kind":"function","context":"worker"},
		"send": {"kind":"function","context":"worker"},
		"sendCoalesced": {"kind":"function","context":"worker"},
		"sendTo": {"kind":"function","context":"worker"},
		"sendWire": {"kind":"function","context":"worker"},
		"sendWireBatch": {"kind":"function","context":"worker"},
		"subscribe": {"kind":"function","context":"worker"},
		"subscribers": {"kind":"function","context":"worker"},
		"topic": {"kind":"function","context":"worker"},
		"topicEpoch": {"kind":"function","context":"worker"},
		"unsubscribe": {"kind":"function","context":"worker"}
	}
};

const testing = {
	schemaVersion: 1,
	adapter: "svelte-adapter-bunserve/testing",
	members: {
		"adviseReconnect": {"kind":"function","context":"worker"},
		"assertions": {"kind":"object","context":"worker"},
		"authorizeDelivery": {"kind":"function","context":"worker"},
		"authorizeWireSubscribe": {"kind":"function","context":"worker"},
		"bufferedAmount": {"kind":"function","context":"worker"},
		"bumpTopicEpoch": {"kind":"function","context":"worker"},
		"checkSubscribe": {"kind":"function","context":"worker"},
		"closedWsAborts": {"kind":"number","context":"worker"},
		"connections": {"kind":"number","context":"worker"},
		"forEachSubscriber": {"kind":"function","context":"worker"},
		"grantPublish": {"kind":"function","context":"worker"},
		"isWarmupRequest": {"kind":"function","context":"worker"},
		"maxPayloadLength": {"kind":"number","context":"worker"},
		"metrics": {"kind":"object|null","context":"worker"},
		"metricsSnapshot": {"kind":"function","context":"worker"},
		"monotonic": {"kind":"function","context":"worker"},
		"now": {"kind":"function","context":"worker"},
		"pressure": {"kind":"object","context":"worker"},
		"protection": {"kind":"string","context":"worker"},
		"publish": {"kind":"function","context":"worker"},
		"publishBatched": {"kind":"function","context":"worker"},
		"publishGame": {"kind":"function","context":"worker"},
		"publishGrant": {"kind":"function","context":"worker"},
		"publishWire": {"kind":"function","context":"worker"},
		"publishWireBatch": {"kind":"function","context":"worker"},
		"random": {"kind":"object","context":"worker"},
		"registerWireCodec": {"kind":"function","context":"worker"},
		"requestId": {"kind":"string","context":"connection"},
		"revokePublish": {"kind":"function","context":"worker"},
		"send": {"kind":"function","context":"worker"},
		"sendCoalesced": {"kind":"function","context":"worker"},
		"sendTo": {"kind":"function","context":"worker"},
		"sendWire": {"kind":"function","context":"worker"},
		"sendWireBatch": {"kind":"function","context":"worker"},
		"subscribe": {"kind":"function","context":"worker"},
		"subscribers": {"kind":"function","context":"worker"},
		"topic": {"kind":"function","context":"worker"},
		"topicEpoch": {"kind":"function","context":"worker"},
		"unsubscribe": {"kind":"function","context":"worker"}
	}
};

for (const contract of [production, testing]) {
	for (const requirement of Object.values(contract.members)) Object.freeze(requirement);
	Object.freeze(contract.members);
	Object.freeze(contract);
}

export const CANONICAL_PLATFORM_CONTRACTS = Object.freeze({
	"svelte-adapter-bunserve": production,
	"svelte-adapter-bunserve/testing": testing
});
