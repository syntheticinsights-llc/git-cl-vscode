import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChangelistStore, validateChangelistName, sanitizeFilePath, resolveRepoPath } from './changelistStore';
import { StashMetadata, StashStore } from './stashStore';

const failingWrite = vi.hoisted(() => ({ enabled: false }));

vi.mock('fs', async importOriginal => {
	const actual = await importOriginal<typeof import('fs')>();
	const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
		if (!failingWrite.enabled) {
			return actual.writeFileSync(file, data, options);
		}
		actual.writeFileSync(file, String(data).slice(0, 5));
		throw new Error('ENOSPC');
	};
	return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

// ── validateChangelistName ──────────────────────────────────────────────────

describe('validateChangelistName', () => {
	it('accepts valid names', () => {
		expect(validateChangelistName('my-feature')).toBeNull();
		expect(validateChangelistName('bugfix_123')).toBeNull();
		expect(validateChangelistName('v1.0.0')).toBeNull();
		expect(validateChangelistName('a')).toBeNull();
		expect(validateChangelistName('A-Z_0.9')).toBeNull();
	});

	it('rejects empty name', () => {
		expect(validateChangelistName('')).toBe('Changelist name cannot be empty');
	});

	it('rejects name exceeding max length', () => {
		const longName = 'a'.repeat(101);
		expect(validateChangelistName(longName)).toContain('at most 100 characters');
	});

	it('accepts name at max length', () => {
		const exactName = 'a'.repeat(100);
		expect(validateChangelistName(exactName)).toBeNull();
	});

	it('rejects names with spaces', () => {
		expect(validateChangelistName('my feature')).toContain('alphanumeric');
	});

	it('rejects names with special characters', () => {
		expect(validateChangelistName('feat/branch')).toContain('alphanumeric');
		expect(validateChangelistName('feat@2')).toContain('alphanumeric');
		expect(validateChangelistName('a b')).toContain('alphanumeric');
		expect(validateChangelistName('foo!bar')).toContain('alphanumeric');
		expect(validateChangelistName('a~b')).toContain('alphanumeric');
	});

	it('rejects git reserved words', () => {
		expect(validateChangelistName('HEAD')).toContain('reserved git name');
		expect(validateChangelistName('FETCH_HEAD')).toContain('reserved git name');
		expect(validateChangelistName('ORIG_HEAD')).toContain('reserved git name');
		expect(validateChangelistName('MERGE_HEAD')).toContain('reserved git name');
		expect(validateChangelistName('CHERRY_PICK_HEAD')).toContain('reserved git name');
		expect(validateChangelistName('REVERT_HEAD')).toContain('reserved git name');
		expect(validateChangelistName('BISECT_HEAD')).toContain('reserved git name');
		expect(validateChangelistName('stash')).toContain('reserved git name');
		expect(validateChangelistName('refs')).toContain('reserved git name');
		expect(validateChangelistName('objects')).toContain('reserved git name');
		expect(validateChangelistName('packed-refs')).toContain('reserved git name');
	});

	it('accepts names similar to but not exactly reserved words', () => {
		expect(validateChangelistName('head')).toBeNull(); // case-sensitive
		expect(validateChangelistName('HEAD2')).toBeNull();
		expect(validateChangelistName('my-stash')).toBeNull();
	});

	it('rejects dots-only names', () => {
		expect(validateChangelistName('.')).toContain('only dots');
		expect(validateChangelistName('..')).toContain('only dots');
		expect(validateChangelistName('...')).toContain('only dots');
	});

	it('accepts dot-prefixed (hidden-style) names', () => {
		expect(validateChangelistName('.hidden')).toBeNull();
		expect(validateChangelistName('.config')).toBeNull();
	});

	it('does not reserve common branch names', () => {
		expect(validateChangelistName('main')).toBeNull();
		expect(validateChangelistName('master')).toBeNull();
		expect(validateChangelistName('status')).toBeNull();
		expect(validateChangelistName('add')).toBeNull();
	});

	it('rejects additional special characters', () => {
		expect(validateChangelistName('a^b')).toContain('alphanumeric');
		expect(validateChangelistName('a*b')).toContain('alphanumeric');
		expect(validateChangelistName('a:b')).toContain('alphanumeric');
	});

	it('rejects very long names (200 chars)', () => {
		const longName = 'a'.repeat(200);
		expect(validateChangelistName(longName)).toContain('at most 100 characters');
	});

	it('accepts moderate-length names (50 chars)', () => {
		const name = 'a'.repeat(50);
		expect(validateChangelistName(name)).toBeNull();
	});
});

// ── sanitizeFilePath ────────────────────────────────────────────────────────

describe('sanitizeFilePath', () => {
	const gitRoot = '/home/user/project';

	it('accepts valid relative paths', () => {
		expect(sanitizeFilePath('src/main.ts', gitRoot)).toBe('src/main.ts');
		expect(sanitizeFilePath('README.md', gitRoot)).toBe('README.md');
		expect(sanitizeFilePath('a/b/c/d.txt', gitRoot)).toBe('a/b/c/d.txt');
	});

	it('rejects empty path', () => {
		expect(() => sanitizeFilePath('', gitRoot)).toThrow('cannot be empty');
	});

	it('rejects absolute paths', () => {
		expect(() => sanitizeFilePath('/etc/passwd', gitRoot)).toThrow('Absolute paths');
	});

	it('rejects path traversal', () => {
		expect(() => sanitizeFilePath('../outside', gitRoot)).toThrow('traversal');
		expect(() => sanitizeFilePath('foo/../../outside', gitRoot)).toThrow('traversal');
	});

	it('rejects unsafe characters (null bytes, control chars)', () => {
		expect(() => sanitizeFilePath('file\x00name', gitRoot)).toThrow('Unsafe characters');
		expect(() => sanitizeFilePath('file\x01name', gitRoot)).toThrow('Unsafe characters');
	});

	it('normalizes path separators to forward slashes', () => {
		// On Linux, path.sep is '/', so this is already normalized
		expect(sanitizeFilePath('src/file.ts', gitRoot)).toBe('src/file.ts');
	});

	it('handles non-canonical gitRoot (trailing slash)', () => {
		expect(sanitizeFilePath('src/file.ts', '/home/user/project/')).toBe('src/file.ts');
	});

	it('handles non-canonical gitRoot (dot component)', () => {
		expect(sanitizeFilePath('src/file.ts', '/home/user/./project')).toBe('src/file.ts');
	});

	it('handles non-canonical gitRoot (double slash)', () => {
		expect(sanitizeFilePath('src/file.ts', '/home/user//project')).toBe('src/file.ts');
	});
});

// ── resolveRepoPath ─────────────────────────────────────────────────────────

describe('resolveRepoPath', () => {
	let root: string;
	let subDir: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-path-')));
		subDir = path.join(root, 'pkg', 'lib');
		fs.mkdirSync(subDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('converts cwd-relative paths to repository-relative posix paths', () => {
		expect(resolveRepoPath('a.ts', subDir, root)).toBe('pkg/lib/a.ts');
		expect(resolveRepoPath('../b.ts', subDir, root)).toBe('pkg/b.ts');
		expect(resolveRepoPath('./x/../c.ts', root, root)).toBe('c.ts');
		expect(resolveRepoPath(path.join(subDir, 'missing.ts'), root, root)).toBe('pkg/lib/missing.ts');
	});

	it('resolves a symlinked cwd to the real repository', () => {
		const link = `${root}-link`;
		fs.symlinkSync(subDir, link);
		try {
			expect(resolveRepoPath('a.ts', link, root)).toBe('pkg/lib/a.ts');
		} finally {
			fs.rmSync(link);
		}
	});

	it('rejects paths outside the repository', () => {
		expect(() => resolveRepoPath('../../../outside.ts', subDir, root)).toThrow('outside the repository');
		expect(() => resolveRepoPath('/etc/passwd', subDir, root)).toThrow('outside the repository');
	});

	it('rejects shell metacharacters and line breaks', () => {
		for (const name of ['a;b', 'a|b', 'a&b', 'a`b', 'a$b', 'a\nb', 'a\rb']) {
			expect(() => resolveRepoPath(name, root, root)).toThrow('Unsafe characters');
		}
	});
});

// ── ChangelistStore ─────────────────────────────────────────────────────────

describe('ChangelistStore', () => {
	let tmpDir: string;
	let gitDir: string;
	let store: ChangelistStore;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
		gitDir = path.join(tmpDir, '.git');
		fs.mkdirSync(gitDir);
		store = new ChangelistStore(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('load', () => {
		it('loads empty data when file does not exist', () => {
			store.load();
			expect(store.getAll()).toEqual({});
			expect(store.getNames()).toEqual([]);
		});

		it('loads valid cl.json', () => {
			const data = { feature: ['src/a.ts', 'src/b.ts'], bugfix: ['fix.ts'] };
			fs.writeFileSync(path.join(gitDir, 'cl.json'), JSON.stringify(data));
			store.load();
			expect(store.getAll()).toEqual(data);
			expect(store.getNames()).toEqual(['feature', 'bugfix']);
		});

		it('handles malformed JSON gracefully', () => {
			fs.writeFileSync(path.join(gitDir, 'cl.json'), 'not json!');
			store.load();
			expect(store.getAll()).toEqual({});
		});

		it('handles non-object JSON (array)', () => {
			fs.writeFileSync(path.join(gitDir, 'cl.json'), '["a","b"]');
			store.load();
			expect(store.getAll()).toEqual({});
		});

		it('handles null JSON', () => {
			fs.writeFileSync(path.join(gitDir, 'cl.json'), 'null');
			store.load();
			expect(store.getAll()).toEqual({});
		});

		it('filters out invalid entries (non-string-array values)', () => {
			const data = { valid: ['a.ts'], invalid: 'not-array', mixed: [1, 'b.ts'] };
			fs.writeFileSync(path.join(gitDir, 'cl.json'), JSON.stringify(data));
			store.load();
			expect(store.getAll()).toEqual({ valid: ['a.ts'] });
		});
	});

	describe('save', () => {
		it('saves changelists to disk', () => {
			store.addFiles('feature', ['src/a.ts']);
			store.save();
			const raw = fs.readFileSync(path.join(gitDir, 'cl.json'), 'utf-8');
			const parsed = JSON.parse(raw);
			expect(parsed).toEqual({ feature: ['src/a.ts'] });
		});

		it('omits empty changelists on save', () => {
			store.createChangelist('empty');
			store.addFiles('filled', ['src/a.ts']);
			store.save();
			const raw = fs.readFileSync(path.join(gitDir, 'cl.json'), 'utf-8');
			const parsed = JSON.parse(raw);
			expect(parsed).toEqual({ filled: ['src/a.ts'] });
			expect(parsed.empty).toBeUndefined();
		});

		it('creates parent directory if it does not exist', () => {
			// Remove .git dir
			fs.rmSync(gitDir, { recursive: true });
			store.addFiles('test', ['a.ts']);
			store.save();
			expect(fs.existsSync(path.join(gitDir, 'cl.json'))).toBe(true);
		});

		it('leaves the existing file intact when a write fails midway', () => {
			store.addFiles('original', ['a.ts']);
			store.save();
			const before = fs.readFileSync(store.getFilePath(), 'utf-8');

			failingWrite.enabled = true;
			try {
				store.addFiles('replacement', ['b.ts']);
				expect(() => store.save()).toThrow('ENOSPC');
			} finally {
				failingWrite.enabled = false;
			}

			expect(fs.readFileSync(store.getFilePath(), 'utf-8')).toBe(before);
			expect(fs.readdirSync(gitDir)).toEqual(['cl.json']);
		});
	});

	describe('update', () => {
		it('saves changes made on top of the latest file content', async () => {
			const other = new ChangelistStore(tmpDir);
			other.addFiles('theirs', ['a.ts']);
			other.save();

			await store.update(s => s.addFiles('mine', ['b.ts']));

			const reloaded = new ChangelistStore(tmpDir);
			reloaded.load();
			expect(reloaded.getAll()).toEqual({ theirs: ['a.ts'], mine: ['b.ts'] });
		});

		it('writes nothing and releases the lock when the mutator throws', async () => {
			store.addFiles('original', ['a.ts']);
			store.save();
			const before = fs.readFileSync(store.getFilePath(), 'utf-8');

			await expect(store.update(s => {
				s.deleteAll();
				throw new Error('boom');
			})).rejects.toThrow('boom');

			expect(fs.readFileSync(store.getFilePath(), 'utf-8')).toBe(before);
			expect(fs.readdirSync(gitDir)).toEqual(['cl.json']);
		});
	});

	describe('addFiles', () => {
		it('adds files to a new changelist', () => {
			store.addFiles('feature', ['src/a.ts', 'src/b.ts']);
			expect(store.getFiles('feature')).toEqual(['src/a.ts', 'src/b.ts']);
		});

		it('adds files to an existing changelist', () => {
			store.addFiles('feature', ['src/a.ts']);
			store.addFiles('feature', ['src/b.ts']);
			expect(store.getFiles('feature')).toEqual(['src/a.ts', 'src/b.ts']);
		});

		it('does not duplicate files already in the changelist', () => {
			store.addFiles('feature', ['src/a.ts']);
			store.addFiles('feature', ['src/a.ts']);
			expect(store.getFiles('feature')).toEqual(['src/a.ts']);
		});

		it('moves files from one changelist to another (single-ownership)', () => {
			store.addFiles('cl-a', ['src/shared.ts']);
			store.addFiles('cl-b', ['src/shared.ts']);
			expect(store.getFiles('cl-a')).toEqual([]);
			expect(store.getFiles('cl-b')).toEqual(['src/shared.ts']);
		});

		it('rejects invalid changelist name', () => {
			expect(() => store.addFiles('', ['a.ts'])).toThrow();
			expect(() => store.addFiles('HEAD', ['a.ts'])).toThrow('reserved');
			expect(() => store.addFiles('a b', ['a.ts'])).toThrow('alphanumeric');
		});

		it('rejects files with path traversal', () => {
			expect(() => store.addFiles('feat', ['../secret'])).toThrow('traversal');
		});

		it('rejects files in stashed changelists', () => {
			const stashStore = {
				getNames: () => ['stashed'],
				getAll: () => ({ stashed: { files: ['src/stashed.ts'] } as StashMetadata }),
			};
			expect(() =>
				store.addFiles('feat', ['src/stashed.ts'], stashStore)
			).toThrow('belongs to changelist "stashed"');
		});

		it('allows adding when stash store has no conflicts', () => {
			const stashStore = {
				getNames: () => ['stashed'],
				getAll: () => ({ stashed: { files: ['other-file.ts'] } as StashMetadata }),
			};
			store.addFiles('feat', ['src/a.ts'], stashStore);
			expect(store.getFiles('feat')).toEqual(['src/a.ts']);
		});
	});

	describe('addFilesLocked', () => {
		let staleStashStore: StashStore;

		beforeEach(() => {
			staleStashStore = new StashStore(tmpDir);
			staleStashStore.load();
			const writer = new StashStore(tmpDir);
			writer.setStash('hidden', {
				stash_ref: 'stash@{0}',
				stash_message: 'git-cl-stash:hidden:2026-01-01T00:00:00Z',
				files: ['src/hidden.ts'],
				timestamp: '2026-01-01T00:00:00Z',
				source_branch: 'main',
				file_categories: { unstaged_changes: ['src/hidden.ts'], staged_additions: [], untracked: [], deleted: [] },
			});
			writer.save();
		});

		it('rejects a hidden target changelist known only on disk', async () => {
			await expect(store.addFilesLocked('hidden', ['src/a.ts'], staleStashStore)).rejects.toThrow('is hidden by the user');
			expect(fs.existsSync(store.getFilePath())).toBe(false);
		});

		it('rejects files of a hidden changelist known only on disk', async () => {
			await expect(store.addFilesLocked('feat', ['src/hidden.ts'], staleStashStore)).rejects.toThrow('belongs to changelist "hidden"');
			expect(fs.existsSync(store.getFilePath())).toBe(false);
		});

		it('adds files that belong to no hidden changelist', async () => {
			await store.addFilesLocked('feat', ['src/a.ts'], staleStashStore);
			const reloaded = new ChangelistStore(tmpDir);
			reloaded.load();
			expect(reloaded.getFiles('feat')).toEqual(['src/a.ts']);
		});
	});

	describe('addFiles — edge cases from git-cl', () => {
		it('deduplicates files within a single add call', () => {
			store.addFiles('feat', ['src/a.ts', 'src/a.ts', 'src/a.ts']);
			expect(store.getFiles('feat')).toEqual(['src/a.ts']);
		});

		it('handles rapid reassignment across multiple changelists', () => {
			store.addFiles('cl-a', ['shared.ts']);
			expect(store.findChangelist('shared.ts')).toBe('cl-a');
			store.addFiles('cl-b', ['shared.ts']);
			expect(store.findChangelist('shared.ts')).toBe('cl-b');
			store.addFiles('cl-c', ['shared.ts']);
			expect(store.findChangelist('shared.ts')).toBe('cl-c');
			// Only the last changelist should have it
			expect(store.getFiles('cl-a')).toEqual([]);
			expect(store.getFiles('cl-b')).toEqual([]);
			expect(store.getFiles('cl-c')).toEqual(['shared.ts']);
		});
	});

	describe('removeFiles', () => {
		it('removes files from a changelist', () => {
			store.addFiles('feat', ['src/a.ts', 'src/b.ts']);
			store.removeFiles('feat', ['src/a.ts']);
			expect(store.getFiles('feat')).toEqual(['src/b.ts']);
		});

		it('does nothing for non-existent changelist', () => {
			store.removeFiles('nonexistent', ['src/a.ts']);
			// No throw
		});

		it('handles removing files that are not in the changelist', () => {
			store.addFiles('feat', ['src/a.ts']);
			store.removeFiles('feat', ['src/b.ts']);
			expect(store.getFiles('feat')).toEqual(['src/a.ts']);
		});
	});

	describe('createChangelist', () => {
		it('creates an empty changelist', () => {
			store.createChangelist('my-cl');
			expect(store.getNames()).toContain('my-cl');
			expect(store.getFiles('my-cl')).toEqual([]);
		});

		it('does not overwrite existing changelist', () => {
			store.addFiles('my-cl', ['a.ts']);
			store.createChangelist('my-cl');
			expect(store.getFiles('my-cl')).toEqual(['a.ts']);
		});

		it('rejects invalid names', () => {
			expect(() => store.createChangelist('HEAD')).toThrow('reserved');
		});
	});

	describe('deleteChangelist', () => {
		it('deletes a changelist and returns its files', () => {
			store.addFiles('feat', ['a.ts', 'b.ts']);
			const files = store.deleteChangelist('feat');
			expect(files).toEqual(['a.ts', 'b.ts']);
			expect(store.getNames()).not.toContain('feat');
		});

		it('returns empty array for non-existent changelist', () => {
			const files = store.deleteChangelist('nonexistent');
			expect(files).toEqual([]);
		});
	});

	describe('deleteAll', () => {
		it('removes all changelists', () => {
			store.addFiles('a', ['1.ts']);
			store.addFiles('b', ['2.ts']);
			store.deleteAll();
			expect(store.getAll()).toEqual({});
			expect(store.getNames()).toEqual([]);
		});

		it('results in empty state after multiple operations', () => {
			store.addFiles('feat1', ['a.ts', 'b.ts']);
			store.addFiles('feat2', ['c.ts']);
			store.addFiles('feat3', ['d.ts', 'e.ts']);
			store.deleteAll();
			store.save();

			const store2 = new ChangelistStore(tmpDir);
			store2.load();
			expect(store2.getAll()).toEqual({});
			expect(store2.getNames()).toEqual([]);
		});
	});

	describe('findChangelist', () => {
		it('finds which changelist contains a file', () => {
			store.addFiles('feat', ['src/a.ts']);
			store.addFiles('bug', ['src/b.ts']);
			expect(store.findChangelist('src/a.ts')).toBe('feat');
			expect(store.findChangelist('src/b.ts')).toBe('bug');
		});

		it('returns null for unassigned files', () => {
			expect(store.findChangelist('unknown.ts')).toBeNull();
		});
	});

	describe('getFilePath', () => {
		it('returns path to cl.json inside .git', () => {
			expect(store.getFilePath()).toBe(path.join(tmpDir, '.git', 'cl.json'));
		});
	});

	describe('getFiles', () => {
		it('returns empty array for non-existent changelist', () => {
			expect(store.getFiles('nonexistent')).toEqual([]);
		});
	});

	describe('interop — round-trip save/load', () => {
		it('preserves data through save and reload', () => {
			store.addFiles('feature', ['src/a.ts', 'src/b.ts']);
			store.addFiles('bugfix', ['fix.ts']);
			store.save();

			const store2 = new ChangelistStore(tmpDir);
			store2.load();
			expect(store2.getFiles('feature')).toEqual(['src/a.ts', 'src/b.ts']);
			expect(store2.getFiles('bugfix')).toEqual(['fix.ts']);
		});

		it('empty changelists are dropped on round-trip', () => {
			store.createChangelist('empty');
			store.addFiles('filled', ['a.ts']);
			store.save();

			const store2 = new ChangelistStore(tmpDir);
			store2.load();
			expect(store2.getNames()).toEqual(['filled']);
		});
	});
});
