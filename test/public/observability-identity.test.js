import { afterEach, expect, it, vi } from 'vitest';
import { createDiagnostic, formatDiagnostic, parseDiagnostic, emitOperationalEvent, setOperationalEventSink } from '../../src/observability.js';
import { adapterErrorDefinition, ADAPTER_ERROR_IDS } from '../../src/runtime/error-registry.js';

afterEach(() => { setOperationalEventSink(null); vi.restoreAllMocks(); });
it('uses this package identity in diagnostic fallback and registry messages', () => {
 const records = [];
 vi.spyOn(console, 'error').mockImplementation(line => records.push(String(line)));
 vi.spyOn(console, 'warn').mockImplementation(line => records.push(String(line)));
 const input = { source: 'svelte-adapter-bunserve', component: 'runtime.testing', event: 'testing.identity', severity: 'warn', message: 'Test event', attributes: {} };
 const record = createDiagnostic(input);
 expect(parseDiagnostic(formatDiagnostic(record)).record.source).toBe('svelte-adapter-bunserve');
 setOperationalEventSink(() => { throw new Error('sink failed'); });
 emitOperationalEvent(input);
 expect(records.some(line => line.includes('source=svelte-adapter-bunserve') && line.includes('event=operational.sink.failed'))).toBe(true);
 expect(adapterErrorDefinition(ADAPTER_ERROR_IDS.LISTEN).messagePrefix).toContain('source=svelte-adapter-bunserve');
});
it('parses this package legacy prefixes while preserving family aliases', () => {
 expect(parseDiagnostic('[svelte-adapter-bunserve] test').record.source).toBe('svelte-adapter-bunserve');
 expect(parseDiagnostic('[svelte-adapter-bunserve/runtime.testing] test').record.component).toBe('runtime.testing');
 expect(parseDiagnostic('[svelte-adapter-uws] test').record.source).toBe('svelte-adapter-uws');
 expect(parseDiagnostic('[extensions] test').record.source).toBe('svelte-adapter-uws-extensions');
});
