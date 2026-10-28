const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'other'];
const outcomes = ['ok', 'client_error', 'server_error', 'aborted'];
const labels = Object.fromEntries(methods.map(method => [method, Object.fromEntries(outcomes.map(outcome => [outcome, Object.freeze({ method, outcome })]))]));
const outcomeFor = status => status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'ok';

/** Bounded HTTP RED measurements without wrapping native file responses. */
export function createHttpTransportMetrics(counter, histogram, clock) {
 const requests = new WeakMap();
 return {
  begin(request) {
   if (!counter && !histogram) return;
   const method = request.method.toLowerCase();
   const row = labels[methods.includes(method) ? method : 'other'];
   const started = histogram ? clock() : 0;
   const state = { deferred: false, status: 200, finish(outcome) {
    if (!requests.delete(request)) return;
    request.signal.removeEventListener('abort', aborted);
    if (outcome === null) return;
    counter?.inc(row[outcome]);
    histogram?.observe(row[outcome], Math.max(0, clock() - started) / 1000);
   } };
   const aborted = () => state.finish('aborted');
   requests.set(request, state);
   request.signal.addEventListener('abort', aborted, { once: true });
   if (request.signal.aborted) aborted();
  },
  response(request, response) {
   const state = requests.get(request);
   if (!state) return;
   // A successful upgrade is measured by the WebSocket handshake instruments.
   if (response === undefined) {
    state.finish(null);
    return;
   }
   if (!state.deferred) state.finish(outcomeFor(response.status));
  },
  streaming(request, status) {
   const state = requests.get(request);
   if (state) { state.deferred = true; state.status = status; }
  },
  finish(request, outcome) {
   const state = requests.get(request);
   if (state?.deferred) state.finish(outcome ?? outcomeFor(state.status));
  },
  failed(request) { requests.get(request)?.finish('server_error'); }
 };
}

// Kept independent of build-time configuration for the request-lifetime helper.
export let httpMetrics = createHttpTransportMetrics();
export function configureHttpTransportMetrics(counter, histogram, clock) {
 httpMetrics = createHttpTransportMetrics(counter, histogram, clock);
}
