import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ChangelistData, ChangelistStore } from '../core/changelistStore';
import { StashStore } from '../core/stashStore';
import { CliCommand, CliExit, describeFailedCommand, OptionValues, print, Repository } from './command';
import { CONFLICT_CODES, formatFileStatus, relativeToRoot, resolvePath, shouldUseColor } from './fileStatusFormat';

const COMMON_STATUS_CODES: ReadonlySet<string> = new Set([
	'??', ' M', 'M ', 'MM', 'A ', 'AM', ' D', 'D ', 'R ', 'RM',
	...CONFLICT_CODES,
]);

const PYTHON_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

const ISO_TIMESTAMP = /^(\d{4})-?(\d{2})-?(\d{2})(?:.(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d+)?)?)?)?)?$/;

type StashData = Record<string, unknown>;

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
  --all            Include files with uncommon Git status codes
  --no-untracked   Hide untracked files (??) from output
  --no-color       Disable colored output`,
	flags: ['include-no-cl', 'all', 'no-untracked', 'no-color'],
	run: showStatus,
};

function showStatus(repository: Repository, flags: OptionValues, names: string[]): number {
	const { gitRoot } = repository;
	const selectedNames = names.length > 0 ? new Set(names) : undefined;
	const changelists = loadChangelists(repository);
	const stashes = loadStashes(repository);
	const statusMap = readStatusMap(gitRoot, flags.all === true, flags['no-untracked'] !== true);
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

function loadStashes({ gitRoot, gitCommonDir }: Repository): StashData {
	const stashFile = new StashStore(gitRoot, gitCommonDir).getFilePath();
	if (!fs.existsSync(stashFile)) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(stashFile, 'utf-8'));
		return isRecord(parsed) ? parsed : {};
	} catch (error) {
		print(`Error reading stash metadata: ${(error as Error).message}`);
		return {};
	}
}

function readStatusMap(gitRoot: string, showAll: boolean, includeUntracked: boolean): Map<string, string> {
	const command = ['git', 'status', '--porcelain', includeUntracked ? '--untracked-files=all' : '--untracked-files=no'];
	const result = spawnSync(command[0], command.slice(1), {
		encoding: 'utf-8',
		stdio: ['inherit', 'pipe', 'inherit'],
		maxBuffer: 1024 * 1024 * 1024,
	});
	if (result.status !== 0) {
		print(`Error getting git status: ${describeFailedCommand(command, result.status)}`);
		throw new CliExit(1);
	}

	const statusMap = new Map<string, string>();
	let skippedCount = 0;
	for (const line of result.stdout.split(PYTHON_LINE_BREAK)) {
		if (line.length < 4) {
			continue;
		}
		const code = line.slice(0, 2);
		const filePath = statusEntryPath(code, line.slice(3).trim(), gitRoot);
		if (showAll || COMMON_STATUS_CODES.has(code)) {
			statusMap.set(filePath, code);
		} else {
			skippedCount++;
		}
	}

	if (skippedCount > 0) {
		print(`Note: ${skippedCount} file(s) with uncommon Git status codes were not shown. Use 'git cl st --all' to include them.`);
	}
	return statusMap;
}

function statusEntryPath(code: string, rawPath: string, gitRoot: string): string {
	const targetPath = code.startsWith('R') && rawPath.includes('->')
		? rawPath.split('->').pop()!.trim()
		: rawPath;
	return relativeToRoot(resolvePath(path.resolve(gitRoot, targetPath)), gitRoot) ?? targetPath;
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

function showStashedChangelists(stashes: StashData): void {
	print('Stashed Changelists:');
	const stashed = Object.entries(stashes).map(([name, data]) => toStashedChangelist(name, data));
	stashed.sort((a, b) => compareCodeUnits(b.timestamp, a.timestamp));
	for (const { name, fileCount, timestamp } of stashed) {
		const fileWord = fileCount === 1 ? 'file' : 'files';
		print(`  ${name} (${fileCount} ${fileWord}, ${formatStashTime(timestamp)})`);
	}
}

function toStashedChangelist(name: string, data: unknown): StashedChangelist {
	const metadata = isRecord(data) ? data : {};
	const files = metadata.files;
	return {
		name,
		fileCount: Array.isArray(files) || typeof files === 'string' ? files.length : 0,
		timestamp: typeof metadata.timestamp === 'string' ? metadata.timestamp : '',
	};
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
