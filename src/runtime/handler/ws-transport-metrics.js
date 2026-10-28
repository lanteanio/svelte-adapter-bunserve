/** Bun transport hooks with bounded labels and monotonic durations. */
export function createWsTransportMetrics(instrument, clock, state = { upgradeInFlight: 0 }) {
 const messages = instrument('counter', 'ws_messages_total');
 const duration = instrument('histogram', 'ws_message_duration_seconds');
 const connections = instrument('histogram', 'ws_connection_duration_seconds');
 const publishes = instrument('counter', 'ws_publish_outcomes_total');
 const frames = instrument('counter', 'ws_dropped_frames_total');
 const bytes = instrument('counter', 'ws_dropped_bytes_total');
 const opened = new WeakMap();
 const messageLabels = {
  text: { ok: { kind: 'text', outcome: 'ok' }, error: { kind: 'text', outcome: 'error' } },
  binary: { ok: { kind: 'binary', outcome: 'ok' }, error: { kind: 'binary', outcome: 'error' } }
 };
 for (const row of Object.values(messageLabels)) { for (const labels of Object.values(row)) Object.freeze(labels); Object.freeze(row); }
 Object.freeze(messageLabels);
 const clean = Object.freeze({ outcome: 'clean' }), abnormal = Object.freeze({ outcome: 'abnormal' });
 const delivered = Object.freeze({ outcome: 'delivered' }), none = Object.freeze({ outcome: 'no_subscribers' });
 return {
  upgradeStart(request) {
   state.upgradeInFlight++;
   let active = true;
   const finish = () => {
    if (!active) return;
    active = false;
    state.upgradeInFlight--;
    request.signal.removeEventListener('abort', finish);
   };
   request.signal.addEventListener('abort', finish, { once: true });
   if (request.signal.aborted) finish();
   return finish;
  },
  messageStart(ws, message) {
   const kind = typeof message === 'string' ? 'text' : 'binary';
   const start = duration ? clock() : 0;
   let finished = false;
   return error => {
    if (finished) return;
    finished = true;
    const labels = messageLabels[kind][error ? 'error' : 'ok'];
    messages?.inc(labels);
    duration?.observe(labels, Math.max(0, clock() - start) / 1000);
   };
  },
  connectionOpen(ws) { if (connections) opened.set(ws, clock()); },
  connectionClose(ws, code) {
   const start = opened.get(ws);
   opened.delete(ws);
   if (start !== undefined) connections?.observe(code === 1000 || code === 1001 ? clean : abnormal, Math.max(0, clock() - start) / 1000);
  },
  publishOutcome(ok) { publishes?.inc(ok ? delivered : none); },
  dropped(size) { frames?.inc(undefined, 1); bytes?.inc(undefined, size); }
 };
}
