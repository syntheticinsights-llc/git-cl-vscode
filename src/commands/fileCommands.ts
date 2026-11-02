import * as vscode from 'vscode';
import * as path from 'path';
import { getGitStatus } from '../gitUtils';
import { ChangelistTreeDataProvider } from '../changelistTreeProvider';
import { pickChangelist, resolveFilePathFromArg, resolveFilePaths, resolveFilePathsFromChangelists } from '../commandArgs';

export function registerFileCommands(scmProvider: ChangelistTreeDataProvider, gitRoot: string): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(
			'git-cl.addToChangelist',
			async (...args: unknown[]) => {
				const filePaths = await resolveFilePaths(gitRoot, args);
				if (!filePaths || filePaths.length === 0) {
					return;
				}

				const changelistName = await pickChangelist(scmProvider);
				if (!changelistName) {
					return;
				}

				try {
					const store = scmProvider.getChangelistStore();
					store.addFiles(changelistName, filePaths, scmProvider.getStashStore());
					store.save();
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
				const filePaths = await resolveFilePathsFromChangelists(gitRoot, scmProvider, args);
				if (!filePaths || filePaths.length === 0) {
					return;
				}

				try {
					const store = scmProvider.getChangelistStore();
					for (const filePath of filePaths) {
						const clName = store.findChangelist(filePath);
						if (clName) {
							store.removeFiles(clName, [filePath]);
						}
					}
					store.save();
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
				const filePath = resolveFilePathFromArg(gitRoot, args[0]);
				if (!filePath) {
					return;
				}

				let gitStatusMap: Map<string, string>;
				try {
					gitStatusMap = await getGitStatus(gitRoot);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: Failed to read git status: ${msg}`);
					return;
				}

				const renamedFrom = (args[0] as { renamedFrom?: string } | undefined)?.renamedFrom;
				const status = gitStatusMap.get(filePath);
				const fileUri = vscode.Uri.file(path.join(gitRoot, filePath));
				const isUntracked = status === '??';
				const isDeleted = status !== undefined &&
					(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));

				if (isUntracked) {
					await vscode.commands.executeCommand('vscode.open', fileUri);
				} else if (isDeleted) {
					const headUri = vscode.Uri.from({
						scheme: 'git-cl-head',
						path: `/${filePath}`,
					});
					await vscode.commands.executeCommand('vscode.open', headUri);
				} else {
					const headUri = vscode.Uri.from({
						scheme: 'git-cl-head',
						path: `/${renamedFrom ?? filePath}`,
					});
					await vscode.commands.executeCommand('vscode.diff',
						headUri,
						fileUri,
						renamedFrom
							? `${path.basename(renamedFrom)} → ${path.basename(filePath)} (Working Tree)`
							: `${path.basename(filePath)} (Working Tree)`
					);
				}
			}
		),
	];
}
