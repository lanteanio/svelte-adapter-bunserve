import adapter from '../../../src/index.js';
export default { kit: { adapter: adapter({
 out: 'build', warmup: false,
 bodyLimits: [
  { path: '/base/echo', bytes: 8 },
  { path: '/base/held-large', bytes: 128 * 1024 },
  { path: '/base/tiny', prefix: true, bytes: 3 },
  { path: '/base/zero', bytes: 0 },
  { path: '/base/auth', bytes: 8 },
  { path: '/base/admin', prefix: true, bytes: 8 },
  { path: '/base/a*/b', bytes: 1 }
 ],
 websocket: { handler: 'src/hooks.ws.js', authPath: '/base/auth', adminPath: '/base/admin', authPathRequireOrigin: false, authPathRateLimit: 0 }
}), paths: { base: '/base' } } };
