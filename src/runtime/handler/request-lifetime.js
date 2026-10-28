import { httpMetrics } from '../utils/http-transport-metrics.js';
import { counters, requestSignals } from './state.js';
import { requestDone } from './lifecycle.js';
import { responseChunkBytes } from './response-body.js';
import { response413 } from './http-helpers.js';
import { setTimer, clearTimer } from '../runtime.js';

// As on the lead transport, a full application queue pauses input for at most
// ten seconds before one native read checks bytes waiting behind that queue.
const BODY_PAUSE_LIMIT_MS = 10000;

/** Own the application signal and drain registration through response completion. */
export function openRequestLifetime(nativeRequest, bodyLimit = Infinity) {
	const controller = new AbortController();
	requestSignals.add(controller);
	counters.inFlightCount++;
	let finished = false;
	let bodyReceived = false;
	let receivedBytes = 0;
	let bodyLimitError;
	let failResponse;
	let rejectBodyLimit;
	const bodyLimitFailure = nativeRequest.body !== null && Number.isFinite(bodyLimit)
		? new Promise((_, reject) => { rejectBodyLimit = reject; }) : null;
	bodyLimitFailure?.catch(() => {});
	let bodyReader;
	let responseReader;
	let cancelResponse;
	let failBody;
	let pauseTimer = null;
	const clearPause = () => {
		if (pauseTimer !== null) { clearTimer(pauseTimer); pauseTimer = null; }
	};
	const disconnect = () => {
		if (finished) return;
		if (!bodyReceived) {
			controller.abort();
			failBody?.();
		}
		if (cancelResponse) cancelResponse();
		if (responseReader) {
			const reader = responseReader;
			responseReader = null;
			reader.cancel().catch(() => {});
			reader.releaseLock();
			finish('aborted');
		}
	};
	nativeRequest.signal.addEventListener('abort', disconnect, { once: true });
	if (nativeRequest.signal.aborted) disconnect();
	function finish(outcome) {
		if (finished) return;
		finished = true;
		clearPause();
		httpMetrics.finish(nativeRequest, outcome);
		nativeRequest.signal.removeEventListener('abort', disconnect);
		requestSignals.delete(controller);
		requestDone();
		bodyReader?.cancel().catch(() => {});
	}
	return {
		signal: controller.signal,
		get bodyLimitExceeded() { return bodyLimitError !== undefined; },
		guard(work) {
			if (!bodyLimitFailure) return work;
			const observed = Promise.resolve(work).then(value => {
				if (bodyLimitError && value instanceof Response) value.body?.cancel().catch(() => {});
				return value;
			});
			return Promise.race([observed, bodyLimitFailure]);
		},
		abort: reason => controller.abort(reason),
		finish,
		ownResponse(cancel) {
			cancelResponse = cancel;
			if (finished || nativeRequest.signal.aborted || bodyLimitError) cancel(bodyLimitError);
			return () => { if (cancelResponse === cancel) cancelResponse = null; };
		},
		request(url) {
			let body;
			if (nativeRequest.body !== null) {
				let reading = false;
				let cancelled = false;
				let bodyError;
				const source = {
					start(out) {
						failBody = (error = new Error('Request aborted')) => {
							bodyError ??= error;
							clearPause();
							// Defer an unread body's error until a consumer acquires it.
							// Bun's buffer methods throw synchronously on an already errored stream.
							if (body?.locked) { try { out.error(bodyError); } catch { /* settled */ } }
							bodyReader?.cancel().catch(() => {});
						};
						if (controller.signal.aborted) failBody();
					},
					async pull(out, poll = false) {
						clearPause();
						if (reading || cancelled || finished) return;
						if (bodyError) { await Promise.resolve(); if (body.locked) out.error(bodyError); return; }
						reading = true;
						if (!bodyReader) {
							bodyReader = nativeRequest.body.getReader();
							bodyReader.closed.then(() => { if (!cancelled && !finished && !bodyError) bodyReceived = true; }, error => {
								if (cancelled || finished) return;
								controller.abort(error);
								failBody(error);
							});
						}
						try {
							// Keep a bounded arrival window while preserving application backpressure.
							while (!cancelled && !finished && (poll || out.desiredSize > 0)) {
								poll = false;
								const chunk = await bodyReader.read();
								if (cancelled || finished) return;
								if (bodyError) { await Promise.resolve(); if (body.locked) out.error(bodyError); return; }
								if (chunk.done) { bodyReceived = true; out.close(); return; }
								if (chunk.value.byteLength > bodyLimit - receivedBytes) {
								bodyLimitError = new Error('Request body exceeds its byte limit');
								bodyLimitError.name = 'RequestBodyLimitError';
								rejectBodyLimit?.(bodyLimitError);
								controller.abort(bodyLimitError);
								failBody(bodyLimitError);
								cancelResponse?.(bodyLimitError);
								failResponse?.(bodyLimitError);
								return;
							}
							receivedBytes += chunk.value.byteLength;
							out.enqueue(chunk.value);
							}
						} catch (error) {
							if (cancelled || finished) return;
							if (nativeRequest.signal.aborted) {
								disconnect();
								failBody();
							} else {
								controller.abort(error);
								failBody(error);
							}
						} finally {
							reading = false;
							if (!cancelled && !finished && !bodyError && !bodyReceived && Number.isFinite(bodyLimit) && out.desiredSize <= 0) {
								pauseTimer = setTimer(() => {
									pauseTimer = null;
									void source.pull(out, true).catch(error => { controller.abort(error); failBody(error); });
								}, BODY_PAUSE_LIMIT_MS);
								pauseTimer?.unref?.();
							}
						}
					},
					cancel(reason) { cancelled = true; clearPause(); return bodyReader?.cancel(reason); }
				};
				body = new ReadableStream(source, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
			}
			return new Request(url, {
				method: nativeRequest.method, headers: nativeRequest.headers,
				body, signal: controller.signal, duplex: 'half'
			});
		},
		response(response, complete = false) {
			if (bodyLimitError) {
				response.body?.cancel().catch(() => {});
				response = response413();
				complete = true;
			}
			// Do not reuse a connection whose upload was refused or answered early.
			if ((nativeRequest.body !== null && !bodyReceived) || bodyLimitError) {
				const headers = new Headers(response.headers);
				headers.set('connection', 'close');
				response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
			}
			// Completed GET bodies retain their native metadata.
			if (complete) { finish(); return response; }
			if (!response.body) { finish(); return response; }
			if (nativeRequest.method === 'HEAD') {
				finish();
				response.body?.cancel().catch(() => {});
				// Bun preserves a declared HEAD length on a null body. For an unknown
				// length, a lazy empty stream prevents an inferred zero without reading
				// the application body; Bun cancels it when sending HEAD headers.
				const empty = response.headers.has('content-length')
					? null : new ReadableStream({ pull(out) { out.close(); } }, { highWaterMark: 0 });
				return new Response(empty, { status: response.status, statusText: response.statusText, headers: response.headers });
			}
			if (nativeRequest.signal.aborted) {
				finish();
				response.body?.cancel().catch(() => {});
				return new Response(null, { status: response.status, headers: response.headers });
			}
			httpMetrics.streaming(nativeRequest, response.status);
			const reader = responseReader = response.body.getReader();
			const release = () => {
				if (responseReader === reader) { responseReader = null; reader.releaseLock(); }
			};
			const body = new ReadableStream({
				start(out) {
					failResponse = error => {
						reader.cancel(error).catch(() => {});
						release();
						finish('aborted');
						out.error(error);
					};
				},
				async pull(out) {
					try {
						const chunk = await reader.read();
						if (finished) {
							try { out.close(); } catch { /* already cancelled */ }
							return;
						}
						if (chunk.done) { release(); finish(); out.close(); }
						else out.enqueue(responseChunkBytes(chunk.value));
					} catch (error) {
						if (finished) { try { out.close(); } catch { /* already cancelled */ } return; }
						reader.cancel(error).catch(() => {});
						release();
						controller.abort(error);
						finish('aborted');
						out.error(error);
					}
				},
				cancel(reason) {
					disconnect();
					finish('aborted');
					release();
				}
			});
			return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
		}
	};
}
