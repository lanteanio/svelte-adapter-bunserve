import { env } from '../env.js';
import { parse_as_bytes, parse_idle_timeout, parse_origin } from '../utils/parse.js';
import { createTrustedProxyMatcher } from '../utils/trusted-proxies.js';

/* global WS_OPTIONS */
/* global WS_PATH */

/**
 * The `websocket` adapter options, validated and defaulted at build time by
 * normalizeWsOptions (utils/ws-options.js) and frozen into the bundle here.
 * `null` when the build found no WebSocket handler, which is what leaves the
 * whole WS surface out of the served options.
 * @type {Record<string, any> | null}
 */
export const ws_options = WS_OPTIONS;

/** The path the WebSocket endpoint answers on. */
export const ws_path = WS_PATH;

/** True when a compressor is configured, so publish/send can deflate by default. */
export const ws_compression_on = Boolean(ws_options && ws_options.compression);

/**
 * Allow topic names outside printable ASCII on the wire accept path. Off by
 * default: the invisible and bidi-control code points survive the wire and then
 * surprise whatever renders a topic back to a human.
 */
export const allow_non_ascii_topics = ws_options?.allowNonAsciiTopics === true;

/**
 * Allow clients to subscribe directly to the adapter's own `__`-prefixed
 * namespace. Off by default - those channels carry traffic the server never
 * meant to hand to an arbitrary client.
 */
export const allow_system_topic_subscribe = ws_options?.allowSystemTopicSubscribe === true;

/**
 * Allow clients to subscribe when the app exports no `subscribe` hook.
 *
 * Off by default, which is a deliberate departure from arriving at "any client
 * may read any topic" by omission. A realtime app typically publishes on
 * per-entity topics (`user:<id>`, `order:<uuid>`), and without a gate anyone
 * who can open a socket can name those topics and receive them - no session, no
 * cookie, nothing to detect. Export a `subscribe` hook, or set this to true to
 * state that every topic really is public.
 */
export const allow_unauthenticated_subscribe = ws_options?.allowUnauthenticatedSubscribe === true;

export const ssl_cert = env('SSL_CERT', '');

export const ssl_key = env('SSL_KEY', '');

export const is_tls = !!(ssl_cert && ssl_key);

export const origin = parse_origin(env('ORIGIN', undefined));

export const xff_depth = parseInt(env('XFF_DEPTH', '1'), 10);

export const address_header = env('ADDRESS_HEADER', '').toLowerCase();

export const protocol_header = env('PROTOCOL_HEADER', '').toLowerCase();

export const host_header = env('HOST_HEADER', '').toLowerCase();

export const port_header = env('PORT_HEADER', '').toLowerCase();

export const body_size_limit = parse_as_bytes(env('BODY_SIZE_LIMIT', '512K'));

/**
 * Seconds a connection may go idle before Bun closes it.
 *
 * Bun's own default is about 10 seconds, and a RESPONSE that goes quiet counts
 * as idle: measured, an unset timeout cuts a stream that pauses for 12s while
 * delivering one that pauses for 2s (probe/bun-api-facts.report.md,
 * http-idle-timeout). That default is wrong for this adapter's traffic - an SSE
 * endpoint with a heartbeat slower than 10s would be severed mid-stream with no
 * error the app can see - so the adapter owns the value rather than inheriting
 * it. 120s clears every ordinary heartbeat interval while still bounding how
 * long a connection that has gone silent can hold a socket. Set 0 to disable it
 * (also measured), at the cost of that bound.
 */
export const idle_timeout = parse_idle_timeout(env('IDLE_TIMEOUT', '120'));

/**
 * Trusted-proxy allowlist (comma-separated IPs / CIDR ranges, IPv4 + IPv6).
 * When set, ADDRESS_HEADER is honored ONLY when the direct socket peer is in
 * this set; a claim from any other peer is ignored (the socket address is
 * used) with a one-shot warning. Unset keeps the trust-verbatim behavior.
 */
export const trusted_proxies = createTrustedProxyMatcher(env('TRUSTED_PROXIES', ''));

let warnedUntrustedClaim = false;
/**
 * One-shot warning for an address claim arriving from an untrusted peer.
 * @param {string} directIp
 * @param {string} kind
 */
export function warnUntrustedClaim(directIp, kind) {
	if (warnedUntrustedClaim) return;
	warnedUntrustedClaim = true;
	console.warn(
		`[adapter] Ignored a ${kind} client-address claim from untrusted peer ${directIp}: ` +
		'the peer is not in TRUSTED_PROXIES, so the socket address was used instead. ' +
		'If this peer is a legitimate proxy, add its address (or CIDR range) to TRUSTED_PROXIES.'
	);
}

/**
 * Construct the origin from request headers.
 *
 * WARNING: PROTOCOL_HEADER / HOST_HEADER / PORT_HEADER are trusted as-is.
 * Only use these behind a trusted reverse proxy that overwrites the headers.
 * Never expose them when the adapter is directly internet-facing.
 *
 * @param {Headers} headers
 * @returns {string}
 */
export function get_origin(headers) {
	// Default protocol matches the server type: 'https' when TLS is configured.
	const default_protocol = is_tls ? 'https' : 'http';
	const protocol = protocol_header
		? decodeURIComponent(headers.get(protocol_header) || default_protocol)
		: default_protocol;

	if (protocol !== 'http' && protocol !== 'https') {
		throw new Error(
			`The ${protocol_header} header specified '${protocol}' which is not a valid protocol. Only 'http' and 'https' are supported.`
		);
	}

	const host = (host_header && headers.get(host_header)) || headers.get('host');
	if (!host) {
		throw new Error('Could not determine host. The request must have a host header.');
	}

	const port = port_header ? headers.get(port_header) : undefined;
	if (port && isNaN(+port)) {
		throw new Error(
			`The ${port_header} header specified ${port} which is an invalid port.`
		);
	}

	// Strip existing port from host before appending PORT_HEADER value
	// (the Host header often includes the port, e.g. "example.com:3000")
	const hostWithoutPort = port ? host.replace(/:\d+$/, '') : host;

	return port ? `${protocol}://${hostWithoutPort}:${port}` : `${protocol}://${host}`;
}
