import { describe, expect, it } from 'vitest';
import { buildFileTree, collectFiles, dirname, FileTreeFolder } from './fileTree';

function shape(folder: FileTreeFolder): unknown {
	return {
		label: folder.label,
		folders: folder.folders.map(shape),
		files: folder.files,
	};
}

describe('buildFileTree', () => {
	it('nests files under their folders, folders before files in natural order', () => {
		const tree = buildFileTree(['b.txt', 'src/z.ts', 'src/a10.ts', 'src/a2.ts', 'docs/x.md', 'A.txt'], false);

		expect(shape(tree)).toEqual({
			label: '',
			folders: [
				{ label: 'docs', folders: [], files: ['docs/x.md'] },
				{ label: 'src', folders: [], files: ['src/a2.ts', 'src/a10.ts', 'src/z.ts'] },
			],
			files: ['A.txt', 'b.txt'],
		});
	});

	it('compacts single-child folder chains and keeps the deepest path', () => {
		const tree = buildFileTree(['pkg/lib/src/a.ts', 'pkg/lib/src/b/c.ts', 'pkg/lib/src/b/d.ts'], true);

		expect(tree.folders).toHaveLength(1);
		const compacted = tree.folders[0];
		expect(compacted.label).toBe('pkg/lib/src');
		expect(compacted.path).toBe('pkg/lib/src');
		expect(compacted.files).toEqual(['pkg/lib/src/a.ts']);
		expect(compacted.folders.map(f => f.label)).toEqual(['b']);
	});

	it('does not compact a folder that holds files or several subfolders', () => {
		const tree = buildFileTree(['a/x.ts', 'a/b/y.ts', 'c/d/z.ts', 'c/e/w.ts'], true);

		expect(tree.folders.map(f => f.label)).toEqual(['a', 'c']);
		expect(tree.folders[1].folders.map(f => f.label)).toEqual(['d', 'e']);
	});

	it('keeps every input file reachable', () => {
		const files = ['a/b/c/1.ts', 'a/b/2.ts', 'x/3.ts', '4.ts'];
		const tree = buildFileTree(files, true);

		expect(collectFiles(tree).sort()).toEqual([...files].sort());
	});
});

describe('dirname', () => {
	it('returns the folder part or undefined at the root', () => {
		expect(dirname('a/b/c.ts')).toBe('a/b');
		expect(dirname('c.ts')).toBeUndefined();
	});
});
