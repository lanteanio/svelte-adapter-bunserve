import { wsFacade } from './handler/ws-facade.js';
import { now } from './runtime.js';
import { nativeTopic } from './utils/recognized-string.js';

// Transport bridge for the public test server. The dispatch and hook contract
// use the family socket facade; Bun owns the listener and WebSocket frames.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asBytes(value) {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return encoder.encode(String(value));
}

function payload(value, binary) {
	return binary ? asBytes(value) : typeof value === 'string' ? value : decoder.decode(asBytes(value));
}

export function App() {
	if (typeof Bun === 'undefined') throw new Error('createTestServer requires the Bun runtime. Run the test with bun.');
	const routes = [];
	let socketRoute = null;
	let server;
	const connections = new Set();
	const matches = (pattern, path) => pattern.endsWith('/*')
		? path.startsWith(pattern.slice(0, -1)) || path === pattern.slice(0, -2)
		: pattern === '*' || pattern === path;
	const app = {
		ws(path, behavior) { socketRoute = { path, behavior }; return app; },
		get(path, handler) { routes.push({ method: 'GET', path, handler }); return app; },
		head(path, handler) { routes.push({ method: 'HEAD', path, handler }); return app; },
		any(path, handler) { routes.push({ method: '*', path, handler }); return app; },
		numSubscribers(topic) { return server?.subscriberCount(nativeTopic(topic)) ?? 0; },
		publish(topic, message, binary = false) {
			if (!server || server.subscriberCount(nativeTopic(topic)) === 0) return false;
			const value = payload(message, binary);
			return server.publish(nativeTopic(topic), value) !== 0 || (typeof value === 'string' ? value.length === 0 : value.byteLength === 0);
		},
		listen(host, port, callback) {
			if (callback === undefined) { callback = port; port = host; host = '0.0.0.0'; }
			const behavior = socketRoute?.behavior ?? {};
			try {
				server = Bun.serve({
					port,
					hostname: host,
					fetch(request, listener) {
						const url = new URL(request.url);
						const upgrade = request.method === 'GET' &&
							request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
							socketRoute && matches(socketRoute.path, url.pathname);
						const route = upgrade ? null : routes.find((entry) =>
							(entry.method === '*' || entry.method === request.method) && matches(entry.path, url.pathname));
						if (!upgrade && !route) return new Response('Not Found', { status: 404 });
						return new Promise((resolve, reject) => {
							let status = 200;
							const headers = new Headers();
							let finished = false;
							let aborted = null;
							const ip = listener.requestIP(request)?.address ?? '127.0.0.1';
							const onAbort = () => { if (!finished) { finished = true; aborted?.(); resolve(new Response(null, { status: 499 })); } };
							request.signal.addEventListener('abort', onAbort, { once: true });
							const finish = (body = null) => {
								if (finished) return response;
								if (request.method === 'HEAD') headers.set('date', new Date(now()).toUTCString()); // determinism-allow: formats the injected runtime timestamp
								if (request.method === 'HEAD' || status === 204 || status === 304) body = null;
								const result = new Response(body, { status, headers });
								finished = true;
								request.signal.removeEventListener('abort', onAbort);
								resolve(result);
								return response;
							};
							const response = {
								writeStatus(value) { status = Number.parseInt(value, 10); return response; },
								writeHeader(name, value) {
									// Fetch header strings contain one code unit per byte.
									const text = value instanceof ArrayBuffer || ArrayBuffer.isView(value)
										? Buffer.from(asBytes(value)).toString('latin1') : String(value);
									headers.append(name, text);
									return response;
								},
								end(body, close = false) { if (close) headers.set('connection', 'close'); return finish(body); },
								endWithoutBody(length, close = false) {
									if (length !== undefined && status !== 204) headers.set('content-length', String(length));
									if (close) headers.set('connection', 'close');
									return finish();
								},
								cork(fn) { fn(); return response; },
								onAborted(fn) { aborted = fn; return response; },
								getRemoteAddressAsText() { return encoder.encode(ip); },
								onData(fn) {
									(async () => {
										const reader = request.body?.getReader();
										try {
											if (reader) for (;;) {
												const { value, done } = await reader.read();
												if (done || finished) break;
												fn(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength), false);
											}
											if (!finished) fn(new ArrayBuffer(0), true);
										} catch { onAbort(); }
										finally { reader?.releaseLock(); }
									})();
									return response;
								},
								upgrade(userData, _key, protocol) {
									if (finished) return;
									if (protocol) headers.set('sec-websocket-protocol', protocol);
									const accepted = listener.upgrade(request, { headers, data: userData });
									if (!accepted) { status = 400; finish('Bad Request'); return; }
									finished = true;
									request.signal.removeEventListener('abort', onAbort);
									resolve(undefined);
								}
							};
							const req = {
								getMethod: () => request.method.toLowerCase(),
								getUrl: () => url.pathname,
								getQuery: () => url.search.slice(1),
								getHeader: (name) => request.headers.get(name) ?? '',
								forEach: (fn) => request.headers.forEach((value, name) => fn(name, value))
							};
							if (request.signal.aborted) { onAbort(); return; }
							try {
								if (upgrade) behavior.upgrade(response, req, null);
								else route.handler(response, req);
							} catch (error) { request.signal.removeEventListener('abort', onAbort); reject(error); }
						});
					},
					websocket: {
						maxPayloadLength: behavior.maxPayloadLength,
						idleTimeout: behavior.idleTimeout,
						sendPings: behavior.sendPingsAutomatically,
						open(socket) {
							connections.add(socket);
							try { behavior.open?.(wsFacade(socket, () => server)); }
							catch (error) { socket.terminate(); throw error; }
						},
						message(socket, message) {
							const bytes = asBytes(message);
							behavior.message?.(wsFacade(socket, () => server), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), typeof message !== 'string');
						},
						drain(socket) { behavior.drain?.(wsFacade(socket, () => server)); },
						close(socket, code, reason) {
							const facade = wsFacade(socket, () => server);
							if (!facade) return;
							connections.delete(socket);
							facade._markClosed();
							try { behavior.close?.(facade, facade._noStatusSent ? 0 : code, encoder.encode(reason).buffer); }
							finally { facade._markDetached(); }
						}
					}
				});
			} catch { callback(false); return app; }
			callback({ port: server.port, close() { for (const ws of connections) ws.terminate(); server.stop(true); } });
			return app;
		}
	};
	return app;
}

export const us_socket_local_port = (listener) => listener.port;
export const us_listen_socket_close = (listener) => listener.close();
