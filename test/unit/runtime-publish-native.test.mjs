import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { wsConnections, setServer, WS_CAPS } = await import('../../src/runtime/handler/ws-state.js');
const { buildBinaryFrame } = await import('../../src/runtime/wire.js');
const { encodeValue } = await import('../../src/runtime/wire-value.js');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

test('native batch and granted game delivery retain sequence, slices and sender exclusion', { skip: !globalThis.Bun, timeout: 15000 }, async () => {
 const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch(request, native) { if (native.upgrade(request, { data: upgradeData() })) return; return new Response('upgrade', { status: 426 }); },
  websocket: websocketHandlers
 });
 setServer(server);
 const clients = [], received = [[], []], waiters = [[], []];
 async function until(index, predicate) {
  if (predicate(received[index])) return;
  await new Promise(resolve => waiters[index].push(() => { if (predicate(received[index])) { resolve(); return true; } }));
 }
 try {
  for (let index = 0; index < 2; index++) {
   const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
   client.addEventListener('message', event => {
    received[index].push(JSON.parse(event.data));
    waiters[index] = waiters[index].filter(check => !check());
   });
   await new Promise((resolve, reject) => { client.addEventListener('open', resolve, { once: true }); client.addEventListener('error', reject, { once: true }); });
   clients.push(client);
   await until(index, rows => rows.some(row => row.type === 'welcome'));
  }
  const [sender, peer] = [...wsConnections];
  for (const socket of [sender, peer]) { await platform.subscribe(socket, 'native-batch'); socket.getUserData()[WS_CAPS] = new Set(['batch']); }
  assert.throws(() => platform.publishBatched([{ topic: 'native-batch', event: 'x', data: 1 }, { topic: 'native-batch', event: 'x', data: 1n }]), TypeError);
  platform.publishBatched([{ topic: 'native-batch', event: 'x', data: 2 }, { topic: 'native-batch', event: 'x', data: 3 }]);
  await Promise.all([0, 1].map(index => until(index, rows => rows.some(row => row.type === 'batch'))));
  for (const rows of received) assert.deepEqual(rows.find(row => row.type === 'batch').events.map(event => [event.data, event.seq]), [[2, 1], [3, 2]]);
  platform.grantPublish(sender, 'native-batch');
  const outcome = platform.publishGame(sender, 'native-batch', 'move', { x: 4 }, 9);
  assert.deepEqual(outcome, { seq: 3, delivered: 1 });
  await until(1, rows => rows.some(row => row.event === 'move'));
  assert.deepEqual(received[1].find(row => row.event === 'move'), { topic: 'native-batch', event: 'move', data: { x: 4 }, seq: 3, id: 9 });
  clients[0].send(JSON.stringify({ type: 'hello', caps: ['batch', 'wire.ingress:1'] }));
  clients[0].send(JSON.stringify({ type: 'ingress-bind', id: 9, kind: 'game:1' }));
  await until(0, rows => rows.some(row => row.type === 'ingress-bound' && row.id === 9));
  clients[0].send(buildBinaryFrame(1, 9, 1, encodeValue(['compact-move', { x: 5 }, 10])));
  await until(1, rows => rows.some(row => row.event === 'compact-move'));
  assert.deepEqual(received[1].find(row => row.event === 'compact-move'), { topic: 'native-batch', event: 'compact-move', data: { x: 5 }, seq: 4, id: 10 });
  sender.send(JSON.stringify({ type: 'barrier' }));
  await until(0, rows => rows.some(row => row.type === 'barrier'));
  assert.equal(received[0].some(row => row.event === 'move' || row.event === 'compact-move'), false);
  platform.unsubscribe(sender, 'native-batch');
  assert.equal(platform.publishGrant(sender), null);
  clients[0].send(buildBinaryFrame(1, 9, 2, encodeValue(['compact-move', { x: 6 }, 11])));
  await until(0, rows => rows.some(row => row.type === 'game-denied' && row.id === 11));
  assert.equal(received[0].find(row => row.type === 'game-denied' && row.id === 11).reason, 'FORBIDDEN');
  peer.send(JSON.stringify({ type: 'revocation-barrier' }));
  await until(1, rows => rows.some(row => row.type === 'revocation-barrier'));
  assert.equal(received[1].some(row => row.event === 'compact-move' && row.id === 11), false);
 } finally {
  for (const client of clients) client.close();
  await server.stop(true);
 }
});
