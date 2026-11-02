import * as vscode from 'vscode';
import { ChangelistTreeDataProvider } from './changelistTreeProvider';
import { EmptyChangelistError, findUnstashRisks, stashChangelist, StashWorkspace, unstashChangelist, UnstashRisks } from './core/stashOperations';

function stashWorkspace(scmProvider: ChangelistTreeDataProvider, gitRoot: string): StashWorkspace {
	return {
		changelistStore: scmProvider.getChangelistStore(),
		stashStore: scmProvider.getStashStore(),
		gitRoot,
	};
}

/**
 * Stash a single changelist, showing any failure to the user.
 * Returns true on success.
 */
export async function stashSingleChangelist(
	scmProvider: ChangelistTreeDataProvider,
	name: string,
	gitRoot: string
): Promise<boolean> {
	try {
		await stashChangelist(stashWorkspace(scmProvider, gitRoot), name);
		return true;
	} catch (e: unknown) {
		if (e instanceof EmptyChangelistError) {
			vscode.window.showInformationMessage(`git-cl: ${e.message}`);
		} else {
			vscode.window.showErrorMessage(`git-cl: ${e instanceof Error ? e.message : String(e)}`);
		}
		return false;
	}
}

/**
 * Unstash a single changelist, showing any failure to the user.
 * Unless force is true, asks before unstashing onto another branch or
 * over conflicting working tree changes. Returns true on success.
 */
export async function unstashSingleChangelist(
	scmProvider: ChangelistTreeDataProvider,
	name: string,
	gitRoot: string,
	force: boolean
): Promise<boolean> {
	const workspace = stashWorkspace(scmProvider, gitRoot);
	try {
		if (!force && !await confirmUnstashRisks(name, await findUnstashRisks(workspace, name))) {
			return false;
		}
		await unstashChangelist(workspace, name);
		return true;
	} catch (e: unknown) {
		vscode.window.showErrorMessage(`git-cl: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

async function confirmUnstashRisks(name: string, risks: UnstashRisks): Promise<boolean> {
	const { branchMismatch, conflicts } = risks;
	if (branchMismatch) {
		const answer = await vscode.window.showWarningMessage(
			`Changelist "${name}" was stashed from branch "${branchMismatch.sourceBranch}", but you are on "${branchMismatch.currentBranch}". Unstash anyway?`,
			{ modal: true },
			'Unstash Anyway',
			'Cancel'
		);
		if (answer !== 'Unstash Anyway') {
			return false;
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

	return true;
}
