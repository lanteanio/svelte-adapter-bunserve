import { releaseSubscription, trackedSubscribe } from 'svelte-adapter-bunserve/subscriptions';

// Register a fixture-owned derived topic like a separately loaded plugin.
globalThis[Symbol.for('adapter-uws.derived-topic-prefixes')].add('__release:');
const states = new WeakMap();
const publishGrant = Symbol.for('adapter-uws.ws.publish-grant');
let retired;
export const wire = {
	capability: 'fixture.release:1', schemaVersion: 1, shared: true,
	encode: (_event, data) => new Uint8Array([data.nonce])
};
export const handles = topic => topic.startsWith('release:') || topic.startsWith('__release:release:');
function state(ws) {
	let value = states.get(ws);
	if (!value) { value = { gates: [], unsubscribes: 0 }; states.set(ws, value); }
	return value;
}
export function subscribe(ws, topic, { platform }) {
	const current = state(ws);
	const index = current.gates.length;
	const pending = new Promise(resolve => current.gates.push(resolve));
	platform.send(ws, '__release-probe', 'parked', { index, topic });
	return pending;
}
export function unsubscribe(ws) { state(ws).unsubscribes++; }
export async function message(ws, msg, platform) {
	const current = state(ws);
	const reply = (event, value = {}) => platform.send(ws, '__release-probe', event, { ...value, nonce: msg.nonce });
	if (msg.action === 'begin') reply('admitted', { denial: await platform.subscribe(ws, msg.topic) });
	if (msg.action === 'finish') current.gates[msg.index](msg.denial ?? null);
	if (msg.action === 'install') reply('installed', { installed: trackedSubscribe(ws, msg.topic) });
	if (msg.action === 'decorate') {
		trackedSubscribe(ws, '__release:' + msg.topic);
		ws.getUserData()[publishGrant] = msg.topic;
		reply('decorated');
	}
	if (msg.action === 'release') reply('released', { removed: releaseSubscription(ws, msg.topic) });
	if (msg.action === 'revoke') reply('revoked', { removed: platform.unsubscribe(ws, msg.topic) });
	if (msg.action === 'retired') reply('retired', { removed: retired ? releaseSubscription(retired, msg.topic) : null });
	if (msg.action === 'probe') {
		let logical = 0;
		platform.forEachSubscriber(msg.topic, () => logical++);
		reply('state', { logical, native: platform.subscribers(msg.topic), derived: platform.subscribers('__release:' + msg.topic), grant: ws.getUserData()[publishGrant] ?? null, unsubscribes: current.unsubscribes });
	}
	if (msg.action === 'publish') {
		platform.publish(msg.topic, 'base', { nonce: msg.nonce });
		platform.publish('__release:' + msg.topic, 'derived', { nonce: msg.nonce });
		platform.publishWire(msg.topic, 'shared', { nonce: msg.nonce }, wire);
		reply('published');
	}
}
export function close(ws) {
	if (!states.has(ws)) return;
	retired = ws;
	for (const finish of state(ws).gates) finish('FORBIDDEN');
	states.delete(ws);
}
