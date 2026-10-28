/**
 * Field names scoped to one transport connection by a Fetch Response.
 * Names are case-insensitive even though Headers yields lower-case names.
 *
 * @param {Headers} headers
 * @returns {Set<string> | null}
 */
export function responseConnectionHeaders(headers) {
	const connection = headers.get('connection');
	return connection ? new Set(connection.toLowerCase().split(',').map(name => name.trim())) : null;
}

/**
 * Connection-specific fields cannot be relayed onto a different connection.
 * The response writer supplies its own framing and connection policy.
 *
 * @param {string} name lower-case header name
 * @param {Set<string> | null} nominated
 */
export function isResponseHopHeader(name, nominated) {
	switch (name) {
		case 'connection':
		case 'keep-alive':
		case 'proxy-connection':
		case 'transfer-encoding':
		case 'upgrade':
		case 'http2-settings':
		case 'te':
		case 'trailer':
			return true;
		default:
			return nominated?.has(name) ?? false;
	}
}

/**
 * A declared representation length can be used for HEAD/304 only when it
 * is an end-to-end field, rather than one nominated by Connection.
 *
 * @param {Headers} headers
 * @returns {string | null}
 */
export function responseContentLength(headers) {
	const length = headers.get('content-length');
	return length !== null && responseConnectionHeaders(headers)?.has('content-length') ? null : length;
}

/**
 * Fetch Headers values contain one code unit per byte. uWS encodes strings
 * as UTF-8, so values outside ASCII must be passed as bytes instead.
 * Application cookie serializer output is text and does not use this path.
 *
 * @param {string} value
 * @returns {string | Buffer}
 */
export function responseHeaderBytes(value) {
	return /[^\x00-\x7f]/.test(value) ? Buffer.from(value, 'latin1') : value;
}
