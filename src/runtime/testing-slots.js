export const WS_COALESCED = Symbol.for('adapter-uws.ws.coalesced');
export const WS_PENDING_REQUESTS = Symbol.for('adapter-uws.ws.pending-requests');
export const WS_STATS = Symbol.for('adapter-uws.ws.stats');
export const WS_TOPIC_IDS = Symbol.for('adapter-uws.ws.topic-ids');
export const WS_WIRE_STATE = Symbol.for('adapter-uws.ws.wire-state');
export const WS_SHARED_COHORTS = Symbol.for('adapter-uws.ws.shared-cohorts');
export const WS_CONNECTION_PERMIT = Symbol.for('adapter-uws.ws.connection-permit');
export const WS_LEASE = Symbol.for('adapter-uws.ws.lease');
export const WS_CONTROL_BUDGET = Symbol.for('adapter-uws.ws.control-budget');
export const WS_REQUEST_ID_KEY = '__adapter_uws_request_id__';
export const CARRY_REQUEST_ID = Symbol('adapter-uws.carry.request-id');
import { declareConnectionSlots as declareSharedSlots } from './utils/ws-symbols.js';
export const TESTING_CONNECTION_SLOTS = Object.freeze([WS_COALESCED, WS_PENDING_REQUESTS, WS_STATS, WS_TOPIC_IDS, WS_WIRE_STATE, WS_SHARED_COHORTS, WS_CONNECTION_PERMIT, WS_LEASE, WS_CONTROL_BUDGET]);
export function declareConnectionSlots(userData) {
	declareSharedSlots(userData);
	for (const key of TESTING_CONNECTION_SLOTS) {
		if (!Object.hasOwn(userData, key)) Object.defineProperty(userData, key, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
}
