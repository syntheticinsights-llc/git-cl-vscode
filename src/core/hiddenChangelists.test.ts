import { describe, it, expect } from 'vitest';
import { assertFilesNotHidden, assertNotHidden, findHiddenChangelists, HiddenChangelistError } from './hiddenChangelists';
import { StashMetadata } from './stashStore';

const stashes = { getNames: () => ['hidden-a', 'hidden-b'] };

describe('findHiddenChangelists', () => {
	it('reports each hidden name once, in the order given', () => {
		expect(findHiddenChangelists(['visible', 'hidden-b', 'hidden-a', 'hidden-b'], stashes)).toEqual(['hidden-b', 'hidden-a']);
	});

	it('reports nothing when no name is hidden', () => {
		expect(findHiddenChangelists(['visible'], stashes)).toEqual([]);
	});
});

describe('assertNotHidden', () => {
	it('passes when no name is hidden', () => {
		expect(() => assertNotHidden(['visible'], stashes)).not.toThrow();
	});

	it('throws one message line per hidden name', () => {
		let error: unknown;
		try {
			assertNotHidden(['hidden-a', 'visible', 'hidden-b'], stashes);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(HiddenChangelistError);
		const lines = (error as HiddenChangelistError).lines;
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('"hidden-a"');
		expect(lines[1]).toContain('"hidden-b"');
	});
});

describe('assertFilesNotHidden', () => {
	const stashedFiles = (files: string[]) => ({ files } as StashMetadata);
	const fileStashes = { getAll: () => ({ 'hidden-a': stashedFiles(['src/a.ts']), 'hidden-b': stashedFiles(['src/b.ts']) }) };

	it('names each hidden file together with the changelist that holds it', () => {
		expect(() => assertFilesNotHidden(['src/visible.ts'], fileStashes)).not.toThrow();
		expect(() => assertFilesNotHidden(['src/visible.ts', 'src/b.ts'], fileStashes))
			.toThrow(/^File "src\/b\.ts" belongs to changelist "hidden-b"[^\n]*$/);
	});
});
