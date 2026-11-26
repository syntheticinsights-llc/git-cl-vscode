import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ChangelistStore } from '../core/changelistStore';
import { getGitStatusSnapshot } from '../core/gitUtils';
import { assertNotHidden } from '../core/hiddenChangelists';
import { StashStore } from '../core/stashStore';
import { CliCommand, CliExit, OptionValues, print, printError, Repository } from './command';
import { relativeToCwd, relativeToRoot, resolvePath } from './fileStatusFormat';

export const diffCommand: CliCommand = {
	name: 'diff',
	usage: 'git-cl diff [-h] [--staged] [--both] CHANGELIST [CHANGELIST ...]',
	help: `Show unified diff for the files in one or more changelists. By default, shows
unstaged changes (including untracked files). Use --staged for staged changes,
or --both to show both.

positional arguments:
  CHANGELIST  One or more changelists to diff

options:
  -h, --help  show this help message and exit
  --staged    Show staged changes (index vs HEAD)
  --both      Show both unstaged and staged diffs`,
	flags: ['staged', 'both'],
	requiredPositionals: ['CHANGELIST'],
	run: showDiff,
};

async function showDiff({ gitRoot, gitCommonDir }: Repository, flags: OptionValues, names: string[]): Promise<number> {
	const stashStore = new StashStore(gitRoot, gitCommonDir);
	stashStore.load();
	assertNotHidden(names, stashStore);
	const store = new ChangelistStore(gitRoot, gitCommonDir);
	store.load();
	const changelists = store.getAll();
	const statusMap = await readStatusMap(gitRoot);
	const trackedFiles = new Set<string>();
	const untrackedFiles = new Set<string>();

	for (const name of names) {
		if (!Object.prototype.hasOwnProperty.call(changelists, name)) {
			print(`Changelist '${name}' not found.`);
			continue;
		}
		for (const file of changelists[name]) {
			const absolute = resolvePath(path.resolve(gitRoot, file));
			const rootRelative = relativeToRoot(absolute, gitRoot) ?? file;
			const status = statusMap.get(rootRelative);
			const isDeleted = status !== undefined && (status[0] === 'D' || status[1] === 'D');
			if (fs.existsSync(absolute)) {
				if (status === '??') {
					untrackedFiles.add(relativeToCwd(absolute));
				} else {
					trackedFiles.add(relativeToCwd(absolute));
				}
			} else if (isDeleted) {
				trackedFiles.add(relativeToCwd(absolute));
			} else {
				print(`Warning: File '${file}' from '${name}' does not exist.`);
			}
		}
	}

	if (trackedFiles.size === 0 && untrackedFiles.size === 0) {
		print('No valid files to diff.');
		return 0;
	}

	const tracked = [...trackedFiles].sort();
	const untracked = [...untrackedFiles].sort();
	if (flags.both === true) {
		print('=== Unstaged changes (working tree vs index) ===');
		showUnstagedDiff(tracked, untracked);
		print('\n=== Staged changes (index vs HEAD) ===');
		if (tracked.length > 0) {
			runGitDiff(['--staged'], tracked);
		}
	} else if (flags.staged === true) {
		if (tracked.length > 0) {
			runGitDiff(['--staged'], tracked);
		}
	} else {
		showUnstagedDiff(tracked, untracked);
	}
	return 0;
}

async function readStatusMap(gitRoot: string): Promise<Map<string, string>> {
	let status: ReadonlyMap<string, string>;
	try {
		({ status } = await getGitStatusSnapshot(gitRoot));
	} catch (error) {
		printError(`Error getting git status: ${error instanceof Error ? error.message : String(error)}`);
		throw new CliExit(1);
	}
	const normalized = new Map<string, string>();
	for (const [file, code] of status) {
		const key = relativeToRoot(resolvePath(path.resolve(gitRoot, file)), gitRoot) ?? file;
		normalized.set(key, code);
	}
	return normalized;
}

function showUnstagedDiff(tracked: string[], untracked: string[]): void {
	if (tracked.length > 0) {
		runGitDiff([], tracked);
	}
	const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
	for (const file of untracked) {
		spawnSync('git', ['diff', '--no-index', '--', nullDevice, file], { stdio: 'inherit' });
	}
}

function runGitDiff(options: string[], files: string[]): void {
	spawnSync('git', ['diff', ...options, '--', ...files], { stdio: 'inherit' });
}
