import { describe, expect, it } from 'vitest';
import { countLines } from '../../src/core/untrackedStats';

describe('countLines', () => {
	it('counts newline-terminated lines', () => {
		expect(countLines(Buffer.from('a\nb\nc\n'))).toBe(3);
		expect(countLines(Buffer.from(''))).toBe(0);
	});

	it('counts a trailing fragment without a newline', () => {
		expect(countLines(Buffer.from('a\nb'))).toBe(2);
	});

	it('gives up on binary content', () => {
		expect(countLines(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toBeUndefined();
	});
});
