/* global WS_OPTIONS */
import { createDeliveryAuthorization } from '../utils/delivery-authorization.js';
import { recordBackpressureDrop } from '../utils/backpressure.js';
import { wsCounters } from './ws-state.js';
import { nativeTopic } from '../utils/recognized-string.js';

// The worker's one delivery boundary. Its pending-byte bound defaults to the
// transport's own (maxBackpressure) and, like that bound, closes the connection
// on overflow when closeOnBackpressureLimit asks for it. A frame it drops past
// the bound is counted in the same pressure window as a transport drop.
const wsOptions = typeof WS_OPTIONS === 'undefined' ? null : WS_OPTIONS;

export const deliveryAuthorization = createDeliveryAuthorization({
	maxPendingBytes: wsOptions?.maxBackpressure,
	closeOnOverflow: wsOptions?.closeOnBackpressureLimit === true,
	onDrop: (_ws, bytes) => {
		recordBackpressureDrop(wsCounters, { byteLength: bytes });
		wsCounters.transportMetricHooks?.dropped(bytes);
	}
});

const publishSurfaces = new WeakMap();

/** Preserve native Bun publish results on the unarmed path. */
export function publishAuthorized(server, connections, topic, payload, binary, compress, logicalTopic = topic) {
	if (!deliveryAuthorization.armed) return server.publish(nativeTopic(topic), payload, compress);
	let surface = publishSurfaces.get(server);
	if (surface === undefined) {
		surface = {
			numSubscribers: (name) => server.subscriberCount(nativeTopic(name)),
			publish: (name, value, _binary, compression) => server.publish(nativeTopic(name), value, compression)
		};
		publishSurfaces.set(server, surface);
	}
	// The policy's publication result describes an eligible subscription,
	// independent of the eventual decision. Keep the native-number boundary
	// consumed by publishReached at production call sites.
	return deliveryAuthorization.publish(surface, connections, topic, payload, binary, compress, logicalTopic) ? 1 : 0;
}
