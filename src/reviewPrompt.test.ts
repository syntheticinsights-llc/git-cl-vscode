import { describe, expect, it } from 'vitest';
import { renderReviewPrompt } from './reviewPrompt';

describe('renderReviewPrompt', () => {
	it('fills every changelist and files placeholder', () => {
		const prompt = renderReviewPrompt('{{changelist}} / {{ changelist }}\n{{files}}', {
			changelist: 'task-1',
			files: ['a/b.ts', 'c.ts'],
		});

		expect(prompt).toBe('task-1 / task-1\n  - a/b.ts\n  - c.ts');
	});

	it('inserts file paths literally even when they look like replacement patterns', () => {
		const prompt = renderReviewPrompt('{{files}}', { changelist: 'x', files: ['$&/$1.ts'] });

		expect(prompt).toBe('  - $&/$1.ts');
	});
});
