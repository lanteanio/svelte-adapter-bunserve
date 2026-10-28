import { defineConfig } from 'vitest/config';
export default defineConfig({ optimizeDeps: { noDiscovery: true, include: [] }, test: { include: ['test/public/*.test.js'], pool: 'forks', fileParallelism: false, setupFiles: ['./test/public/restore-globals.js'] } });
