import { admin_path, ws_options, origin, get_origin, bodyLimitFor } from './config.js';
import { wsModule } from '../ws-handler-bridge.js';
import { openRequestLifetime } from './request-lifetime.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { tracingEnabled, traceOperation, extractTraceContext } from '../tracing.js';

export function adminRouteMounted() {
 return ws_options !== null && admin_path !== false && typeof wsModule.admin === 'function';
}

function errorResponse(status, message, headOnly) {
 const body = JSON.stringify({ error: message });
 return new Response(headOnly ? null : body, { status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'content-length': String(Buffer.byteLength(body))
 } });
}

/** Mount the application's Request-to-Response admin handler ahead of page routing. */
export function tryAdminEndpoint(native, target) {
 if (!adminRouteMounted() || !target.split('?')[0].startsWith(admin_path + '/')) return null;
 return tracingEnabled ? traceOperation('adapter.http.admin', { kind: 'server', parent: extractTraceContext(native.headers), attributes: { 'http.request.method': native.method, 'http.route.type': 'admin' } }, span => handleAdminRequest(native, target, span)) : handleAdminRequest(native, target);
}

async function handleAdminRequest(native, target, span) {
 const headOnly = native.method === 'HEAD';
 if (['CONNECT', 'TRACE', 'TRACK'].includes(native.method)) return new Response('Method Not Allowed', { status: 405, headers: { 'content-type': 'text/plain', allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' } });
 let parsed;
 try { parsed = new URL((origin || get_origin(native.headers)) + target); }
 catch { return errorResponse(400, 'bad request', headOnly); }
 if (!parsed.pathname.startsWith(admin_path + '/')) return errorResponse(400, 'bad request', headOnly);
 const bodyLimit = bodyLimitFor(native.method, target);
 const length = Number(native.headers.get('content-length'));
 if (native.method !== 'GET' && !headOnly && length > bodyLimit) {
  const response = errorResponse(413, 'payload too large', false);
  response.headers.set('connection', 'close');
  return response;
 }
 const lifetime = openRequestLifetime(native, bodyLimit);
 try {
  const request = lifetime.request(parsed.href);
  const response = await lifetime.guard(wsModule.admin(request));
  if (!(response instanceof Response) || response.status < 200 || response.status > 599) throw new TypeError('Invalid admin response');
  const body = response.body ? new Uint8Array(await lifetime.guard(response.arrayBuffer())) : null;
  const headers = new Headers(response.headers);
  headers.delete('date'); headers.delete('transfer-encoding'); headers.delete('content-length');
  if (!headers.has('x-content-type-options')) headers.set('x-content-type-options', 'nosniff');
  if (headOnly && body) headers.set('content-length', String(body.byteLength));
  if (response.status === 304 && !body && response.headers.has('content-length')) {
   const declared = response.headers.get('content-length');
   if (/^[0-9]+$/.test(declared)) headers.set('content-length', declared);
  }
  return lifetime.response(new Response(headOnly ? null : body, { status: response.status, statusText: response.statusText, headers }), true);
 } catch (error) {
  if (lifetime.bodyLimitExceeded) return lifetime.response(errorResponse(413, 'payload too large', false), true);
  lifetime.abort(error);
  try { span?.recordException?.(error); } catch {}
  try { span?.setAttribute?.('error.type', error?.name ?? typeof error); } catch {}
  emitOperationalEvent({ source: 'svelte-adapter-bunserve', component: 'runtime.admin', event: 'admin.handler-failed', severity: 'error', dataClass: 'pseudonymous', message: 'The admin handler failed; the request was answered 500.', attributes: { error: diagnosticError(error) } });
  return errorResponse(500, 'internal error', headOnly);
 } finally { lifetime.finish(); }
}
