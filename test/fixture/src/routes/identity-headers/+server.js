import { identityResponseHeaders } from '../../identity-headers.js';

export function GET({ request }) {
	return new Response('ok', { headers: identityResponseHeaders(request.headers) });
}
