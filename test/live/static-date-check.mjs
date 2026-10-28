// Real GET/HEAD date preconditions through the built adapter and Bun transport.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { serverEnv } from './harness.mjs';

for (const [key, value] of Object.entries(serverEnv({}))) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
const { start } = await import('../fixture/build/server.js');
const { cacheDir } = await import('../fixture/build/handler/static-assets.js');
const server = start('127.0.0.1', 0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-http-dates-'));
const content = Buffer.from('Static dates with compressed representations.\n'.repeat(200));
const reportedStamps = {};
const stamps = { future: Date.UTC(2099, 0, 1), old: Date.UTC(1899, 0, 1), past: Date.UTC(2020, 0, 1) };

function request(name, method, coding, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: server.port, path: `/http-dates/${name}.txt`, method,
			headers: { 'accept-encoding': coding, ...headers } }, res => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		req.setTimeout(5000, () => req.destroy(new Error('static date request timed out')));
		req.on('error', reject);
		req.end();
	});
}

let passed = 0;
try {
	for (const [name, stamp] of Object.entries(stamps)) {
		const file = path.join(dir, name + '.txt');
		fs.writeFileSync(file, content);
		fs.writeFileSync(file + '.br', zlib.brotliCompressSync(content));
		fs.writeFileSync(file + '.gz', zlib.gzipSync(content));
		// Windows Node and Bun report this real NTFS 1899 timestamp as 2035.
		// Verify the historical fixture using the platform API; ETags use the
		// timestamp Bun reports. Unit coverage injects a pre-1900 stat directly.
		if (stamp < 0 && process.platform === 'win32') {
			const actual = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
				'$time = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:BUNSERVE_TEST_DATE_MS).UtcDateTime; [IO.File]::SetLastWriteTimeUtc($env:BUNSERVE_TEST_DATE_FILE, $time); ([DateTimeOffset]([IO.File]::GetLastWriteTimeUtc($env:BUNSERVE_TEST_DATE_FILE))).ToUnixTimeMilliseconds()'], {
				encoding: 'utf8', env: { ...process.env, BUNSERVE_TEST_DATE_FILE: file, BUNSERVE_TEST_DATE_MS: String(stamp) }
			});
			assert.equal(Number(actual.trim()), stamp);
		} else fs.utimesSync(file, new Date(stamp), new Date(stamp));
		reportedStamps[name] = fs.statSync(file).mtimeMs;
		if (stamp >= 0) assert.equal(reportedStamps[name], stamp);
	}
	cacheDir(dir, '/http-dates', false);
	for (const method of ['GET', 'HEAD']) {
		for (const coding of ['identity', 'br', 'gzip']) {
			for (const [name, stamp] of Object.entries(stamps)) {
				const full = await request(name, method, coding);
				assert.equal(full.status, 200);
				assert.equal(full.headers['last-modified'], name === 'past' ? 'Wed, 01 Jan 2020 00:00:00 GMT' : undefined);
				const suffix = coding === 'identity' ? '' : coding === 'br' ? '-br' : '-gzip';
				assert.equal(full.headers.etag, `W/"${reportedStamps[name].toString(36)}-${content.length.toString(36)}${suffix}"`);
				const decode = coding === 'br' ? zlib.brotliDecompressSync : coding === 'gzip' ? zlib.gunzipSync : bytes => bytes;
				if (method === 'HEAD') assert.equal(full.body.length, 0);
				else assert.deepEqual(decode(full.body), content);
				const tagged = await request(name, method, coding, { 'if-none-match': full.headers.etag });
				assert.equal(tagged.status, 304);
				assert.equal(tagged.body.length, 0);
				assert.equal(tagged.headers['last-modified'], full.headers['last-modified']);
				const dated = await request(name, method, coding, { 'if-modified-since': new Date(stamp).toUTCString() });
				assert.equal(dated.status, name === 'past' ? 304 : 200);
				const stale = await request(name, method, coding, { 'if-unmodified-since': 'Sat, 01 Jan 2000 00:00:00 GMT' });
				assert.equal(stale.status, name === 'past' ? 412 : 200);
				passed++;
			}
			for (const value of ['2021-01-01', 'January 1, 2021', 'Thu, 01 Jan 2020 00:00:00 GMT']) {
				assert.equal((await request('past', method, coding, { 'if-modified-since': value })).status, 200);
				assert.equal((await request('past', method, coding, { 'if-unmodified-since': value })).status, 200);
			}
			for (const value of ['Wednesday, 01-Jan-20 00:00:00 GMT', 'Wed Jan  1 00:00:00 2020']) {
				assert.equal((await request('past', method, coding, { 'if-modified-since': value })).status, 304);
				assert.equal((await request('past', method, coding, { 'if-unmodified-since': value })).status, 200);
			}
			passed++;
		}
	}
	console.log(`static-date: ${passed} live cases passed`);
} finally {
	server.stop(true);
	fs.rmSync(dir, { recursive: true, force: true });
}
