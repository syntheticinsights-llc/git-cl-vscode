import * as path from 'path';
import { ChangelistData, ChangelistStore } from '../core/changelistStore';
import { getGitStatusSnapshot } from '../core/gitUtils';
import { assertNotHidden } from '../core/hiddenChangelists';
import { StashData, StashStore } from '../core/stashStore';
import { CliCommand, CliExit, OptionValues, print, printError, Repository } from './command';
import { CONFLICT_CODES, formatFileStatus, relativeToRoot, resolvePath, shouldUseColor } from './fileStatusFormat';

const ISO_TIMESTAMP = /^(\d{4})-?(\d{2})-?(\d{2})(?:.(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d+)?)?)?)?)?$/;

interface StashedChangelist {
	name: string;
	fileCount: number;
	timestamp: string;
}

export const statusCommand: CliCommand = {
	name: 'status',
	usage: 'git-cl status [-h] [--include-no-cl] [--all] [--no-untracked]\n'
		+ '                     [--no-color]\n'
		+ '                     [CHANGELIST ...]',
	help: `Show file changes grouped by changelist. Unassigned files appear under 'No
Changelist'.

positional arguments:
  CHANGELIST       Optional list of changelists to show (default: all)

options:
  -h, --help       show this help message and exit
  --include-no-cl  When filtering by changelist names, also show files not
                   assigned to any changelist
  --all            Ignored: every Git status code is shown anyway (kept so
                   existing command lines keep working)
  --no-untracked   Hide untracked files (??) from output
  --no-color       Disable colored output`,
	flags: ['include-no-cl', 'all', 'no-untracked', 'no-color'],
	run: showStatus,
};

async function showStatus(repository: Repository, flags: OptionValues, names: string[]): Promise<number> {
	const { gitRoot } = repository;
	const selectedNames = names.length > 0 ? new Set(names) : undefined;
	const changelists = loadChangelists(repository);
	const stashStore = loadStashStore(repository);
	assertNotHidden(names, stashStore);
	const stashes = stashStore.getAll();
	const statusMap = await readStatusMap(gitRoot, flags['no-untracked'] !== true);
	const useColor = shouldUseColor(flags['no-color'] === true);
	const hasStashes = Object.keys(stashes).length > 0;

	const { shownAny, assignedFiles } = showActiveChangelists(changelists, selectedNames, statusMap, gitRoot, useColor);

	if (hasStashes && selectedNames === undefined) {
		if (shownAny) {
			print();
		}
		showStashedChangelists(stashes);
	}

	if (selectedNames === undefined || flags['include-no-cl'] === true) {
		const unassignedFiles = [...statusMap.keys()].filter(file => !assignedFiles.has(file));
		if (unassignedFiles.length > 0) {
			if (shownAny || hasStashes) {
				print();
			}
			print('No Changelist:');
			for (const file of unassignedFiles.sort()) {
				print(formatFileStatus(file, statusMap, gitRoot, useColor));
			}
		}
	}

	const conflictCount = [...statusMap.values()].filter(code => CONFLICT_CODES.has(code)).length;
	if (conflictCount > 0) {
		print();
		print(`Note: ${conflictCount} file(s) with merge conflicts. Resolve before staging, committing, or stashing.`);
	}
	return 0;
}

function loadChangelists({ gitRoot, gitCommonDir }: Repository): Readonly<ChangelistData> {
	const store = new ChangelistStore(gitRoot, gitCommonDir);
	store.load();
	return store.getAll();
}

function loadStashStore({ gitRoot, gitCommonDir }: Repository): StashStore {
	const store = new StashStore(gitRoot, gitCommonDir);
	store.load();
	return store;
}

async function readStatusMap(gitRoot: string, includeUntracked: boolean): Promise<Map<string, string>> {
	let status: ReadonlyMap<string, string>;
	try {
		({ status } = await getGitStatusSnapshot(gitRoot, { untrackedFiles: includeUntracked ? 'all' : 'no' }));
	} catch (error) {
		printError(`Error getting git status: ${error instanceof Error ? error.message : String(error)}`);
		throw new CliExit(1);
	}

	const statusMap = new Map<string, string>();
	for (const [file, code] of status) {
		statusMap.set(statusKey(file, gitRoot), code);
	}
	return statusMap;
}

/** A changelist entry and git status name the same file only once both went through [resolvePath]. */
function statusKey(file: string, gitRoot: string): string {
	return relativeToRoot(resolvePath(path.resolve(gitRoot, file)), gitRoot) ?? file;
}

function showActiveChangelists(
	changelists: Readonly<ChangelistData>,
	selectedNames: ReadonlySet<string> | undefined,
	statusMap: ReadonlyMap<string, string>,
	gitRoot: string,
	useColor: boolean,
): { shownAny: boolean; assignedFiles: Set<string> } {
	const assignedFiles = new Set<string>();
	let shownAny = false;

	for (const [name, files] of Object.entries(changelists)) {
		if (name.endsWith('_stashed')) {
			continue;
		}
		for (const file of files) {
			const absolute = resolvePath(path.resolve(gitRoot, file));
			const rootRelative = relativeToRoot(absolute, gitRoot);
			if (rootRelative === undefined) {
				print(`Error resolving path: '${absolute}' is not in the subpath of '${gitRoot}'`);
			} else {
				assignedFiles.add(rootRelative);
			}
		}
		if (selectedNames !== undefined && !selectedNames.has(name)) {
			continue;
		}
		if (files.length > 0) {
			print(`${name}:`);
			shownAny = true;
			for (const file of files) {
				print(formatFileStatus(file, statusMap, gitRoot, useColor));
			}
		}
	}
	return { shownAny, assignedFiles };
}

function showStashedChangelists(stashes: Readonly<StashData>): void {
	print('Stashed Changelists:');
	const stashed: StashedChangelist[] = Object.entries(stashes).map(([name, metadata]) => ({
		name,
		fileCount: metadata.files.length,
		timestamp: metadata.timestamp,
	}));
	stashed.sort((a, b) => compareCodeUnits(b.timestamp, a.timestamp));
	for (const { name, fileCount, timestamp } of stashed) {
		const fileWord = fileCount === 1 ? 'file' : 'files';
		print(`  ${name} (${fileCount} ${fileWord}, ${formatStashTime(timestamp)})`);
	}
}

function formatStashTime(timestamp: string): string {
	const match = ISO_TIMESTAMP.exec(timestamp);
	if (!match) {
		return 'unknown time';
	}
	const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
	const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
	const isValidDate = date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
	const isValidTime = Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
	if (!isValidDate || !isValidTime) {
		return 'unknown time';
	}
	return `${year}-${month}-${day} ${hour}:${minute}`;
}

function compareCodeUnits(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}
