import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { server } from '../_init.js';
import { resolveRequestId } from '../utils/request-id.js';
import { clearTimer, randomUuid, setTimer } from '../runtime.js';
import { response413, response500 } from './http-helpers.js';
import { origin, address_header, xff_depth, body_size_limit, get_origin, trusted_proxies, warnUntrustedClaim, ws_options } from './config.js';
import { isDedupBufferable } from './ssr-dedup.js';
import { platform as realtimePlatform } from './platform.js';

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

/**
 * Sentinel for "the next chunk did not arrive in this event-loop turn", which
 * is how a streaming body is told apart from a complete one (see
 * collectImmediate). A symbol so it can never collide with a read result.
 */
const STILL_STREAMING = Symbol('still-streaming');

// Ceiling on what collectImmediate will hold in memory before it gives up and
// streams instead. Guards against a route that produces chunks without ever
// yielding: without it, "complete in this turn" could mean an unbounded buffer.
const COLLECT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read a body for as long as it keeps producing WITHOUT waiting on the
 * macrotask queue, and report whether it finished.
 *
 * This is the one probe that decides both of the things the SSR path does with
 * a body: whether it can be deduplicated (shared with concurrent waiters) and
 * whether it can be compressed whole. Both require the complete bytes, and
 * both are wrong to wait for: an already-rendered body settles its reads in
 * the same turn, while a genuinely streaming one (SvelteKit deferred data, a
 * route that emits a shell then awaits) does not - and blocking on it would
 * withhold the status line, the headers, and the shell until the deferred work
 * finishes, defeating the point of streaming.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {Promise<{ complete: true, bytes: Uint8Array }
 *   | { complete: false, stream: ReadableStream<Uint8Array> }>}
 */
async function collectImmediate(body) {
	const reader = body.getReader();
	/** @type {Uint8Array[]} */
	const chunks = [];
	let total = 0;

	// ONE deadline for the whole body, not one per chunk: the question is
	// whether the body finishes before the event loop yields, so a body that
	// arrives in several already-available chunks still counts as complete,
	// and a response costs a single timer rather than one per read.
	/** @type {ReturnType<typeof setTimeout>} */
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimer(() => resolve(STILL_STREAMING), 0);
	});

	try {
		for (;;) {
			const pending = reader.read();
			const result = await Promise.race([pending, deadline]);

			if (result === STILL_STREAMING) {
				// The read is still in flight and is handed to the stream below,
				// which awaits it on first pull. Attach a handler now so a
				// rejection arriving before the consumer ever pulls is not
				// reported as an unhandled rejection; pull() still observes it.
				pending.catch(() => {});
				return { complete: false, stream: resumeStream(reader, chunks, pending) };
			}
			if (result.done) {
				return { complete: true, bytes: concatChunks(chunks, total) };
			}

			chunks.push(result.value);
			total += result.value.byteLength;
			if (total > COLLECT_MAX_BYTES) {
				return { complete: false, stream: resumeStream(reader, chunks, null) };
			}
		}
	} finally {
		clearTimer(timer);
	}
}

/**
 * Rebuild a stream from the chunks already consumed plus the remainder. Bun
 * applies its own backpressure to the result; cancellation propagates to the
 * app's reader.
 *
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {Uint8Array[]} chunks - already read, replayed first
 * @param {Promise<ReadableStreamReadResult<Uint8Array>> | null} carried - a
 *   read already in flight, consumed before pulling further
 * @returns {ReadableStream<Uint8Array>}
 */
function resumeStream(reader, chunks, carried) {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
		},
		async pull(controller) {
			const result = carried ? await carried : await reader.read();
			carried = null;
			if (result.done) controller.close();
			else controller.enqueue(result.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

/**
 * @param {Uint8Array[]} chunks
 * @param {number} total
 * @returns {Uint8Array}
 */
function concatChunks(chunks, total) {
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

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
	try {
		const base_origin = origin || get_origin(request.headers);
		const reqUrl = new URL(request.url);
		const url = reqUrl.pathname + reqUrl.search;
		const method = request.method;

		// Early 413 on a declared oversize body. Bodies without a Content-Length
		// (chunked) are capped by Bun.serve's maxRequestBodySize, wired from the
		// same BODY_SIZE_LIMIT in server.js.
		if (method !== 'GET' && method !== 'HEAD') {
			const cl = parseInt(request.headers.get('content-length') || '', 10);
			if (!isNaN(cl) && body_size_limit > 0 && Number.isFinite(body_size_limit) && cl > body_size_limit) {
				return response413();
			}
		}

		// Bun derives request.url from the Host header with the transport scheme,
		// which matches the zero-config origin. Rebuild the Request only when
		// ORIGIN / PROTOCOL_HEADER / HOST_HEADER / PORT_HEADER produce something
		// else - the copy constructor preserves method, headers, and body stream.
		const kitRequest = base_origin === reqUrl.origin
			? request
			: new Request(base_origin + url, request);

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
		// Without it, the request identity alone.
		const requestId = resolveRequestId(request.headers.get('x-request-id')) || randomUuid();
		const platform = ws_options
			? Object.assign(Object.create(realtimePlatform), { requestId })
			: { requestId };

		// Dedup: for anonymous GET/HEAD requests that arrive concurrently for the
		// same URL, only the first (the leader) calls server.respond(). Subsequent
		// requests (waiters) await the leader's promise and reconstruct a Response
		// from the shared buffer. This prevents redundant SSR work during traffic
		// spikes on public pages.
		//
		// Dedup is skipped for:
		//   - Non-GET/HEAD methods (mutations must not be coalesced)
		//   - Authenticated requests (cookie or authorization header present)
		//   - When the dedup map is at capacity (safety valve)
		const isCredentialedRequest = !!(request.headers.get('cookie') || request.headers.get('authorization'));
		const canDedup =
			(method === 'GET' || method === 'HEAD') &&
			!isCredentialedRequest &&
			ssrInflight.size < MAX_SSR_DEDUP;
		// BREACH defense: suppress the accept-encoding signal for credentialed
		// requests so finalizeResponse() leaves the body uncompressed. Apps that
		// have audited their reflected-input surface can opt back in via the
		// COMPRESS_CREDENTIALED module flag.
		const respAcceptEncoding = (isCredentialedRequest && !COMPRESS_CREDENTIALED)
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
						respAcceptEncoding
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
						return finalizeResponse(response, respAcceptEncoding);
					}
					const varyHeader = response.headers.get('vary');
					if (varyHeader) {
						const personalized = varyHeader.toLowerCase().split(',').some(
							(p) => { const t = p.trim(); return t !== '' && t !== 'accept-encoding'; }
						);
						if (personalized) {
							resolveShared(null);
							return finalizeResponse(response, respAcceptEncoding);
						}
					}

					// A never-ending SSE stream (see isDedupBufferable) must not be
					// buffered: collecting it would await forever, parking this
					// leader and every concurrent waiter on the same promise.
					if (!isDedupBufferable(response)) {
						resolveShared(null);
						return finalizeResponse(response, respAcceptEncoding);
					}

					// Sharing requires the whole body, so only a body that is
					// already complete can be shared. A streaming render is
					// served straight through instead - waiting for it would
					// withhold its shell from this client and park every waiter
					// behind work that is deliberately incremental.
					const collected = await collectImmediate(
						/** @type {ReadableStream<Uint8Array>} */ (response.body)
					);
					if (!collected.complete) {
						resolveShared(null);
						return streamedResponse(response, collected.stream);
					}

					// Responses above the size cap are served but not shared.
					const shared = collected.bytes.byteLength <= MAX_SSR_DEDUP_BODY
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
		return finalizeResponse(response, respAcceptEncoding);
	} catch (err) {
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
			const useBr = acceptEncoding.includes('br');
			const useGz = !useBr && acceptEncoding.includes('gzip');
			if (useBr || useGz) {
				const compressed = useBr
					? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
					: gzipSync(body, { level: 6 });
				if (compressed.byteLength < body.byteLength) {
					body = compressed;
					encoding = useBr ? 'br' : 'gzip';
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
function streamedResponse(response, stream) {
	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers: headersWithNosniff(response)
	});
}

/**
 * Final response shaping before handing the Response to Bun.serve, for the
 * paths that did not already collect the body themselves (the dedup leader
 * does, so it calls bufferedResponse / streamedResponse directly).
 *
 * @param {Response} response
 * @param {string} acceptEncoding - '' suppresses compression (BREACH gate)
 * @returns {Promise<Response>}
 */
async function finalizeResponse(response, acceptEncoding) {
	if (!response.body) {
		if (response.headers.has('x-content-type-options')) return response;
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

	// A never-ending stream (text/event-stream) passes through untouched, so
	// the app's own stream reaches Bun directly and cancellation reaches the
	// route. Collecting it would never terminate, and compression never
	// applies to it anyway.
	if (!isDedupBufferable(response)) {
		return streamedResponse(response, response.body);
	}

	const collected = await collectImmediate(response.body);
	return collected.complete
		? bufferedResponse(response, collected.bytes, acceptEncoding)
		: streamedResponse(response, collected.stream);
}
