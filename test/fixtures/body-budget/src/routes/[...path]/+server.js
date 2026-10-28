export async function POST({ request, url }) {
 if (url.searchParams.has('held')) return new Promise(() => {});
 if (url.searchParams.has('early')) return new Response('early');
 if (url.searchParams.has('stream')) {
  return new Response(new ReadableStream({ start(out) {
   out.enqueue(new TextEncoder().encode('prefix'));
   request.text().then(() => { out.enqueue(new TextEncoder().encode('complete')); out.close(); }, () => {});
  } }));
 }
 try { return new Response(await request.text()); } catch { return new Response('swallowed'); }
}
export const PUT = POST;
export function GET() { return new Response('get'); }
