import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/core/changelistStore.ts', 'src/core/stashStore.ts', 'src/core/gitUtils.ts'],
			reporter: ['text', 'text-summary'],
			thresholds: {
				statements: 80,
				branches: 80,
				functions: 80,
				lines: 80,
			},
		},
	},
});
