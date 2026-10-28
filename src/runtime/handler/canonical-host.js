import { canonical_host_aliases, origin, host_header, port_header, protocol_header, is_tls } from './config.js';
import { originFromHeaders } from '../utils/request-origin.js';
import { invalidHost } from '../utils/request-target.js';
import { response400 } from './http-helpers.js';

export const canonicalRedirectEnabled = canonical_host_aliases.length !== 0;
const aliases = new Set(canonical_host_aliases);
const source = { isTls: is_tls, hostHeader: host_header, portHeader: port_header, protocolHeader: protocol_header };

/** Answer configured aliases before static delivery or SSR body sharing. */
export function tryCanonicalHostRedirect(request, target) {
	const headers = request.headers;
	const host = headers.get('host');
	const transfer = headers.get('transfer-encoding');
	const length = headers.get('content-length');
	if (!target.startsWith('/') || invalidHost(host) || host.includes(',') ||
		(transfer !== null && (transfer.toLowerCase() !== 'chunked' || length !== null)) ||
		(length !== null && !/^[0-9]+$/.test(length))) return response400();
	let authority;
	try {
		const fromHeaders = originFromHeaders(headers, source);
		new URL(fromHeaders);
		authority = fromHeaders.slice(fromHeaders.indexOf('://') + 3).toLowerCase();
	} catch { return response400(); }
	if (!aliases.has(authority)) return null;
	if (['CONNECT', 'TRACE', 'TRACK'].includes(request.method)) {
		return new Response('Method Not Allowed', { status: 405, headers: { 'content-type': 'text/plain', allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' } });
	}
	return new Response(null, { status: 308, headers: { location: origin + target } });
}
