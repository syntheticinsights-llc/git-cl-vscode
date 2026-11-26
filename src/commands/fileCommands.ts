import * as vscode from 'vscode';
import { ChangelistTreeDataProvider } from '../changelistTreeProvider';
import { pickChangelist, resolveFilePathFromArg, resolveFilePaths, resolveFilePathsFromChangelists } from '../commandArgs';
import { openWorkingTreeDiff } from '../workingTreeDiff';

export function registerFileCommands(
	scmProvider: ChangelistTreeDataProvider,
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
				const gitRoot = scmProvider.getGitRoot();
				const filePaths = await resolveFilePaths(gitRoot, args);
				if (!filePaths || filePaths.length === 0) {
					return;
				}

				const changelistName = await pickChangelist(scmProvider);
				if (!changelistName) {
					return;
				}

				try {
					await scmProvider.getChangelistStore().addFilesLocked(changelistName, filePaths, scmProvider.getStashStore());
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: ${msg}`);
					return;
				}

				await scmProvider.refresh();
			}
		),
		vscode.commands.registerCommand(
			'git-cl.removeFromChangelist',
			async (...args: unknown[]) => {
				const gitRoot = scmProvider.getGitRoot();
				const filePaths = await resolveFilePathsFromChangelists(gitRoot, scmProvider, args);
				if (!filePaths || filePaths.length === 0) {
					return;
				}

				try {
					await scmProvider.getChangelistStore().update(store => {
						for (const filePath of filePaths) {
							const clName = store.findChangelist(filePath);
							if (clName) {
								store.removeFiles(clName, [filePath]);
							}
						}
					});
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: ${msg}`);
					return;
				}

				await scmProvider.refresh();
			}
		),
		vscode.commands.registerCommand(
			'git-cl.openFileDiff',
			async (...args: unknown[]) => {
				const gitRoot = scmProvider.getGitRoot();
				const filePath = resolveFilePathFromArg(gitRoot, args[0]);
				if (!filePath) {
					return;
				}

				const renamedFrom = (args[0] as { renamedFrom?: string } | undefined)?.renamedFrom;
				try {
					await openWorkingTreeDiff(gitRoot, filePath, renamedFrom);
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
