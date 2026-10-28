// The header lines of a complete WebSocket handshake, as a browser sends them.
// The upgrade path refuses anything less before it looks at capacity, origin or
// the app's hook (src/runtime/utils/ws-handshake.js), so a stand-in request
// that means to reach those carries all four.
export const HANDSHAKE = Object.freeze({
	upgrade: 'websocket',
	connection: 'Upgrade',
	'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
	'sec-websocket-version': '13'
});
