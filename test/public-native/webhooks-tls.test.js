import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

const certificate = new URL('./fixtures/webhook-receiver.crt', import.meta.url);
const key = new URL('./fixtures/webhook-receiver.key', import.meta.url);
const child = fileURLToPath(new URL('./webhooks-tls-child.js', import.meta.url));
const serverChild = fileURLToPath(new URL('./webhooks-tls-server.js', import.meta.url));

it('pins HTTPS addresses while validating the original hostname and preserving authority', async () => {
	// Node's TLS socket exposes received SNI independently of Bun's HTTP shim.
	const server = Bun.spawn([Bun.which('node'), serverChild, fileURLToPath(certificate), fileURLToPath(key)], {
		stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'
	});
	const reader = server.stdout.getReader();
	let pending = '';
	async function readLine() {
		while (!pending.includes('\n')) {
			const { value, done } = await reader.read();
			if (done) throw new Error('TLS observer exited before reporting its listener');
			pending += new TextDecoder().decode(value);
		}
		const end = pending.indexOf('\n');
		const line = pending.slice(0, end);
		pending = pending.slice(end + 1);
		return line;
	}
	try {
		const { port } = JSON.parse(await readLine());
		for (const hostname of ['receiver.test', 'wrong.test']) {
			const subprocess = Bun.spawn([process.execPath, child, `https://${hostname}:${port}/hook`], {
				env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(certificate), NODE_TLS_REJECT_UNAUTHORIZED: '1' },
				stdout: 'pipe', stderr: 'pipe'
			});
			const [stdout, stderr, exit] = await Promise.all([
				new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited
			]);
			expect(exit, stderr).toBe(0);
			const result = JSON.parse(stdout.trim());
			if (hostname === 'receiver.test') expect(result).toEqual({ ok: true });
			else {
				expect(result.ok).toBe(false);
				expect(result.error).toMatch(/certificate|hostname|altname/i);
			}
		}
		server.stdin.write('stop\n');
		server.stdin.end();
		let output = pending;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			output += new TextDecoder().decode(value);
		}
		expect(await server.exited, await new Response(server.stderr).text()).toBe(0);
		expect(output.trim().split('\n').map(line => JSON.parse(line))).toEqual([
			{ host: `receiver.test:${port}`, servername: 'receiver.test' }
		]);
	} finally {
		server.kill();
		await server.exited;
		reader.releaseLock();
	}
}, 15000);
