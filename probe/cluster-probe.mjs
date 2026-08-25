// What Bun 1.4's node:cluster gives a Bun.serve WebSocket server, measured.
// Primary forks two workers sharing one listen socket; a client subscribes on
// whichever worker it lands on, a publish is made from each worker, and the
// primary attempts to hand workers a SharedArrayBuffer.
import cluster from 'node:cluster';

const PORT = 8891;
const out = (k, v) => console.log(`${k} = ${v}`);

if (cluster.isPrimary) {
	out('bun', Bun.version);
	setTimeout(() => { console.log('PROBE TIMED OUT'); process.exit(1); }, 25000);

	const sab = new SharedArrayBuffer(8);
	new Int32Array(sab)[0] = 42;
	const workers = [cluster.fork(), cluster.fork()];
	let ready = 0;
	const results = [];
	for (const w of workers) {
		w.on('message', (m) => {
			if (m.t === 'ready') {
				ready++;
				// Attempt the SharedArrayBuffer hand-off uws's primaryInit contract needs.
				try { w.send({ t: 'sab', sab }); } catch (e) { results.push(`send(sab) threw in primary: ${String(e.message).slice(0, 80)}`); }
				if (ready === 2) setTimeout(run, 200);
			} else if (m.t === 'obs') {
				results.push(m.line);
			}
		});
	}

	async function run() {
		// Two clients: with round-robin they should land on different workers.
		const mk = () => new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
			const got = [];
			ws.onmessage = (e) => got.push(String(e.data));
			ws.onopen = () => resolve({ ws, got });
			ws.onerror = () => reject(new Error('client failed'));
		});
		// Open clients until two land on DIFFERENT workers, or give up at 14.
		const pool = [];
		let a = null, b = null;
		for (let i = 0; i < 14 && !b; i++) {
			const c = await mk();
			pool.push(c);
			c.ws.send('whoami');
			await Bun.sleep(150);
			const pid = c.got.find((g) => g.startsWith('pid:'));
			if (!a) a = c;
			else if (pid && pid !== a.got.find((g) => g.startsWith('pid:'))) b = c;
		}
		if (!b) { out('distribution', 'all 14 clients landed on one worker'); b = pool[1]; }
		await Bun.sleep(100);
		a.ws.send('subscribe'); b.ws.send('subscribe');
		await Bun.sleep(200);
		a.ws.send('publish:from-A-worker');
		await Bun.sleep(400);
		// Placement-independent isolation: EVERY worker publishes by primary
		// order; the client hears only what its own worker's registry holds.
		for (const w of workers) w.send({ t: 'do-publish' });
		await Bun.sleep(500);
		const heard = a.got.filter((g) => g.startsWith('topic:pid-'));
		out('publishes heard by the client', JSON.stringify(heard));
		out('client pid', a.got.find((g) => g.startsWith('pid:')));
		out('client A worker', a.got.find((g) => g.startsWith('pid:')));
		out('client B worker', b.got.find((g) => g.startsWith('pid:')));
		const sameWorker = a.got.find((g) => g.startsWith('pid:')) === b.got.find((g) => g.startsWith('pid:'));
		out('clients landed on the same worker', sameWorker);
		out('client A saw the publish', a.got.some((g) => g === 'topic:from-A-worker'));
		out('client B saw the publish', b.got.some((g) => g === 'topic:from-A-worker'));
		await Bun.sleep(300);
		for (const line of results) out('worker observation', line);
		for (const w of workers) w.kill();
		process.exit(0);
	}
} else {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: PORT,
		reusePort: true,
		fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response('no', { status: 400 }); },
		websocket: {
			message(ws, msg) {
				const m = String(msg);
				if (m === 'whoami') ws.send(`pid:${process.pid}`);
				else if (m === 'subscribe') ws.subscribe('t');
				else if (m.startsWith('publish:')) server.publish('t', `topic:${m.slice(8)}`);
			},
			open() {}
		}
	});
	process.on('message', (m) => {
		if (m && m.t === 'do-publish') {
			server.publish('t', 'topic:pid-' + process.pid);
			return;
		}
		if (m && m.t === 'sab') {
			const isSab = m.sab instanceof SharedArrayBuffer;
			let shared = 'n/a';
			if (isSab) {
				const view = new Int32Array(m.sab);
				const before = view[0];
				view[0] = process.pid;
				shared = `arrived as SharedArrayBuffer, read ${before}`;
			} else {
				shared = `arrived as ${Object.prototype.toString.call(m.sab)} (structured-clone copy or serialization)`;
			}
			process.send({ t: 'obs', line: `pid ${process.pid}: sab ${shared}` });
		}
	});
	process.send({ t: 'ready' });
}
