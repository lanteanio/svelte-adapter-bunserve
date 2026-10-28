import { connect, on, ready, status, type ConnectOptions, type WSConnection } from 'svelte-adapter-bunserve/client';

const options: ConnectOptions = { auth: true, path: '/ws', reconnectInterval: 3000, maxReconnectInterval: 300000, maxReconnectAttempts: Infinity };
const connection: WSConnection = connect(options);
const admitted: boolean = connection.send({ type: 'message', value: 1 });
const serialized: boolean = connection.sendSerialized('{"type":"message"}');
// @ts-expect-error Pre-serialized messages must be text.
connection.sendSerialized(new Uint8Array([1]));
connection.sendQueued(new Uint8Array([1, 2]));
connection.simulateOffline();
connection.resumeOnline();
connection.on('room').subscribe(event => { if (event) console.log(event.topic, event.event, event.data); });
on('room', 'message').subscribe(value => { console.log(value); });
status.subscribe(value => { const state: 'connecting' | 'open' | 'suspended' | 'disconnected' | 'failed' = value; void state; });
const connected: Promise<void> = ready();
// @ts-expect-error Admission is a boolean, not a delivery receipt.
const receipt: number = connection.send('message');
// @ts-expect-error Offline simulation is a connection method, not a public option.
connect({ simulateOffline: true });
void admitted; void serialized; void connected; void receipt;
