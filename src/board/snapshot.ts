import type { BoardData } from '../changelistTreeProvider';
import { buildFileTree, FileTreeFolder } from '../fileTree';
import { groupedRenames, visibleFiles } from '../core/renames';
import { BoardFile, BoardFolder, BoardGroup, BoardSnapshot, FileStatusCode, NO_STATUS } from './protocol';

export interface LineStats {
	additions: number;
	deletions: number;
}

export interface BoardSources extends BoardData {
	lineStats: ReadonlyMap<string, LineStats>;
	branch: string | null;
	/** Mirrors ``scm.compactFolders`` so the board nests folders exactly like Source Control. */
	compactFolders: boolean;
}

const pathCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Turns the provider's cached changelist and git state into what the board
 * draws. Pure on purpose: the webview's layout is judged by reading this
 * output, so it must not depend on when git happened to run.
 */
export function buildBoardSnapshot(sources: BoardSources): BoardSnapshot {
	return {
		branch: sources.branch,
		// Renames only matter where both halves are on disk, which is never true for
		// hidden changelists, so those groups get no rename attribution.
		changelists: Object.entries(sources.changelists).map(([name, files]) =>
			buildGroup(name, files, sources, groupedRenames(sources.renames, files))
		),
		hiddenChangelists: Object.entries(sources.hiddenChangelists).map(([name, files]) =>
			buildGroup(name, files, sources, new Map())
		),
		unassigned: buildGroup('Unassigned', sources.unassigned, sources, groupedRenames(sources.renames, sources.unassigned)),
	};
}

function buildGroup(
	name: string,
	files: readonly string[],
	sources: BoardSources,
	renames: ReadonlyMap<string, string>
): BoardGroup {
	const boardFiles = [...visibleFiles(files, renames)]
		.sort((a, b) => pathCollator.compare(a, b))
		.map(file => buildFile(file, sources, renames.get(file)));
	const byPath = new Map(boardFiles.map(file => [file.path, file]));
	return {
		name,
		files: boardFiles,
		tree: buildFolder(buildFileTree(boardFiles.map(file => file.path), sources.compactFolders), byPath),
		additions: sum(boardFiles, 'additions'),
		deletions: sum(boardFiles, 'deletions'),
	};
}

function buildFolder(folder: FileTreeFolder, files: ReadonlyMap<string, BoardFile>): BoardFolder {
	return {
		path: folder.path,
		name: folder.label,
		folders: folder.folders.map(child => buildFolder(child, files)),
		files: folder.files.flatMap(path => {
			const file = files.get(path);
			return file ? [file] : [];
		}),
	};
}

function buildFile(path: string, sources: BoardSources, renamedFrom: string | undefined): BoardFile {
	const stats = sources.lineStats.get(path);
	return {
		path,
		status: toFileStatus(sources.status.get(path)),
		...(renamedFrom ? { renamedFrom } : {}),
		...(stats ? { additions: stats.additions, deletions: stats.deletions } : {}),
	};
}

function sum(files: readonly BoardFile[], key: 'additions' | 'deletions'): number {
	return files.reduce((total, file) => total + (file[key] ?? 0), 0);
}

/** Collapses git's two-column porcelain code into the one letter the board shows. */
export function toFileStatus(status: string | undefined): FileStatusCode | typeof NO_STATUS {
	if (status === undefined) {
		return NO_STATUS;
	}
	if (status === '??') {
		return 'U';
	}
	const index = status[0];
	const working = status[1];
	if (index === 'U' || working === 'U' || (index === 'A' && working === 'A') || (index === 'D' && working === 'D')) {
		return '!';
	}
	switch (index !== ' ' ? index : working) {
		case 'A':
		case 'C':
			return 'A';
		case 'D':
			return 'D';
		case 'R':
			return 'R';
		default:
			return 'M';
	}
}
