import { readFileSync } from 'node:fs';
const text = readFileSync(new URL('../src/runtime/utils/static-negotiate.js', import.meta.url), 'utf8');
const load = source => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const old = text.replace('negotiateEncoding(header, hasBr, hasGz)', 'negotiateEncoding(header, { hasBr, hasGz })');
const a = (await load(old)).negotiateEncoding;
const aa = (await load(old + '\n// control')).negotiateEncoding;
const b = (await load(text)).negotiateEncoding;
const entries = [{ hasBr: true, hasGz: true }, { hasBr: false, hasGz: true }];
const headers = ['gzip, deflate, br', 'br', 'gzip;q=0.8, br;q=1', 'gzip', ''];
let sum = 0;
function run(fn, object) {
 const start = performance.now();
 for (let i = 0; i < 2000000; i++) {
  const entry = entries[i & 1]; const header = headers[i % headers.length];
  sum += (object ? fn(header, { hasBr: entry.hasBr === true, hasGz: entry.hasGz === true }) : fn(header, entry.hasBr === true, entry.hasGz === true)).length;
 }
 return performance.now() - start;
}
for (let i = 0; i < 3; i++) { run(a, true); run(aa, true); run(b, false); }
const rows = [];
for (let i = 0; i < 7; i++) {
 const row = {};
 for (const [name, fn, object] of (i % 2 ? [['B', b, false], ['AA', aa, true], ['A', a, true]] : [['A', a, true], ['AA', aa, true], ['B', b, false]])) row[name] = run(fn, object);
 rows.push(row);
}
console.log(JSON.stringify({ rows, checksum: sum }));
