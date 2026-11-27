import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReviewPromptForChangelist } from '../../src/cli/reviewPromptCommand';
import { HiddenChangelistError } from '../../src/core/hiddenChangelists';
import { StashMetadata } from '../../src/core/stashStore';

const tempDirs: string[] = [];

function makeRepo(): { gitRoot: string; gitCommonDir: string } {
	const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cl-review-prompt-'));
	tempDirs.push(gitRoot);
	const gitCommonDir = path.join(gitRoot, '.git');
	fs.mkdirSync(gitCommonDir, { recursive: true });
	return { gitRoot, gitCommonDir };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe('buildReviewPromptForChangelist', () => {
	it('renders the repository template for an existing changelist', () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo.gitCommonDir, 'cl.json'), JSON.stringify({ demo: ['a.ts', 'b.ts'] }), 'utf-8');
		fs.mkdirSync(path.join(repo.gitRoot, '.vscode'), { recursive: true });
		fs.writeFileSync(
			path.join(repo.gitRoot, '.vscode', 'git-cl-review-prompt.md'),
			'Review {{changelist}}\n{{files}}',
			'utf-8'
		);

		expect(buildReviewPromptForChangelist(repo, 'demo')).toBe('Review demo\n  - a.ts\n  - b.ts');
	});

	it('falls back to the built-in template and returns undefined for unknown changelists', () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo.gitCommonDir, 'cl.json'), JSON.stringify({ known: ['x.ts'] }), 'utf-8');

		const prompt = buildReviewPromptForChangelist(repo, 'known');
		expect(prompt).toContain('Review the changes in changelist `known`.');
		expect(prompt).toContain('  - x.ts');
		expect(buildReviewPromptForChangelist(repo, 'missing')).toBeUndefined();
	});

	it('rejects hidden changelists', () => {
		const repo = makeRepo();
		const stash: StashMetadata = {
			stash_ref: 'stash@{0}',
			stash_message: 'git-cl: secret',
			files: ['a.ts'],
			timestamp: '2026-11-27T00:00:00Z',
			source_branch: 'main',
			file_categories: { unstaged_changes: ['a.ts'], staged_additions: [], untracked: [], deleted: [] },
		};
		fs.writeFileSync(path.join(repo.gitCommonDir, 'cl-stashes.json'), JSON.stringify({ secret: stash }), 'utf-8');

		expect(() => buildReviewPromptForChangelist(repo, 'secret')).toThrow(HiddenChangelistError);
	});
});
