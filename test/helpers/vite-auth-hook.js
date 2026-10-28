const DECLARED_LENGTH_RESPONSES = {
	'declared-body': () => new Response('hello', { headers: { 'content-length': '99' } }),
	'declared-empty': () => new Response(null, { status: 200, headers: { 'content-length': '42' } }),
	'declared-204': () => new Response(null, { status: 204, headers: { 'content-length': '42' } }),
	'304': () => new Response(null, { status: 304, headers: { 'content-length': '42' } }),
	'304-loose': () => new Response(null, { status: 304, headers: { 'content-length': '42abc' } })
};

// Exporting this is what makes the adapter register the auth preflight route
// (`connect({ auth: true })` POSTs it before upgrading), so it is required for
// any test of that endpoint. Accepts everything: the tests here are about the
// door in front of the hook, not about the hook's own decision. The
// cookie-probe lane exists because the adapter's cookie defaults (the Secure
// derivation from the request URL, relative-path resolution) are only
// observable on a real response's Set-Cookie header. The echo and broken-body
// lanes let a suite hold the dev plugin to production by running this same
// function on both.
export function authenticate({ cookies, headers, url, request }) {
	if (headers['x-auth-response'] === 'date') return new Response('dated', { headers: { date: 'Thu, 01 Jan 1970 00:00:00 GMT' } });
	if (headers['x-auth-response'] === 'error') {
		cookies.set('error_cookie', 'must-not-escape', { path: '/' });
		return Response.error();
	}
	if (headers['x-auth-response'] === '304-custom') {
		return new Response(null, { status: 304, headers: { 'content-length': headers['x-auth-length'] || 'abc' } });
	}
	// A hook may answer with its own Response; these lanes return a bodyless
	// 204, and Responses that declare a length of their own, so the wire the
	// adapter writes for that branch is observable too.
	if (headers['x-auth-response'] === '204') return new Response(null, { status: 204 });
	if (Object.hasOwn(DECLARED_LENGTH_RESPONSES, headers['x-auth-response'] ?? '')) {
		return DECLARED_LENGTH_RESPONSES[headers['x-auth-response']]();
	}
	if (headers['x-auth-echo'] === '1') {
		return Response.json(
			{ url, requestUrl: request.url, headerNames: Object.keys(headers).sort() },
			{ headers: { 'x-auth-echo': '1' } }
		);
	}
	// A cookie past ASCII, and on the Response a header value and a Set-Cookie
	// past ASCII, which a Headers value can be only up to U+00FF.
	if (headers['x-auth-non-ascii'] === 'response' || headers['x-auth-non-ascii'] === 'implicit') {
		cookies.set('\u2603', 'v', { path: '/\u2641' });
		if (headers['x-auth-non-ascii'] === 'response') {
			return new Response('ok', { headers: { 'x-text': '\u00e9', 'set-cookie': 'a=\u00e9' } });
		}
	}
	// A hook that reads the request body, so the body cap answers a body sent
	// without a declared length, and reports how many bytes it read.
	if (headers['x-auth-read-body'] === '1') {
		return request.arrayBuffer().then((body) => new Response(null, {
			status: 204,
			headers: { 'x-body-length': String(body.byteLength) }
		}));
	}
	// A Response whose body fails to read, after the hook set a cookie. Its Date
	// is one no server would write today.
	if (headers['x-auth-broken-body'] === '1') {
		cookies.set('probe_session', 'probe-value', { path: '/' });
		return new Response(
			new ReadableStream({ start(controller) { controller.error(new Error('body failed')); } }),
			{ headers: { 'set-cookie': 'sid=granted', 'x-from-hook': '1', date: 'Mon, 01 Jan 2001 00:00:00 GMT' } }
		);
	}
	if (headers['x-set-cookie-probe'] === '1') {
		cookies.set('probe_session', 'probe-value', {
			path: headers['x-cookie-path'] || '/'
		});
	}
	return { userId: 'fixture-user' };
}
