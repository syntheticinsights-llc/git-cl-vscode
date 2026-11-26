import { ChangelistStore } from '../core/changelistStore';
import { getCurrentBranch, getGitStatusSnapshot, getWorkingTreeLineStats } from '../core/gitUtils';
import { StashStore } from '../core/stashStore';
import { unassignedFiles } from '../core/unassigned';
import { getUntrackedLineStats } from '../core/untrackedStats';
import type { RepoRef } from '../workspaceRepos';
import { BoardSnapshot } from './protocol';
import { buildBoardSnapshot } from './snapshot';

/** Changlist data for one repository, reloaded from disk on every read. */
export function changelistStoreFor(repo: RepoRef): ChangelistStore {
	return new ChangelistStore(repo.root, repo.commonDir);
}

/**
 * Reads everything the board draws for one repository. Nothing is cached: a
 * switch between repositories, a webview that VS Code reloaded, or a CLI write
 * elsewhere all show up on the next read.
 */
export async function readBoardSnapshot(repo: RepoRef, compactFolders: boolean): Promise<BoardSnapshot> {
	const store = changelistStoreFor(repo);
	store.load();
	const stashStore = new StashStore(repo.root, repo.commonDir);
	stashStore.load();

	const { status, renames } = await getGitStatusSnapshot(repo.root);
	const changelists = store.getAll();
	const hiddenChangelists = Object.fromEntries(
		Object.entries(stashStore.getAll()).map(([name, metadata]) => [name, metadata.files])
	);
	const assigned = new Set(Object.values(changelists).flat());
	const unassigned = unassignedFiles(status.keys(), assigned, stashStore.getStashedFiles());

	const files = [
		...Object.values(changelists).flat(),
		...Object.values(hiddenChangelists).flat(),
		...unassigned,
	];
	const untracked = files.filter(file => status.get(file) === '??');
	const [trackedStats, untrackedStats, branch] = await Promise.all([
		getWorkingTreeLineStats(repo.root),
		getUntrackedLineStats(repo.root, untracked),
		getCurrentBranch(repo.root),
	]);

	return buildBoardSnapshot({
		changelists,
		hiddenChangelists,
		unassigned,
		status,
		renames,
		lineStats: new Map([...trackedStats, ...untrackedStats]),
		branch,
		compactFolders,
	});
}
