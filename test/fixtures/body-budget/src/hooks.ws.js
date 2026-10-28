export async function authenticate({ request }) {
 if (new URL(request.url).searchParams.has('held')) return new Promise(() => {});
 try { return new Response(await request.text()); } catch { return new Response('swallowed'); }
}
export async function admin(request) {
 if (new URL(request.url).searchParams.has('held')) return new Promise(() => {});
 try { return new Response(await request.text()); } catch { return new Response('swallowed'); }
}
