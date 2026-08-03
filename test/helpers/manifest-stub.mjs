// Stand-in for the build-generated manifest module (`MANIFEST` specifier), so
// modules that reach it through manifest-bridge.js can be driven from unit
// tests without a build. Shapes only - the values are whatever the individual
// test arranges in the caches it populates itself.
export const manifest = { appPath: '_app' };
export const prerendered = new Set();
export const base = '';
