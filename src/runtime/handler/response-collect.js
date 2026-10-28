import { responseChunkBytes } from './response-body.js';
import { readReady } from './response-read.js';
import { setImmediateTimer } from '../runtime.js';

/** Collect a finite ready body, yielding its exact pending read on I/O or the byte cap. */
export async function collectImmediate(body, lifetime, cap = 8 * 1024 * 1024, maxChunks = Infinity) {
	const reader = body.getReader();
	const chunks = [];
	let total = 0;
	let pending;
	let released = false;
	const release = () => { if (!released) { released = true; reader.releaseLock(); } };
	const cancel = reason => { reader.cancel(reason).catch(() => {}); release(); };
	const detach = lifetime?.ownResponse(cancel);
	const allowance = { spent: false };
	try {
		if (released) return { complete: true, bytes: new Uint8Array(0) };
		for (;;) {
			const next = chunks.length ? await readReady(reader, allowance) : await reader.read();
			if (released) return { complete: true, bytes: new Uint8Array(0) };
			if (next.pending) { pending = next.pending; break; }
			if (next.done) {
				release();
				if (chunks.length === 1) return { complete: true, bytes: chunks[0] };
				const bytes = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
				return { complete: true, bytes };
			}
			const bytes = responseChunkBytes(next.value);
			chunks.push(bytes);
			total += bytes.byteLength;
			if (total > cap || chunks.length >= maxChunks) break;
		}
	} catch (error) {
		if (released) return { complete: true, bytes: new Uint8Array(0) };
		cancel(error);
		throw error;
	} finally { detach?.(); }
	let replay = 0;
	const stream = new ReadableStream({
		async pull(controller) {
			if (replay < chunks.length) {
				// Let Bun commit the streamed prefix before another ready chunk.
				if (maxChunks === 2 && replay === 1) await new Promise(resolve => setImmediateTimer(resolve));
				if (released) return;
				const chunk = chunks[replay];
				chunks[replay++] = null;
				controller.enqueue(chunk);
				return;
			}
			try {
				const next = pending || reader.read();
				pending = null;
				const { done, value } = await next;
				if (released) return;
				if (done) { release(); controller.close(); }
				else controller.enqueue(responseChunkBytes(value));
			} catch (error) {
				if (released) return;
				cancel(error);
				throw error;
			}
		},
		cancel(reason) { chunks.length = 0; if (!released) cancel(reason); }
	});
	return { complete: false, stream };
}
