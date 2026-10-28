import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { openRequestLifetime } from './request-lifetime.js';
import { server } from '../_init.js';
import { resolveRequestId } from '../utils/request-id.js';
import { randomUuid } from '../runtime.js';
import { collectImmediate } from './response-collect.js';
import { response400, response413, response500 } from './http-helpers.js';
import { requestTarget } from '../utils/request-target.js';
import { origin, address_header, xff_depth, bodyLimitFor, get_origin, trusted_proxies, warnUntrustedClaim, ws_options } from './config.js';
import { isDedupBufferable, declaresBodyPastCap } from './ssr-dedup.js';
import { requestPlatform } from './platform.js';
import { negotiateEncoding } from '../utils/static-negotiate.js';

/* global ENV_PREFIX */
/* global HTTP_OPTIONS */

// Maximum number of in-flight dedup keys tracked simultaneously.
const MAX_SSR_DEDUP = 500;

// Maximum response body size (bytes) that may be shared across waiters.
// Responses larger than this are not shared - each waiter makes its own call.
const MAX_SSR_DEDUP_BODY = 512 * 1024;

/**
 * @typedef {{ status: number, statusText: string, headers: [string, string][], body: Uint8Array }} SharedResponse
 */

// Only responses whose source has not reached EOF need consumption tracking.
const streamingResponses = new WeakSet();

/**
 * In-flight SSR dedup map. Key is "<METHOD>\0<origin>\0<url>".
 * Value is a Promise that resolves to a SharedResponse (shareable) or null (not shareable).
 * @type {Map<string, Promise<SharedResponse | null>>}
 */
const ssrInflight = new Map();

// Dynamic response compression: only compress text content types above a threshold.
// Static files use build-time precompression and are never affected by this.
const COMPRESS_MIN_SIZE = 1024;

// BREACH defense: dynamic compression of credentialed responses turns the
// response length into a side channel that leaks any secret reflected
// alongside attacker-influenced input (CSRF tokens, session IDs, API keys
// in the page body). Skip compression on every request that carries a
// `Cookie` or `Authorization` header. Apps that have audited their pages
// for BREACH defenses (random per-response masking, prefix randomization,
// no secrets reflected with attacker input) can opt back in via the
// `compressCredentialedResponses: true` adapter option.
const COMPRESS_CREDENTIALED = HTTP_OPTIONS?.compressCredentialedResponses === true;

const COMPRESSIBLE_TYPES = new Set([
	'text/html', 'text/css', 'text/plain', 'text/xml', 'text/javascript',
	'text/csv', 'text/markdown',
	'application/json', 'application/xml', 'application/javascript',
	'application/xhtml+xml', 'application/ld+json', 'application/manifest+json',
	'application/rss+xml', 'application/atom+xml',
	'image/svg+xml'
]);

/**
 * Render a request through SvelteKit and return the Response to hand back to
 * Bun.serve. Transmission is the server's job: Bun consumes the returned
 * Response's ReadableStream with its own backpressure and cancels via
 * `request.signal` when the client goes away. This module owns only decision
 * logic: origin resolution, client-address trust, SSR dedup, the BREACH-aware
 * compression gate, and the single-chunk compression fast path.
 *
 * @param {Request} request
 * @param {string} direct - direct socket peer address (decides header trust)
 * @returns {Promise<Response>}
 */
export async function handleSSR(request, direct) {
	const bodyLimit = request.body === null ? Infinity : bodyLimitFor(request.method, requestTarget(request));
	const lifetime = openRequestLifetime(request, bodyLimit);
	try {
		const response = await lifetime.guard(renderSSR(request, direct, lifetime));
		return lifetime.response(response, !streamingResponses.has(response));
	}
	catch (error) {
		if (lifetime.bodyLimitExceeded) return lifetime.response(response413(), true);
		lifetime.abort(error); lifetime.finish(); throw error;
	}
}

async function renderSSR(request, direct, lifetime) {
	try {
		let base_origin;
		let kitRequest;
		const url = requestTarget(request);
		const method = request.method;
		if (method !== 'GET' && method !== 'HEAD') {
			const declared = Number(request.headers.get('content-length'));
			if (declared > bodyLimitFor(method, url)) return response413();
		}
		try {
			base_origin = origin || get_origin(request.headers);
			const resolved = new URL(base_origin + url).href;
			kitRequest = lifetime.request(resolved);
		} catch {
			return response400();
		}

		// Branch at definition time on the module-level constant address_header.
		// In the common case (no proxy), the closure captures only the socket
		// address. A header claim from a peer outside TRUSTED_PROXIES is ignored,
		// not an error - the request is a direct client, and its socket address
		// IS its address.
		const getClientAddress = address_header
			? () => {
				if (trusted_proxies && !trusted_proxies.match(direct)) {
					warnUntrustedClaim(direct, `${address_header} header`);
					return direct;
				}
				const value = request.headers.get(address_header);
				if (value === null) {
					throw new Error(
						`Address header was specified with ${ENV_PREFIX + 'ADDRESS_HEADER'}=${address_header} but is absent from request`
					);
				}

				if (address_header === 'x-forwarded-for') {
					// Reject absurdly long XFF headers (max ~8KB)
					if (value.length > 8192) {
						throw new Error('X-Forwarded-For header too large');
					}
					const addresses = value.split(',');

					if (xff_depth > addresses.length) {
						throw new Error(
							`${ENV_PREFIX + 'XFF_DEPTH'} is ${xff_depth}, but only found ${addresses.length} addresses`
						);
					}
					return addresses[addresses.length - xff_depth].trim();
				}

				return value;
			}
			: () => direct;

		// Per-request platform. With the WebSocket half configured this is a
		// prototype-linked clone of the realtime platform carrying this
		// request's identity, so a load function or form action can
		// `platform.publish(...)` to connected clients - one object per
		// request, with every method still resolving to the shared singleton.
		//
		// Without it, the members that do not depend on a realtime tier, which
		// is what makes `platform.metrics` and `platform.metricsSnapshot()` true
		// of EVERY instance as documented rather than only of the ones that
		// serve WebSockets. An app whose only use for this adapter's
		// observability is a `/metrics` route needs no realtime tier to have
		// one, and the route that reached for it on such a build used to throw
		// `platform.metricsSnapshot is not a function`.
		const requestId = resolveRequestId(request.headers.get('x-request-id')) || randomUuid();
		const platform = requestPlatform(requestId);

		// Dedup: for anonymous GET requests that arrive concurrently for the
		// same URL, only the first (the leader) calls server.respond(). Subsequent
		// requests (waiters) await the leader's promise and reconstruct a Response
		// from the shared buffer. This prevents redundant SSR work during traffic
		// spikes on public pages.
		//
		// Dedup is skipped for:
		//   - Non-GET methods (HEAD must not collect a body; mutations must not be coalesced)
		//   - Authenticated requests (cookie or authorization header present)
		//   - When the dedup map is at capacity (safety valve)
		const isCredentialedRequest = !!(request.headers.get('cookie') || request.headers.get('authorization'));
		const canDedup =
			method === 'GET' &&
			!isCredentialedRequest &&
			ssrInflight.size < MAX_SSR_DEDUP;
		// BREACH defense: suppress the accept-encoding signal for credentialed
		// requests so finalizeResponse() leaves the body uncompressed. Apps that
		// have audited their reflected-input surface can opt back in via the
		// COMPRESS_CREDENTIALED module flag.
		const respAcceptEncoding = method === 'HEAD' || (isCredentialedRequest && !COMPRESS_CREDENTIALED)
			? ''
			: (request.headers.get('accept-encoding') || '');

		if (canDedup) {
			// Include base_origin so virtual-hosting deployments (one instance
			// behind multiple `Host` aliases) keep per-tenant dedup buckets -
			// SvelteKit consults `request.url`'s host when rendering, so the
			// response IS host-dependent.
			const dedupKey = method + '\0' + base_origin + '\0' + url;
			const existing = ssrInflight.get(dedupKey);

			if (existing) {
				// Waiter: await the leader's result
				const shared = await existing;
				if (shared) {
					// Fresh Response from the shared buffer (zero-copy view)
					return finalizeResponse(
						new Response(shared.body, {
							status: shared.status,
							statusText: shared.statusText,
							headers: shared.headers
						}),
						respAcceptEncoding, false, lifetime
					);
				}
				// Leader marked this non-shareable - fall through to our own call
			} else {
				// Leader: register the promise before any await so waiters attach to it
				let resolveShared;
				const sharedPromise = /** @type {Promise<SharedResponse | null>} */ (
					new Promise((r) => { resolveShared = r; })
				);
				ssrInflight.set(dedupKey, sharedPromise);
				// Always remove when settled, even on throw
				sharedPromise.finally(() => ssrInflight.delete(dedupKey));

				try {
					const response = await server.respond(kitRequest, { platform, getClientAddress });

					// Responses with Set-Cookie must not be shared (they're personalized).
					// Responses that declare Vary on anything other than Accept-Encoding
					// are personalized by some other request header (Accept-Language,
					// geo, feature flags, tenant, etc.) - sharing would serve the
					// leader's content to waiters that may legitimately differ.
					if (response.headers.has('set-cookie') || !response.body) {
						resolveShared(null);
						return finalizeResponse(response, respAcceptEncoding, false, lifetime);
					}
					const varyHeader = response.headers.get('vary');
					if (varyHeader) {
						const personalized = varyHeader.toLowerCase().split(',').some(
							(p) => { const t = p.trim(); return t !== '' && t !== 'accept-encoding'; }
						);
						if (personalized) {
							resolveShared(null);
							return finalizeResponse(response, respAcceptEncoding, false, lifetime);
						}
					}

					// A never-ending SSE stream (see isDedupBufferable) must not be
					// buffered: collecting it would await forever, parking this
					// leader and every concurrent waiter on the same promise.
					if (!isDedupBufferable(response) || declaresBodyPastCap(response, MAX_SSR_DEDUP_BODY)) {
						resolveShared(null);
						return finalizeResponse(response, respAcceptEncoding, false, lifetime);
					}

					// Sharing requires the whole body, so only a body that is
					// already complete can be shared. A streaming render is
					// served straight through instead - waiting for it would
					// withhold its shell from this client and park every waiter
					// behind work that is deliberately incremental.
					const collected = await collectImmediate(
						/** @type {ReadableStream<Uint8Array>} */ (response.body), lifetime, MAX_SSR_DEDUP_BODY
					);
					if (!collected.complete) {
						resolveShared(null);
						return streamedResponse(response, collected.stream);
					}

					// A disconnected leader cannot share a body truncated by cancellation.
					const shared = !lifetime.signal.aborted && collected.bytes.byteLength <= MAX_SSR_DEDUP_BODY
						? /** @type {SharedResponse} */ ({
							status: response.status,
							statusText: response.statusText,
							headers: /** @type {[string, string][]} */ ([...response.headers]),
							body: collected.bytes
						})
						: null;

					resolveShared(shared);

					// Serve the leader's own response from the same bytes
					return bufferedResponse(response, collected.bytes, respAcceptEncoding);
				} catch (err) {
					resolveShared(null);
					throw err;
				}
			}
		}

		// Normal (non-dedup) path
		const response = await server.respond(kitRequest, { platform, getClientAddress });
		return finalizeResponse(response, respAcceptEncoding, method === 'HEAD', lifetime);
	} catch (err) {
		if (lifetime.bodyLimitExceeded) return response413();
		lifetime.abort(err);
		console.error('SSR error:', err);
		return response500();
	}
}

/**
 * Copy a Response's headers, injecting a default
 * `x-content-type-options: nosniff` if the response did not already set
 * one - the header is safe in every legitimate scenario (it tells the
 * browser not to MIME-sniff away the server's declared content-type)
 * and closes a known MIME-confusion vector for any future SSR response
 * whose author forgets to set the header explicitly. Apps that want to
 * override can just include their own header on the Response - the
 * default-fill only fires when the response is silent on the matter.
 *
 * Other header defaults (Referrer-Policy, X-Frame-Options, CSP) are
 * intentionally NOT defaulted here. CSP needs app-specific care for
 * inline-hydration / iframe shapes; X-Frame-Options breaks legitimate
 * embeds; Referrer-Policy choices vary by app. Those are app-level
 * decisions and the right tier is `hooks.server.js`.
 *
 * @param {Response} response
 * @returns {Headers}
 */
function headersWithNosniff(response) {
	const headers = new Headers(response.headers);
	headers.delete('date');
	headers.delete('transfer-encoding');
	if (!headers.has('x-content-type-options')) {
		headers.set('x-content-type-options', 'nosniff');
	}
	return headers;
}

/**
 * Shape a Response whose bytes are fully in hand: nosniff default-fill plus
 * the compression pass. Compression happens here and only here - it needs the
 * whole body, which is exactly what distinguishes this path from the streamed
 * one.
 *
 * @param {Response} response - the original, for status and headers
 * @param {Uint8Array} bytes - the complete body
 * @param {string} acceptEncoding - '' suppresses compression (BREACH gate)
 * @returns {Response}
 */
function bufferedResponse(response, bytes, acceptEncoding) {
	let body = bytes;
	let encoding = '';
	if (acceptEncoding && body.byteLength >= COMPRESS_MIN_SIZE &&
		!response.headers.has('content-encoding')) {
		const ctRaw = response.headers.get('content-type') || '';
		const semi = ctRaw.indexOf(';');
		const ct = semi === -1 ? ctRaw : ctRaw.slice(0, semi).trimEnd();
		if (COMPRESSIBLE_TYPES.has(ct)) {
			const selected = negotiateEncoding(acceptEncoding, true, true);
			if (selected) {
				const compressed = selected === 'br'
					? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
					: gzipSync(body, { level: 6 });
				if (compressed.byteLength < body.byteLength) {
					body = compressed;
					encoding = selected;
				}
			}
		}
	}
	const headers = headersWithNosniff(response);
	// A stale declared length would truncate or pad the (possibly compressed)
	// body - the server recomputes it from the actual bytes.
	headers.delete('content-length');
	if (encoding) {
		headers.set('content-encoding', encoding);
		headers.append('vary', 'Accept-Encoding');
	}
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

/**
 * Shape a Response that is still producing. Never compressed: the body length
 * is unknown, and chunk timing is often semantic (an event stream, a deferred
 * render). Bun applies its own backpressure to the stream.
 *
 * @param {Response} response - the original, for status and headers
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Response}
 */
function streamedResponse(response, stream, headOnly = false) {
	const headers = headersWithNosniff(response);
	if (!headOnly) headers.delete('content-length');
	const streamed = new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
	streamingResponses.add(streamed);
	return streamed;
}

/**
 * Final response shaping before handing the Response to Bun.serve, for the
 * paths that did not already collect the body themselves (the dedup leader
 * does, so it calls bufferedResponse / streamedResponse directly).
 *
 * @param {Response} response
 * @param {string} acceptEncoding - '' suppresses compression (BREACH gate)
 * @param {boolean} [headOnly] - preserve metadata without reading the body
 * @returns {Promise<Response>}
 */
async function finalizeResponse(response, acceptEncoding, headOnly = false, lifetime) {
	if (!response.body) {
		if (response.headers.has('x-content-type-options') && !response.headers.has('transfer-encoding') && !response.headers.has('date')) return response;
		return new Response(null, {
			status: response.status,
			statusText: response.statusText,
			headers: headersWithNosniff(response)
		});
	}

	if (response.body.locked) {
		return new Response(
			'Fatal error: Response body is locked. ' +
				"This can happen when the response was already read (for example through 'response.json()' or 'response.text()').",
			{ status: 500, headers: { 'content-type': 'text/plain' } }
		);
	}

	// HEAD preserves declared headers and lets the lifetime wrapper cancel the
	// body. Even an immediately available body must not be read or compressed.
	if (headOnly) return streamedResponse(response, response.body, true);

	// A never-ending stream (text/event-stream) bypasses collection and
	// compression. The request lifetime wrapper forwards cancellation to it.
	if (!isDedupBufferable(response)) {
		return streamedResponse(response, response.body);
	}

	const collected = await collectImmediate(response.body, lifetime, Infinity, 2);
	return collected.complete
		? bufferedResponse(response, collected.bytes, acceptEncoding)
		: streamedResponse(response, collected.stream);
}
