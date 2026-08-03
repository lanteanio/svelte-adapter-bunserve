// WebSocket fan-out benchmark server: the Bun.serve side of the family's
// ws-fanout A/B (the sibling's bench suite carries the uWS side with the
// identical message semantics: control-prefix subscribe parsing, JSON
// envelope wrapping, publish fan-out, user-message rebroadcast). The demux
// and envelope byte-work are the shipped modules, imported; the rest is a
// transport FLOOR - no gate, no facade, no counters - exactly like the
// sibling's bench server, so the pair measures transport against transport.
// The adapter's own per-publish bookkeeping cost is measured separately by
// bench/publish-bump-micro.mjs.
//
// Run under Bun:  bun bench/ws-fanout-bunserve.mjs
// Then drive it:  bun bench/ws-fanout-client.mjs [clients] [duration_s]
// The uWS side:   node <svelte-adapter-uws>/bench/24-ws-adapter-uws.mjs
// (same client, same port, same workload - the pair is the A/B).

import { looksLikeControlFrame } from '../src/runtime/utils/control-frame.js';
import { buildEnvelopePrefix, completeEnvelope } from '../src/runtime/utils/envelope.js';

const PORT = parseInt(process.env.PORT || '9002');

const prefixCache = new Map();
function publish(topic, event, data) {
	let prefix = prefixCache.get(topic + '\0' + event);
	if (prefix === undefined) {
		prefix = buildEnvelopePrefix(topic, event);
		prefixCache.set(topic + '\0' + event, prefix);
	}
	server.publish(topic, completeEnvelope(prefix, data), false);
}

const server = Bun.serve({
	hostname: '0.0.0.0',
	port: PORT,
	fetch(req, srv) {
		if (srv.upgrade(req, { data: {} })) return undefined;
		return new Response('ws only', { status: 400 });
	},
	websocket: {
		open() {},
		message(ws, message) {
			if (typeof message === 'string' && message.length < 512 && looksLikeControlFrame(message)) {
				try {
					const msg = JSON.parse(message);
					if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
						ws.subscribe(msg.topic);
						return;
					}
					if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
						ws.unsubscribe(msg.topic);
						return;
					}
				} catch {
					// Not JSON; fall through to the user-message path.
				}
			}
			// User message handler - parse and rebroadcast via publish, the
			// same shape the sibling's bench server implements.
			try {
				const parsed = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
				if (parsed.topic) publish(parsed.topic, parsed.event, parsed.data);
			} catch {
				// Not JSON.
			}
		},
		close() {}
	}
});

console.log(`[ws-fanout-bunserve] listening on :${server.port}`);
