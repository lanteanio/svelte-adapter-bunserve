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


/**
 * Does this request frame a body that still has bytes to come? Framing was
 * validated where the headers were collected: a Transfer-Encoding is chunked,
 * and a Content-Length is digits.
 *
 * @param {Record<string, string>} headers
 * @returns {boolean}
 */
export function declaresBody(headers) {
	return headers['transfer-encoding'] !== undefined || parseInt(headers['content-length'], 10) > 0;
}


/**
 * Whether endBodyless can carry the close flag for this answer to a request
 * other than HEAD: only when it reports a length (see there). A HEAD never
 * has a body to close behind.
 *
 * @param {number} status
 * @param {string | null | undefined} declaredLength
 */
export function bodylessCanClose(status, declaredLength) {
	if (status === 204) return false;
	if (status !== 304) return true;
	const length = declaredLength ? parseInt(declaredLength, 10) : NaN;
	return Number.isSafeInteger(length) && length >= 0;
}
