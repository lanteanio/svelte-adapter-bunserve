import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { platform, unsubscribeFromWire } = await import('../../src/runtime/handler/platform.js');
const { setServer, wsConnections, maxAuthoritativeSeq, WS_SUBSCRIPTIONS, WS_CAPS } = await import('../../src/runtime/handler/ws-state.js');
const { trackedUnsubscribe, addLogicalSubscription } = await import('../../src/runtime/utils/ws-symbols.js');
const frames = [];
setServer({ subscriberCount: topic => [...wsConnections].filter(ws => ws.getUserData()[WS_SUBSCRIPTIONS].has(topic)).length, publish(topic, frame) { frames.push({ topic, frame: JSON.parse(frame) }); return frame.length; } });
function socket(topic, caps = []) {
 const ud = { [WS_SUBSCRIPTIONS]: new Set(topic ? [topic] : []), [WS_CAPS]: new Set(caps) };
 const ws = { sent: [], getUserData: () => ud, unsubscribe() { return true; }, send(payload) { ws.sent.push(payload); return 1; } };
 wsConnections.add(ws);
 return ws;
}

test('invalid ordinary publish data does not consume the next sequence', () => {
 const topic = 'serialize-single';
 assert.throws(() => platform.publish(topic, 'event', 1n), TypeError);
 platform.publish(topic, 'event', 'ok');
 assert.equal(frames.at(-1).frame.seq, 1);
});

test('a shared batch validates all payloads before any sequence advances', () => {
 const topic = 'serialize-batch'; const ws = socket(topic, ['batch']);
 try {
  assert.throws(() => platform.publishBatched([{ topic, event: 'value', data: 1 }, { topic, event: 'value', data: 1n }]), TypeError);
  platform.publishBatched([{ topic, event: 'value', data: 2 }, { topic, event: 'value', data: 3 }]);
  assert.deepEqual(frames.at(-1).frame.events.map(e => e.seq), [1, 2]);
 } finally { wsConnections.delete(ws); }
});

test('batch coalescing and capability fallback preserve lead frame shapes', () => {
 const topic = 'coalesced-batch'; const ws = socket(topic, ['batch']);
 try {
  platform.publishBatched([{ topic, event: 'value', data: 1, coalesceKey: 'a' }, { topic, event: 'value', data: 2 }, { topic, event: 'value', data: 3, coalesceKey: 'a' }]);
  assert.deepEqual(frames.at(-1).frame.events.map(e => e.data), [2, 3]);
  ws.getUserData()[WS_CAPS].clear(); const before = frames.length;
  platform.publishBatched([{ topic, event: 'value', data: 4 }, { topic, event: 'value', data: 5 }]);
  assert.deepEqual(frames.slice(before).map(e => e.frame.data), [4, 5]);
 } finally { wsConnections.delete(ws); }
});

test('game grants bind fanout and clear on every unsubscribe lane', () => {
 const topic = 'game-room'; const sender = socket(topic); const peer = socket(topic);
 try {
  assert.equal(platform.grantPublish(sender, topic), true);
  assert.equal(platform.publishGrant(sender), topic);
  const outcome = platform.publishGame(sender, topic, 'move', { x: 1 }, 7);
  assert.deepEqual(outcome, { seq: 1, delivered: 1 });
  assert.deepEqual(sender.sent, []);
  assert.deepEqual(JSON.parse(peer.sent[0]), { topic, event: 'move', data: { x: 1 }, seq: 1, id: 7 });
  for (const remove of [platform.unsubscribe, unsubscribeFromWire, trackedUnsubscribe]) {
   platform.grantPublish(sender, topic);
   sender.getUserData()[WS_SUBSCRIPTIONS].delete(topic);
   addLogicalSubscription(sender.getUserData()[WS_SUBSCRIPTIONS], topic);
   remove(sender, topic);
   assert.equal(platform.publishGrant(sender), null);
  }
  assert.equal(platform.revokePublish(sender), false);
  platform.grantPublish(sender, topic);
  assert.equal(platform.revokePublish(sender), true);
 } finally { wsConnections.delete(sender); wsConnections.delete(peer); }
});

for (const [kind, bad] of [
 ['function', () => () => 1], ['symbol', () => Symbol('value')],
 ['cycle', () => { const value = {}; value.self = value; return value; }],
 ['undefined-toJSON', () => ({ toJSON() {} })],
 ['throwing-toJSON', () => ({ toJSON() { throw new TypeError('refused'); } })]
]) {
 test(`refused ${kind} payload leaves the production sequence unchanged`, () => {
  const topic = 'production-serialization-' + kind;
  platform.publish(topic, 'value', 'before');
  assert.throws(() => platform.publish(topic, 'value', bad()), TypeError);
  platform.publish(topic, 'value', 'after');
  assert.deepEqual(frames.filter(row => row.topic === topic).map(row => row.frame.seq), [1, 2]);
 });
}

test('production serialization runs once and stamps nested publications first', () => {
 const topic = 'production-serialization-nested'; let calls = 0;
 platform.publish(topic, 'value', { toJSON() { calls++; platform.publish(topic, 'value', 'nested'); return 'outer'; } });
 assert.equal(calls, 1);
 assert.deepEqual(frames.filter(row => row.topic === topic).map(row => [row.frame.data, row.frame.seq]), [['nested', 1], ['outer', 2]]);
});

test('refused production publications preserve authoritative recovery marks', () => {
 const topic = 'production-authoritative-serialization'; const ws = socket(topic, ['batch']);
 try {
  platform.publish(topic, 'value', 'before', { seq: 4 });
  assert.throws(() => platform.publish(topic, 'value', 1n, { seq: 5 }), TypeError);
  assert.equal(maxAuthoritativeSeq.get(topic), 4);
  assert.throws(() => platform.publishBatched([
   { topic, event: 'value', data: 'first', options: { seq: 5 } },
   { topic, event: 'value', data: 1n, options: { seq: 6 } }
  ]), TypeError);
  assert.equal(maxAuthoritativeSeq.get(topic), 4);
 } finally { wsConnections.delete(ws); }
});
