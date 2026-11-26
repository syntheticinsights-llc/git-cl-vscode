import { describe, expect, it } from 'vitest';
import { buildBoardSnapshot, BoardSources, toFileStatus } from '../../src/board/snapshot';

function sources(overrides: Partial<BoardSources> = {}): BoardSources {
	return {
		changelists: {},
		hiddenChangelists: {},
		unassigned: [],
		status: new Map(),
		renames: new Map(),
		lineStats: new Map(),
		branch: 'main',
		compactFolders: true,
		...overrides,
	};
}

describe('toFileStatus', () => {
	it('collapses porcelain codes to one letter', () => {
		expect(toFileStatus('??')).toBe('U');
		expect(toFileStatus(' M')).toBe('M');
		expect(toFileStatus('M ')).toBe('M');
		expect(toFileStatus('A ')).toBe('A');
		expect(toFileStatus('R ')).toBe('R');
		expect(toFileStatus(' D')).toBe('D');
	});

	it('reports conflicts as conflicts', () => {
		expect(toFileStatus('UU')).toBe('!');
		expect(toFileStatus('AA')).toBe('!');
		expect(toFileStatus('DD')).toBe('!');
	});

	it('reports files git no longer sees as unchanged', () => {
		expect(toFileStatus(undefined)).toBe('none');
	});
});

describe('buildBoardSnapshot', () => {
	it('sorts files, sums line counts and keeps group order', () => {
		const snapshot = buildBoardSnapshot(sources({
			changelists: {
				first: ['lib/b.dart', 'lib/a.dart'],
				second: ['doc/c.md'],
			},
			status: new Map([['lib/b.dart', ' M'], ['lib/a.dart', '??'], ['doc/c.md', 'A ']]),
			lineStats: new Map([
				['lib/b.dart', { additions: 10, deletions: 2 }],
				['doc/c.md', { additions: 5, deletions: 0 }],
			]),
			branch: 'feature/x',
		}));

		expect(snapshot.branch).toBe('feature/x');
		expect(snapshot.changelists.map(group => group.name)).toEqual(['first', 'second']);
		expect(snapshot.changelists[0].files.map(file => file.path)).toEqual(['lib/a.dart', 'lib/b.dart']);
		expect(snapshot.changelists[0].additions).toBe(10);
		expect(snapshot.changelists[0].deletions).toBe(2);
		expect(snapshot.changelists[1].additions).toBe(5);
	});

	it('shows a rename as one file when both halves are in the group', () => {
		const snapshot = buildBoardSnapshot(sources({
			changelists: { renamed: ['lib/new.dart', 'lib/old.dart'] },
			status: new Map([['lib/new.dart', 'R '], ['lib/old.dart', 'D ']]),
			renames: new Map([['lib/new.dart', 'lib/old.dart']]),
		}));

		expect(snapshot.changelists[0].files).toHaveLength(1);
		expect(snapshot.changelists[0].files[0]).toMatchObject({
			path: 'lib/new.dart',
			status: 'R',
			renamedFrom: 'lib/old.dart',
		});
	});

	it('leaves a rename split across groups as two entries', () => {
		const snapshot = buildBoardSnapshot(sources({
			changelists: { renamed: ['lib/new.dart'] },
			status: new Map([['lib/new.dart', 'R ']]),
			renames: new Map([['lib/new.dart', 'lib/old.dart']]),
		}));

		expect(snapshot.changelists[0].files).toHaveLength(1);
		expect(snapshot.changelists[0].files[0].renamedFrom).toBeUndefined();
	});

	it('nests files into folders like Source Control', () => {
		const snapshot = buildBoardSnapshot(sources({
			compactFolders: false,
			changelists: {
				nested: [
					'packages/smartodo/common/lib/widgets/pill/dashed_pill.dart',
					'packages/smartodo/common/lib/const/ui.dart',
					'doc/active/note.md',
				],
			},
		}));

		const tree = snapshot.changelists[0].tree;
		expect(tree.folders.map(folder => folder.name)).toEqual(['doc', 'packages']);
		expect(tree.folders[0].folders[0].name).toBe('active');
		expect(tree.folders[0].folders[0].files.map(file => file.path)).toEqual(['doc/active/note.md']);
		const common = tree.folders[1].folders[0].folders[0];
		expect(common.name).toBe('common');
		expect(common.folders[0].name).toBe('lib');
		expect(common.folders[0].folders.map(folder => folder.name)).toEqual(['const', 'widgets']);
	});

	it('collapses single-child folder chains when compact folders are on', () => {
		const snapshot = buildBoardSnapshot(sources({
			changelists: { nested: ['packages/smartodo/common/lib/const/ui.dart'] },
			compactFolders: true,
		}));

		const chain = snapshot.changelists[0].tree.folders[0];
		expect(chain.name).toBe('packages/smartodo/common/lib/const');
		expect(chain.folders).toEqual([]);
		expect(chain.files.map(file => file.path)).toEqual(['packages/smartodo/common/lib/const/ui.dart']);
	});

	it('reports hidden changelists and unassigned files separately', () => {
		const snapshot = buildBoardSnapshot(sources({
			hiddenChangelists: { stashed: ['lib/hidden.dart'] },
			unassigned: ['lib/loose.dart'],
		}));

		expect(snapshot.hiddenChangelists.map(group => group.name)).toEqual(['stashed']);
		expect(snapshot.unassigned.name).toBe('Unassigned');
		expect(snapshot.unassigned.files.map(file => file.path)).toEqual(['lib/loose.dart']);
	});
});
