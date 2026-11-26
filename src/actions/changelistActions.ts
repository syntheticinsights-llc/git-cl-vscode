import * as vscode from 'vscode';
import { ChangelistStore } from '../core/changelistStore';
import { getGitStatus, gitCommit } from '../core/gitUtils';
import { stageFiles } from '../host/builtinGit';

/** One repository plus the changelist data that belongs to it. */
export interface ChangelistTarget {
	gitRoot: string;
	store: ChangelistStore;
	/** Lets the caller redraw whatever it shows after data or the index changed. */
	onChanged?: () => Promise<void> | void;
}

/**
 * Stages every changed file in a changelist, including untracked (`??`) files.
 */
export async function stageChangelist(target: ChangelistTarget, name: string): Promise<boolean> {
	const files = target.store.getFiles(name);
	if (files.length === 0) {
		vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
		return false;
	}

	let status: Map<string, string>;
	try {
		status = await getGitStatus(target.gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return false;
	}

	const changed = files.filter(file => status.get(file) !== undefined);
	if (changed.length === 0) {
		vscode.window.showInformationMessage(`git-cl: No changed files to stage in changelist "${name}".`);
		return false;
	}

	try {
		await stageFiles(changed, target.gitRoot);
	} catch (error: unknown) {
		vscode.window.showErrorMessage(`git-cl: Failed to stage files: ${messageOf(error)}`);
		return false;
	}

	await target.onChanged?.();
	return true;
}

/**
 * Commits every changed file in one changelist (including untracked files) and
 * then disbands it. Prompts the user for a commit message when none is provided.
 */
export async function commitChangelist(
	target: ChangelistTarget,
	name: string,
	message?: string
): Promise<boolean> {
	const files = target.store.getFiles(name);
	if (files.length === 0) {
		vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
		return false;
	}

	let status: Map<string, string>;
	try {
		status = await getGitStatus(target.gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return false;
	}

	const changed = files.filter(file => status.get(file) !== undefined);
	if (changed.length === 0) {
		vscode.window.showErrorMessage(`git-cl: No changed files to commit in changelist "${name}".`);
		return false;
	}

	const commitMessage = message ?? await askForMessage(name);
	if (!commitMessage) {
		return false;
	}

	try {
		await gitCommit(changed, commitMessage, target.gitRoot);
	} catch (error: unknown) {
		vscode.window.showErrorMessage(`git-cl: Commit failed: ${messageOf(error)}`);
		return false;
	}

	try {
		await target.store.update(store => store.deleteChangelist(name));
	} catch (error: unknown) {
		vscode.window.showWarningMessage(
			`git-cl: Commit succeeded but failed to update changelist data: ${messageOf(error)}`
		);
	}

	await target.onChanged?.();
	vscode.window.showInformationMessage(`git-cl: Committed ${changed.length} file(s) from "${name}".`);
	return true;
}

async function askForMessage(name: string): Promise<string | undefined> {
	const input = await vscode.window.showInputBox({
		prompt: `Commit message for changelist "${name}"`,
		placeHolder: 'Enter commit message',
		validateInput: value => (value.trim().length === 0 ? 'Commit message cannot be empty' : null),
	});
	return input?.trim() || undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
