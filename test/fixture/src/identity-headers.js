export const digestCredential = 'Digest username="fixture", realm="room"';

export function identityResponseHeaders(headers) {
	const result = { 'x-hook-routed': '1' };
	for (const name of ['origin', 'content-type', 'authorization', 'proxy-authorization']) {
		const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
		if (value !== null && value !== undefined) result['x-observed-' + name] = value;
	}
	return result;
}
