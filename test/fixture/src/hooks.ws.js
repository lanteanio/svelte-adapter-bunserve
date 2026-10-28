import { digestCredential, identityResponseHeaders } from './identity-headers.js';
export * from './ws-handler.js';


export async function admin(request) {
 const url = new URL(request.url);
 if (url.searchParams.has('identityHeaders')) {
  if (!['Bearer admin', digestCredential].includes(request.headers.get('authorization'))) return new Response('unauthorized', { status: 401 });
  return new Response('ok', { headers: identityResponseHeaders(request.headers) });
 }
 if (request.headers.get('authorization') !== 'Bearer admin') return new Response('unauthorized', { status: 401 });
 if (url.searchParams.has('throw')) throw new Error('private admin detail');
 if (url.searchParams.has('zero')) return Response.error();
 const headers = new Headers({ 'content-type': 'application/json', date: 'Sun, 06 Nov 1994 08:49:37 GMT', 'content-length': '999999', 'transfer-encoding': 'chunked' });
 headers.append('set-cookie', 'first=1'); headers.append('set-cookie', 'second=2');
 return new Response(JSON.stringify({ method: request.method, pathname: url.pathname, body: request.method === 'POST' ? await request.text() : '' }), { headers });
}
