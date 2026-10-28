import { SHARED_CONNECTION_SLOTS } from './ws-symbols.js';

const connectionSlots = new Set([
	...SHARED_CONNECTION_SLOTS,
	...['coalesced', 'pending-requests', 'stats', 'topic-ids', 'wire-state', 'shared-cohorts', 'connection-permit', 'lease', 'control-budget'].map(key => Symbol.for('adapter-uws.ws.' + key))
]);

/** Copy enumerable application keys while isolating adapter connection state. */
export function copyUpgradeUserData(source, reserved = connectionSlots) {
	const copy = {};
	for (const key of Reflect.ownKeys(source ?? {})) {
		if (reserved.has(key) || !Object.prototype.propertyIsEnumerable.call(source, key)) continue;
		Object.defineProperty(copy, key, { value: source[key], writable: true, enumerable: true, configurable: true });
	}
	return copy;
}
