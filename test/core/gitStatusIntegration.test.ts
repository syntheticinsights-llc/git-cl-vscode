import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGitStatusSnapshot, getHeadFiles, gitCommit, revertFilesToHead } from '../../src/core/gitUtils';

/**
 * Runs git for real. The codes these tests pin — an intent-to-add as " A", an
 * unstaged rename as " R" followed by its original path — are facts about git,
 * not about the parser, and a mocked fixture can only repeat what we assumed.
 */
describe('getGitStatusSnapshot against git', () => {
	let repo: string;

	const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
	const write = (file: string, content: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		fs.writeFileSync(path.join(repo, file), content);
	};

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cl-status-'));
		git('init', '-q', '.');
		git('config', 'user.email', 'test@example.com');
		git('config', 'user.name', 'test');
		write('lib/a.dart', 'class A {}\n');
		git('add', '-A');
		git('commit', '-qm', 'init');
	});

	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it('reports an intent-to-add file as an unstaged addition', async () => {
		write('lib/c.dart', 'class C {}\n');
		git('add', '-N', 'lib/c.dart');

		const { status } = await getGitStatusSnapshot(repo);

		expect(status.get('lib/c.dart')).toBe(' A');
	});

	it('splits an unstaged rename into an add of the new path and a delete of the original', async () => {
		fs.mkdirSync(path.join(repo, 'sub'));
		git('mv', 'lib/a.dart', 'sub/a.dart');
		git('reset', '-q', 'HEAD', '--', 'sub/a.dart', 'lib/a.dart');
		git('add', '-N', 'sub/a.dart');

		const { status, renames } = await getGitStatusSnapshot(repo);

		expect(status.get('sub/a.dart')).toBe(' A');
		expect(status.get('lib/a.dart')).toBe(' D');
		expect(renames.get('sub/a.dart')).toBe('lib/a.dart');
	});

	it('keeps a path containing an arrow intact', async () => {
		write('lib/a -> b.dart', 'class A {}\n');
		git('add', 'lib/a -> b.dart');

		const { status } = await getGitStatusSnapshot(repo);

		expect(status.get('lib/a -> b.dart')).toBe('A ');
	});

	it('commits an untracked file directly without needing git add -N', async () => {
		write('lib/untracked.dart', 'class U {}\n');

		await gitCommit(['lib/untracked.dart'], 'add untracked', repo);

		const { status } = await getGitStatusSnapshot(repo);
		expect(status.size).toBe(0);
		expect(await getHeadFiles(['lib/untracked.dart'], repo)).toEqual(new Set(['lib/untracked.dart']));
	});

	it('reverts HEAD files and removes untracked, staged-new, and intent-to-add files cleanly', async () => {
		write('lib/a.dart', 'class AModified {}\n');
		write('lib/untracked.dart', 'class U {}\n');
		write('lib/staged.dart', 'class S {}\n');
		git('add', 'lib/staged.dart');
		write('lib/intent.dart', 'class I {}\n');
		git('add', '-N', 'lib/intent.dart');
		write('lib/intent-deleted.dart', 'class ID {}\n');
		git('add', '-N', 'lib/intent-deleted.dart');
		fs.rmSync(path.join(repo, 'lib/intent-deleted.dart'));

		const result = await revertFilesToHead(
			['lib/a.dart', 'lib/untracked.dart', 'lib/staged.dart', 'lib/intent.dart', 'lib/intent-deleted.dart'],
			repo
		);

		expect(result.reverted).toEqual(['lib/a.dart']);
		expect(result.deleted).toEqual(['lib/untracked.dart', 'lib/staged.dart', 'lib/intent.dart', 'lib/intent-deleted.dart']);
		expect(fs.readFileSync(path.join(repo, 'lib/a.dart'), 'utf-8')).toBe('class A {}\n');
		expect(fs.existsSync(path.join(repo, 'lib/untracked.dart'))).toBe(false);
		expect(fs.existsSync(path.join(repo, 'lib/staged.dart'))).toBe(false);
		expect(fs.existsSync(path.join(repo, 'lib/intent.dart'))).toBe(false);
		expect((await getGitStatusSnapshot(repo)).status.size).toBe(0);
	});
});
