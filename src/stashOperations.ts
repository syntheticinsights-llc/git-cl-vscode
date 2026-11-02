import * as vscode from 'vscode';
import { getCurrentBranch, getGitStatus, gitAdd, gitReset, gitStashDrop, gitStashList, gitStashPop, gitStashPush } from './gitUtils';
import { ChangelistTreeDataProvider } from './changelistTreeProvider';
import { FileCategories, StashMetadata } from './stashStore';

/**
 * Stash a single changelist: categorize files, create git stash,
 * save metadata, and remove from cl.json. Rolls back on failure.
 * Returns true on success, false on failure (with error shown to user).
 */
export async function stashSingleChangelist(
	scmProvider: ChangelistTreeDataProvider,
	name: string,
	gitRoot: string
): Promise<boolean> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const files = store.getFiles(name);

	if (files.length === 0) {
		vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
		return false;
	}

	let gitStatusMap: Map<string, string>;
	try {
		await prepareIndexForStash(files, await getGitStatus(gitRoot), gitRoot);
		gitStatusMap = await getGitStatus(gitRoot);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to prepare changelist "${name}" for stashing: ${msg}`);
		return false;
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
		vscode.window.showErrorMessage(
			`git-cl: No stashable files in changelist "${name}". All files are clean.`
		);
		return false;
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
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to stash changelist "${name}": ${msg}`);
		return false;
	}

	// Stash ref is stash@{0} immediately after creation
	const stashRef = 'stash@{0}';

	// Get current branch for metadata
	let sourceBranch: string;
	try {
		sourceBranch = await getCurrentBranch(gitRoot) ?? 'HEAD';
	} catch {
		sourceBranch = 'HEAD';
	}

	// Save stash metadata to cl-stashes.json
	const stashStore = scmProvider.getStashStore();
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
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to save stash metadata: ${msg}`);
		return false;
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
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to update changelist data: ${msg}`);
		return false;
	}

	return true;
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

/**
 * Unstash a single changelist: validate branch/conflicts, find stash ref,
 * pop stash, and restore changelist to cl.json.
 * If force is true, skip branch and conflict checks.
 * Returns true on success, false on failure (with error shown to user).
 */
export async function unstashSingleChangelist(
	scmProvider: ChangelistTreeDataProvider,
	name: string,
	gitRoot: string,
	force: boolean
): Promise<boolean> {
	const stashStore = scmProvider.getStashStore();
	stashStore.load();
	const metadata = stashStore.getStash(name);

	if (!metadata) {
		vscode.window.showErrorMessage(`git-cl: No stash found for changelist "${name}".`);
		return false;
	}

	if (!force) {
		// Branch validation: warn if current branch differs from source branch
		let currentBranch: string;
		try {
			currentBranch = await getCurrentBranch(gitRoot) ?? 'HEAD';
		} catch {
			currentBranch = 'HEAD';
		}

		if (metadata.source_branch !== 'HEAD' && currentBranch !== metadata.source_branch) {
			const answer = await vscode.window.showWarningMessage(
				`Changelist "${name}" was stashed from branch "${metadata.source_branch}", but you are on "${currentBranch}". Unstash anyway?`,
				{ modal: true },
				'Unstash Anyway',
				'Cancel'
			);
			if (answer !== 'Unstash Anyway') {
				return false;
			}
		}

		// Conflict detection: check if stashed files conflict with current working tree
		let gitStatusMap: Map<string, string>;
		try {
			gitStatusMap = await getGitStatus(gitRoot);
		} catch {
			vscode.window.showErrorMessage('git-cl: Failed to read git status.');
			return false;
		}

		const conflicts: string[] = [];
		for (const filePath of metadata.files) {
			const status = gitStatusMap.get(filePath);
			if (status) {
				conflicts.push(filePath);
			}
		}

		if (conflicts.length > 0) {
			const suggestions = [
				'Commit the conflicting files',
				'Stash the conflicting files',
				'Discard changes to the conflicting files',
			];
			const answer = await vscode.window.showWarningMessage(
				`${conflicts.length} file(s) in stashed changelist "${name}" conflict with your working tree:\n${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? '...' : ''}\n\nSuggestions: ${suggestions.join('; ')}.`,
				{ modal: true },
				'Unstash Anyway',
				'Cancel'
			);
			if (answer !== 'Unstash Anyway') {
				return false;
			}
		}
	}

	// Find the correct stash ref by matching the stash message
	const stashRef = await findStashRefByMessage(metadata.stash_message, gitRoot);
	if (!stashRef) {
		vscode.window.showErrorMessage(
			`git-cl: Could not find git stash for changelist "${name}". The stash may have been manually dropped.`
		);
		return false;
	}

	// Pop the stash
	try {
		await gitStashPop(stashRef, gitRoot);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to unstash changelist "${name}": ${msg}`);
		return false;
	}

	// Remove from stash store first (so addFiles won't reject stashed file conflicts)
	try {
		stashStore.removeStash(name);
		stashStore.save();
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to update stash metadata: ${msg}`);
		return false;
	}

	// Restore changelist to cl.json
	const store = scmProvider.getChangelistStore();
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
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: Failed to restore changelist data: ${msg}`);
		return false;
	}

	return true;
}
