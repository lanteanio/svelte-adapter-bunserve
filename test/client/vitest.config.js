import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/client/*.test.js'],
		pool: 'forks',
		fileParallelism: false
	}
});
