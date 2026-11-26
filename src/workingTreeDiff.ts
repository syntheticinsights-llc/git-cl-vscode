import * as path from 'path';
import * as vscode from 'vscode';
import { getGitStatus } from './core/gitUtils';

/** How a file differs from HEAD, when the caller already knows. */
export type WorkingTreeFileState = 'untracked' | 'added' | 'deleted' | 'changed';

export interface OpenWorkingTreeDiffOptions {
	/** Editor group to open into; omitted means "wherever VS Code puts it". */
	viewColumn?: vscode.ViewColumn;
	/** Reuse one preview tab instead of piling up tabs. */
	preview?: boolean;
	/** Keep focus where it is, so the diff can follow a file list being clicked through. */
	preserveFocus?: boolean;
	/**
	 * Skips the `git status` this would otherwise run: the board already has the
	 * state in its last snapshot, and a run per click is what makes clicking
	 * through files feel slow.
	 */
	state?: WorkingTreeFileState;
}

/**
 * Shows what a file in a changelist looks like against HEAD: untracked files
 * as themselves, deleted files as their HEAD content, everything else as a
 * diff. Shared by the Source Control tree and the changelist board.
 */
export async function openWorkingTreeDiff(
	gitRoot: string,
	filePath: string,
	renamedFrom?: string,
	{ viewColumn, preview = false, preserveFocus = false, state }: OpenWorkingTreeDiffOptions = {}
): Promise<void> {
	const fileState = state ?? stateOf((await getGitStatus(gitRoot)).get(filePath));
	const showOptions: vscode.TextDocumentShowOptions = { viewColumn, preview, preserveFocus };
	const fileUri = vscode.Uri.file(path.join(gitRoot, filePath));

	if (fileState === 'untracked') {
		await vscode.commands.executeCommand('vscode.open', fileUri, showOptions);
		return;
	}

	const headUri = vscode.Uri.from({
		scheme: 'git-cl-head',
		path: `/${renamedFrom ?? filePath}`,
		query: encodeURIComponent(gitRoot),
		...(fileState === 'added' ? { fragment: 'empty' } : {}),
	});
	if (fileState === 'deleted') {
		await vscode.commands.executeCommand('vscode.open', headUri, showOptions);
		return;
	}

	await vscode.commands.executeCommand(
		'vscode.diff',
		headUri,
		fileUri,
		diffTitle(filePath, renamedFrom),
		showOptions
	);
}

function stateOf(status: string | undefined): WorkingTreeFileState {
	if (status === '??') {
		return 'untracked';
	}
	if (status !== undefined && (status[1] === 'D' || (status[0] === 'D' && status[1] === ' '))) {
		return 'deleted';
	}
	return 'changed';
}

function diffTitle(filePath: string, renamedFrom: string | undefined): string {
	return renamedFrom
		? `${path.basename(renamedFrom)} → ${path.basename(filePath)} (Working Tree)`
		: `${path.basename(filePath)} (Working Tree)`;
}
