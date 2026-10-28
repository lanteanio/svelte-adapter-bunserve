import { connect } from 'node:net';

export async function connectRawWebSocket(url) {
	const target = new URL(url);
	const socket = connect(Number(target.port), target.hostname);
	let buffered = Buffer.alloc(0);
	let upgraded = false;
	let resolveUpgrade;
	let rejectUpgrade;
	let resolveClose;
	const ready = new Promise((resolve, reject) => { resolveUpgrade = resolve; rejectUpgrade = reject; });
	const closed = new Promise(resolve => { resolveClose = resolve; });
	socket.on('connect', () => socket.write([
		`GET ${target.pathname} HTTP/1.1`, `Host: ${target.host}`, 'Connection: Upgrade',
		'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
		'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', ''
	].join('\r\n')));
	socket.on('error', rejectUpgrade);
	socket.on('end', () => resolveClose({ code: 1006, reason: '' }));
	socket.on('data', chunk => {
		buffered = Buffer.concat([buffered, chunk]);
		if (!upgraded) {
			const split = buffered.indexOf('\r\n\r\n');
			if (split < 0) return;
			if (!buffered.subarray(0, split).toString().startsWith('HTTP/1.1 101')) {
				rejectUpgrade(new Error('WebSocket handshake refused')); socket.destroy(); return;
			}
			buffered = buffered.subarray(split + 4); upgraded = true; resolveUpgrade();
		}
		while (buffered.length >= 2) {
			const opcode = buffered[0] & 15;
			let length = buffered[1] & 127;
			let offset = 2;
			if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
			if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
			if (buffered.length < offset + length) return;
			const payload = buffered.subarray(offset, offset + length);
			buffered = buffered.subarray(offset + length);
			if (opcode === 8) {
				resolveClose({ code: length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString() });
				socket.destroy();
			}
		}
	});
	await ready;
	return { closed, close() { socket.destroy(); } };
}
