// Small error-response constructors. Fresh Response per call - a Response is
// one-shot in the fetch model, so a shared constant would break on reuse.

/** @returns {Response} */
export function response400() {
	return new Response('Bad Request', {
		status: 400,
		headers: { 'content-type': 'text/plain' }
	});
}

/** @returns {Response} */
export function response413() {
	return new Response('Content Too Large', {
		status: 413,
		headers: { 'content-type': 'text/plain' }
	});
}

/** @returns {Response} */
export function response500() {
	return new Response('Internal Server Error', {
		status: 500,
		headers: { 'content-type': 'text/plain' }
	});
}
