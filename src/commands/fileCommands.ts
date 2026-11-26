import * as vscode from 'vscode';
import { openWorkingTreeDiff } from '../host/workingTreeDiff';
import { ChangelistWorkspace } from '../views/changelistWorkspace';
import { pickChangelist, resolveFilePathFromArg, resolveFilePaths, resolveFilePathsFromChangelists } from './commandArgs';

export function registerFileCommands(
	workspace: ChangelistWorkspace,
	ensureRepoForUri?: (uri: vscode.Uri) => Promise<void>
): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(
			'git-cl.addToChangelist',
			async (...args: unknown[]) => {
				const resourceUri = firstResourceUri(args);
				if (resourceUri && ensureRepoForUri) {
					await ensureRepoForUri(resourceUri);
				}
				const gitRoot = workspace.getGitRoot();
				const filePaths = await resolveFilePaths(gitRoot, args);
				if (!filePaths || filePaths.length === 0) {
					return;
				}

				const changelistName = await pickChangelist(workspace);
				if (!changelistName) {
					return;
				}

				await workspace.assignFiles(changelistName, filePaths);
			}
		),
		vscode.commands.registerCommand(
			'git-cl.removeFromChangelist',
			async (...args: unknown[]) => {
				const gitRoot = workspace.getGitRoot();
				const filePaths = await resolveFilePathsFromChangelists(gitRoot, workspace, args);
				if (!filePaths || filePaths.length === 0) {
					return;
				}

				try {
					await workspace.removeFiles(filePaths);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: ${msg}`);
				}
			}
		),
		vscode.commands.registerCommand(
			'git-cl.openFileDiff',
			async (...args: unknown[]) => {
				const gitRoot = workspace.getGitRoot();
				const filePath = resolveFilePathFromArg(gitRoot, args[0]);
				if (!filePath) {
					return;
				}

				const renamedFrom = (args[0] as { renamedFrom?: string } | undefined)?.renamedFrom;
				const preview = Boolean((args[1] as { preview?: boolean } | undefined)?.preview);
				const state = workspace.getFileDiffState(filePath, renamedFrom);
				try {
					await openWorkingTreeDiff(gitRoot, filePath, renamedFrom, { preview, state });
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: Failed to open diff: ${msg}`);
				}
			}
		),
	];
}

function firstResourceUri(args: unknown[]): vscode.Uri | undefined {
	const candidate = args.length >= 2 && Array.isArray(args[1]) ? args[1][0] : args[0];
	if (candidate && typeof candidate === 'object' && 'resourceUri' in candidate) {
		return (candidate as vscode.SourceControlResourceState).resourceUri;
	}
	return undefined;
}
