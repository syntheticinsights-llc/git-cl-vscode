import { describe, it, expect } from 'vitest';
import { StashMetadata } from '../core/stashStore';
import { findHiddenEdit } from './guardEditCommand';

const root = '/repo';
const stashedFiles = (files: string[]) => ({ files } as StashMetadata);
const stashes = { getAll: () => ({ 'hidden-a': stashedFiles(['src/a.ts', 'docs/notes.md']) }) };

describe('findHiddenEdit', () => {
	it('blocks a file of a hidden changelist and names the changelist', () => {
		expect(findHiddenEdit('/repo/src/a.ts', root, stashes)).toBe(
			'File "src/a.ts" belongs to changelist "hidden-a", which is hidden by the user (stashed). Do not edit its files; ask the user before continuing.',
		);
	});

	it('allows a file that no hidden changelist holds', () => {
		expect(findHiddenEdit('/repo/src/b.ts', root, stashes)).toBeUndefined();
	});

	it('allows a new file in a new directory', () => {
		expect(findHiddenEdit('/repo/new/dir/a.ts', root, stashes)).toBeUndefined();
	});

	it('allows a path outside the repository', () => {
		expect(findHiddenEdit('/elsewhere/src/a.ts', root, stashes)).toBeUndefined();
	});

	it('allows the repository root itself', () => {
		expect(findHiddenEdit('/repo', root, stashes)).toBeUndefined();
	});

	it('allows every file when nothing is hidden', () => {
		expect(findHiddenEdit('/repo/src/a.ts', root, { getAll: () => ({}) })).toBeUndefined();
	});
});
