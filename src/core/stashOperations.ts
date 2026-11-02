import { getCurrentBranch, getGitStatus, gitAdd, gitReset, gitStashDrop, gitStashList, gitStashPop, gitStashPush } from './gitUtils';
import { ChangelistStore } from './changelistStore';
import { withLock } from './lock';
import { FileCategories, StashMetadata, StashStore } from './stashStore';

export interface StashWorkspace {
	readonly changelistStore: ChangelistStore;
	readonly stashStore: StashStore;
	readonly gitRoot: string;
}

export class EmptyChangelistError extends Error {
	constructor(name: string) {
		super(`Changelist "${name}" is empty.`);
		this.name = 'EmptyChangelistError';
	}
}

export interface BranchMismatch {
	readonly sourceBranch: string;
	readonly currentBranch: string;
}

export interface UnstashRisks {
	readonly branchMismatch?: BranchMismatch;
	readonly conflicts: string[];
}

/**
 * Stash a single changelist: categorize files, create git stash,
 * save metadata, and remove from cl.json. Rolls back on failure.
 * Throws EmptyChangelistError when there is nothing in the changelist,
 * and Error for any other failure.
 */
export function stashChangelist(workspace: StashWorkspace, name: string): Promise<void> {
	return withLock(workspace.changelistStore.getGitCommonDir(), () => stashChangelistLocked(workspace, name));
}

async function stashChangelistLocked(workspace: StashWorkspace, name: string): Promise<void> {
	const { changelistStore: store, stashStore, gitRoot } = workspace;
	store.load();
	const files = store.getFiles(name);

	if (files.length === 0) {
		throw new EmptyChangelistError(name);
	}

	let gitStatusMap: Map<string, string>;
	try {
		await prepareIndexForStash(files, await getGitStatus(gitRoot), gitRoot);
		gitStatusMap = await getGitStatus(gitRoot);
	} catch (e: unknown) {
		throw new Error(`Failed to prepare changelist "${name}" for stashing: ${errorMessage(e)}`);
	}

	// Categorize files by status (matching Python git-cl behavior)
	const fileCategories: FileCategories = {
		unstaged_changes: [],
		staged_additions: [],
		untracked: [],
		deleted: [],
	};

	const stashableFiles: string[] = [];

	for (const filePath of files) {
		const status = gitStatusMap.get(filePath);
		if (!status) {
			continue; // clean file — nothing to stash
		}

		stashableFiles.push(filePath);

		if (status === '??') {
			fileCategories.untracked.push(filePath);
		} else if (status[1] === 'D' || (status[0] === 'D' && status[1] === ' ')) {
			fileCategories.deleted.push(filePath);
		} else if (status[0] === 'A') {
			fileCategories.staged_additions.push(filePath);
		} else {
			fileCategories.unstaged_changes.push(filePath);
		}
	}

	if (stashableFiles.length === 0) {
		throw new Error(`No stashable files in changelist "${name}". All files are clean.`);
	}

	// Create stash
	const timestamp = new Date().toISOString();
	const stashMessage = `git-cl-stash:${name}:${timestamp}`;
	const hasUntracked = fileCategories.untracked.length > 0;

	try {
		await gitStashPush(stashMessage, gitRoot, stashableFiles, {
			includeUntracked: hasUntracked,
		});
	} catch (e: unknown) {
		throw new Error(`Failed to stash changelist "${name}": ${errorMessage(e)}`);
	}

	// Stash ref is stash@{0} immediately after creation
	const stashRef = 'stash@{0}';

	const sourceBranch = await getCurrentBranchOrHead(gitRoot);

	// Save stash metadata to cl-stashes.json
	stashStore.load();

	const metadata: StashMetadata = {
		stash_ref: stashRef,
		stash_message: stashMessage,
		files: [...files],
		timestamp,
		source_branch: sourceBranch,
		file_categories: fileCategories,
	};

	try {
		stashStore.setStash(name, metadata);
		stashStore.save();
	} catch (e: unknown) {
		// Rollback: drop the stash we just created
		try { await gitStashDrop(stashRef, gitRoot); } catch { /* best effort */ }
		throw new Error(`Failed to save stash metadata: ${errorMessage(e)}`);
	}

	// Remove changelist from cl.json
	try {
		store.deleteChangelist(name);
		store.save();
	} catch (e: unknown) {
		// Rollback: remove from stash store and pop stash
		try {
			stashStore.removeStash(name);
			stashStore.save();
			await gitStashPop(stashRef, gitRoot);
		} catch { /* best effort */ }
		throw new Error(`Failed to update changelist data: ${errorMessage(e)}`);
	}
}

/**
 * `git stash push -- <paths>` rejects two index states: a staged deletion
 * (the path is in neither index nor working tree) and an intent-to-add entry
 * (`git add -N`). Turn the first into an unstaged deletion and fully stage
 * the second; both changes survive the stash round trip.
 */
async function prepareIndexForStash(files: readonly string[], gitStatusMap: Map<string, string>, gitRoot: string): Promise<void> {
	const stagedDeletions = files.filter(f => gitStatusMap.get(f) === 'D ');
	const intentToAdd = files.filter(f => gitStatusMap.get(f) === ' A');
	await gitReset(stagedDeletions, gitRoot);
	await gitAdd(intentToAdd, gitRoot);
}

/**
 * Check what unstashing would risk: a branch other than the one the
 * changelist was stashed from, and stashed files that are modified in
 * the current working tree.
 */
export async function findUnstashRisks(workspace: StashWorkspace, name: string): Promise<UnstashRisks> {
	const { gitRoot } = workspace;
	const metadata = loadStashMetadata(workspace.stashStore, name);

	const currentBranch = await getCurrentBranchOrHead(gitRoot);
	const branchMismatch = metadata.source_branch !== 'HEAD' && currentBranch !== metadata.source_branch
		? { sourceBranch: metadata.source_branch, currentBranch }
		: undefined;

	let gitStatusMap: Map<string, string>;
	try {
		gitStatusMap = await getGitStatus(gitRoot);
	} catch {
		throw new Error('Failed to read git status.');
	}

	const conflicts = metadata.files.filter(filePath => gitStatusMap.get(filePath));

	return { branchMismatch, conflicts };
}

/**
 * Unstash a single changelist: find stash ref, pop stash, and restore
 * changelist to cl.json. Performs no branch or conflict checks.
 */
export function unstashChangelist(workspace: StashWorkspace, name: string): Promise<void> {
	return withLock(workspace.changelistStore.getGitCommonDir(), () => unstashChangelistLocked(workspace, name));
}

async function unstashChangelistLocked(workspace: StashWorkspace, name: string): Promise<void> {
	const { changelistStore: store, stashStore, gitRoot } = workspace;
	const metadata = loadStashMetadata(stashStore, name);

	// Find the correct stash ref by matching the stash message
	const stashRef = await findStashRefByMessage(metadata.stash_message, gitRoot);
	if (!stashRef) {
		throw new Error(`Could not find git stash for changelist "${name}". The stash may have been manually dropped.`);
	}

	// Pop the stash
	try {
		await gitStashPop(stashRef, gitRoot);
	} catch (e: unknown) {
		throw new Error(`Failed to unstash changelist "${name}": ${errorMessage(e)}`);
	}

	// Remove from stash store first (so addFiles does not reject the changelist as hidden)
	try {
		stashStore.removeStash(name);
		stashStore.save();
	} catch (e: unknown) {
		throw new Error(`Failed to update stash metadata: ${errorMessage(e)}`);
	}

	// Restore changelist to cl.json
	store.load();

	try {
		store.addFiles(name, metadata.files, stashStore);
		store.save();
	} catch (e: unknown) {
		// Rollback: restore stash metadata
		try {
			stashStore.setStash(name, metadata);
			stashStore.save();
		} catch { /* best effort */ }
		throw new Error(`Failed to restore changelist data: ${errorMessage(e)}`);
	}
}

function loadStashMetadata(stashStore: StashStore, name: string): StashMetadata {
	stashStore.load();
	const metadata = stashStore.getStash(name);
	if (!metadata) {
		throw new Error(`No stash found for changelist "${name}".`);
	}
	return metadata;
}

/**
 * Find the actual stash reference by matching the stash message.
 * Stash indices shift when stashes are created/dropped, so we search
 * by the unique message stored in metadata.
 */
async function findStashRefByMessage(
	stashMessage: string,
	gitRoot: string
): Promise<string | undefined> {
	const entries = await gitStashList(gitRoot);
	for (const entry of entries) {
		if (entry.message.includes(stashMessage)) {
			return entry.ref;
		}
	}
	return undefined;
}

async function getCurrentBranchOrHead(gitRoot: string): Promise<string> {
	try {
		return await getCurrentBranch(gitRoot) ?? 'HEAD';
	} catch {
		return 'HEAD';
	}
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
