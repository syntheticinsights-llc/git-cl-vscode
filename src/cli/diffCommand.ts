import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ChangelistStore } from '../core/changelistStore';
import { CliCommand, OptionValues, print, Repository } from './command';
import { relativeToCwd, resolvePath } from './fileStatusFormat';

export const diffCommand: CliCommand = {
	name: 'diff',
	usage: 'git-cl diff [-h] [--staged] [--both] CHANGELIST [CHANGELIST ...]',
	help: `Show unified diff for the files in one or more changelists. By default, shows
unstaged changes (like \`git diff\`). Use --staged for staged changes, or --both
to show both.

positional arguments:
  CHANGELIST  One or more changelists to diff

options:
  -h, --help  show this help message and exit
  --staged    Show staged changes (index vs HEAD)
  --both      Show both unstaged and staged diffs`,
	flags: ['staged', 'both'],
	requiredPositional: 'CHANGELIST',
	run: showDiff,
};

function showDiff({ gitRoot, gitCommonDir }: Repository, flags: OptionValues, names: string[]): number {
	const store = new ChangelistStore(gitRoot, gitCommonDir);
	store.load();
	const changelists = store.getAll();
	const diffFiles = new Set<string>();

	for (const name of names) {
		if (!Object.prototype.hasOwnProperty.call(changelists, name)) {
			print(`Changelist '${name}' not found.`);
			continue;
		}
		for (const file of changelists[name]) {
			const absolute = resolvePath(path.resolve(gitRoot, file));
			if (fs.existsSync(absolute)) {
				diffFiles.add(relativeToCwd(absolute));
			} else {
				print(`Warning: File '${file}' from '${name}' does not exist.`);
			}
		}
	}

	if (diffFiles.size === 0) {
		print('No valid files to diff.');
		return 0;
	}

	const files = [...diffFiles].sort();
	if (flags.both === true) {
		print('=== Unstaged changes (working tree vs index) ===');
		runGitDiff([], files);
		print('\n=== Staged changes (index vs HEAD) ===');
		runGitDiff(['--staged'], files);
	} else if (flags.staged === true) {
		runGitDiff(['--staged'], files);
	} else {
		runGitDiff([], files);
	}
	return 0;
}

function runGitDiff(options: string[], files: string[]): void {
	spawnSync('git', ['diff', ...options, '--', ...files], { stdio: 'inherit' });
}
