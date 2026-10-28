import { test, expect } from 'bun:test';
import { connect } from 'node:net';
import { createTestServer } from '../../src/testing.js';

test('the testing admin response preserves Fetch header bytes and strips connection-nominated fields', async () => {
  const server = await createTestServer({ handler: { admin() {
    return new Response('ok', { headers: { 'x-byte': 'caf\u00e9', connection: 'x-private', 'x-private': 'secret', 'set-cookie': 'key=caf\u00e9' } });
  } } });
  try {
    const port = Number(new URL(server.url).port);
    const bytes = await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      const parts = [];
      socket.setTimeout(3000, () => socket.destroy(new Error('raw response timed out')));
      socket.on('data', part => parts.push(part));
      socket.on('error', reject);
      socket.on('close', () => resolve(Buffer.concat(parts)));
      socket.on('connect', () => socket.write('GET /__realtime/bytes HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    });
    const wire = bytes.toString('latin1');
    expect(wire).toMatch(/^HTTP\/1.1 200 /);
    expect(wire.toLowerCase()).toContain('x-byte: caf\u00e9\r\n');
    expect(wire.toLowerCase()).toContain('set-cookie: key=caf\u00e9\r\n');
    expect(wire.toLowerCase()).not.toContain('x-private:');
  } finally { await server.close(); }
});
