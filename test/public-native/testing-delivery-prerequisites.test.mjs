import { test, expect } from 'bun:test';
import { createTestServer } from '../../src/testing.js';
import { runWithTraceContext } from '../../src/runtime/tracing.js';
import { allocWireId, retireWireId } from '../../src/runtime/wire.js';
import { setSubscriptionAccountingHook, trackedSubscribe, WS_SUBSCRIPTIONS, isSettledSubscriptionRegistry } from '../../src/runtime/utils/ws-symbols.js';

test('the testing platform carries the active trace context through asynchronous work', async () => {
  const server = await createTestServer();
  const context = { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' };
  try {
    expect(server.platform.traceContext).toBeNull();
    await runWithTraceContext(context, async () => {
      expect(server.platform.traceContext).toEqual(context);
      await server.platform.trace.run('test.operation', {}, async () => {
        await Promise.resolve();
        expect(server.platform.traceContext).toEqual(context);
      });
    });
    expect(server.platform.traceContext).toBeNull();
  } finally { await server.close(); }
});

test('native testing memberships and tracked plugin memberships never charge the production sink', async () => {
  const deltas = [];
  setSubscriptionAccountingHook((...delta) => deltas.push(delta));
  let socket;
  const server = await createTestServer({ handler: { open(ws) { socket = ws; } } });
  const client = new WebSocket(server.wsUrl);
  try {
    await new Promise((resolve, reject) => { client.addEventListener('open', resolve, { once: true }); client.addEventListener('error', reject, { once: true }); });
    await server.platform.subscribe(socket, 'direct');
    trackedSubscribe(socket, 'plugin');
    const registry = socket.getUserData()[WS_SUBSCRIPTIONS];
    expect([...registry].sort()).toEqual(['direct', 'plugin']);
    await server.close();
    expect(isSettledSubscriptionRegistry(registry)).toBe(true);
    expect(deltas).toEqual([]);
  } finally { client.close(); await server.close(); setSubscriptionAccountingHook(null); }
});

test('a retired unannounced wire id is never reused across later announcements', () => {
  const slot = Symbol('topic-ids');
  const first = {}; const second = {};
  retireWireId(first, slot, 'a');
  expect(allocWireId(first, slot, 'a').id).toBe(1);
  expect(allocWireId(first, slot, 'b').id).toBe(2);
  expect(allocWireId(second, slot, 'a').id).toBe(1);
  retireWireId(first, slot, 'a');
  retireWireId(first, slot, 'a');
  expect(allocWireId(first, slot, 'a')).toEqual({ id: 3, isNew: true });
  expect(allocWireId(first, slot, 'b')).toEqual({ id: 2, isNew: false });
  expect(allocWireId(second, slot, 'a')).toEqual({ id: 1, isNew: false });
});
