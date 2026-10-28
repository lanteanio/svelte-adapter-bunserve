import { invalidHost } from './request-target.js';

export class OriginHeaderError extends Error {
	constructor(header, expected) {
		super(`The ${header} header must carry ${expected}.`);
		this.name = 'OriginHeaderError';
		this.header = header;
	}
}

/** Build an origin from trusted proxy headers or the listener and Host. */
export function originFromHeaders(headers, source) {
	let protocol = source.isTls ? 'https' : 'http';
	if (source.protocolHeader && headers.get(source.protocolHeader)) {
		try {
			protocol = decodeURIComponent(headers.get(source.protocolHeader));
		} catch {
			throw new OriginHeaderError(source.protocolHeader, "'http' or 'https'");
		}
	}
	if (protocol !== 'http' && protocol !== 'https') {
		throw new OriginHeaderError(source.protocolHeader, "'http' or 'https'");
	}
	const hostName = source.hostHeader && headers.get(source.hostHeader) ? source.hostHeader : 'host';
	const host = headers.get(hostName);
	if (!host || invalidHost(host)) throw new OriginHeaderError(hostName, 'a host and an optional port');
	const port = source.portHeader ? headers.get(source.portHeader) : null;
	if (!port) return `${protocol}://${host}`;
	if (!/^[0-9]+$/.test(port)) throw new OriginHeaderError(source.portHeader, 'a port number');
	return `${protocol}://${host.replace(/:[0-9]*$/, '')}:${port}`;
}

/** Name the proxy setting, without logging the request's header value. */
export function refusedHeaderSetting(header, source, prefix) {
	if (header === 'host') return null;
	if (header === source.protocolHeader) return prefix + 'PROTOCOL_HEADER';
	if (header === source.hostHeader) return prefix + 'HOST_HEADER';
	if (header === source.portHeader) return prefix + 'PORT_HEADER';
	return null;
}
