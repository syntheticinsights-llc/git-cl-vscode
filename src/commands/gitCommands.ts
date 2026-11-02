import * as vscode from 'vscode';
import * as path from 'path';
import { getGitStatus, gitCheckout, gitCommit } from '../core/gitUtils';
import { ChangelistTreeDataProvider } from '../changelistTreeProvider';
import { stageFiles, unstageFiles } from '../builtinGit';
import { pickChangelistForAction, resolveChangelistName } from '../commandArgs';

export function registerGitCommands(scmProvider: ChangelistTreeDataProvider, gitRoot: string): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(
			'git-cl.stageChangelist',
			async (...args: unknown[]) => {
				const changelistName = resolveChangelistName(args);
				const name = changelistName ?? await pickChangelistForAction(scmProvider, 'stage');
				if (!name) {
					return;
				}

				const store = scmProvider.getChangelistStore();
				store.load();
				const files = store.getFiles(name);
				if (files.length === 0) {
					vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
					return;
				}

				// Filter to tracked files only (skip untracked "??" files)
				let gitStatusMap: Map<string, string>;
				try {
					gitStatusMap = await getGitStatus(gitRoot);
				} catch {
					vscode.window.showErrorMessage('git-cl: Failed to read git status.');
					return;
				}

				const trackedFiles = files.filter(f => {
					const status = gitStatusMap.get(f);
					return status !== undefined && status !== '??';
				});

				if (trackedFiles.length === 0) {
					vscode.window.showInformationMessage(
						`git-cl: No tracked files to stage in changelist "${name}".`
					);
					return;
				}

				try {
					await stageFiles(trackedFiles, gitRoot);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: Failed to stage files: ${msg}`);
					return;
				}

				await scmProvider.refresh();
			}
		),
		vscode.commands.registerCommand(
			'git-cl.unstageChangelist',
			async (...args: unknown[]) => {
				const changelistName = resolveChangelistName(args);
				const name = changelistName ?? await pickChangelistForAction(scmProvider, 'unstage');
				if (!name) {
					return;
				}

				const store = scmProvider.getChangelistStore();
				store.load();
				const files = store.getFiles(name);
				if (files.length === 0) {
					vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
					return;
				}

				// Filter to files with staged changes only
				// In git status --porcelain, first char is index status; non-space/non-? means staged
				let gitStatusMap: Map<string, string>;
				try {
					gitStatusMap = await getGitStatus(gitRoot);
				} catch {
					vscode.window.showErrorMessage('git-cl: Failed to read git status.');
					return;
				}

				const stagedFiles = files.filter(f => {
					const status = gitStatusMap.get(f);
					if (!status) {
						return false;
					}
					const indexStatus = status[0];
					return indexStatus !== ' ' && indexStatus !== '?';
				});

				if (stagedFiles.length === 0) {
					vscode.window.showInformationMessage(
						`git-cl: No staged files to unstage in changelist "${name}".`
					);
					return;
				}

				try {
					await unstageFiles(stagedFiles, gitRoot);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: Failed to unstage files: ${msg}`);
					return;
				}

				await scmProvider.refresh();
			}
		),
		vscode.commands.registerCommand(
			'git-cl.commitChangelist',
			async (...args: unknown[]) => {
				const changelistName = resolveChangelistName(args);
				const name = changelistName ?? await pickChangelistForAction(scmProvider, 'commit');
				if (!name) {
					return;
				}

				const store = scmProvider.getChangelistStore();
				store.load();
				const files = store.getFiles(name);
				if (files.length === 0) {
					vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
					return;
				}

				// Filter to tracked files only (skip untracked "??" files)
				let gitStatusMap: Map<string, string>;
				try {
					gitStatusMap = await getGitStatus(gitRoot);
				} catch {
					vscode.window.showErrorMessage('git-cl: Failed to read git status.');
					return;
				}

				const trackedFiles = files.filter(f => {
					const status = gitStatusMap.get(f);
					return status !== undefined && status !== '??';
				});

				if (trackedFiles.length === 0) {
					vscode.window.showErrorMessage(
						`git-cl: No tracked files to commit in changelist "${name}".`
					);
					return;
				}

				// Get commit message via input box
				const input = await vscode.window.showInputBox({
					prompt: `Commit message for changelist "${name}"`,
					placeHolder: 'Enter commit message',
					validateInput: value => {
						if (!value || value.trim().length === 0) {
							return 'Commit message cannot be empty';
						}
						return null;
					},
				});
				if (!input) {
					return;
				}
				const message = input.trim();

				try {
					await gitCommit(trackedFiles, message, gitRoot);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: Commit failed: ${msg}`);
					return;
				}

				// Delete the changelist after commit (default behavior)
				try {
					store.deleteChangelist(name);
					store.save();
				} catch (e: unknown) {
					const saveMsg = e instanceof Error ? e.message : String(e);
					vscode.window.showWarningMessage(`git-cl: Commit succeeded but failed to update changelist data: ${saveMsg}`);
				}

				await scmProvider.refresh();
				vscode.window.showInformationMessage(
					`git-cl: Committed ${trackedFiles.length} file(s) from "${name}".`
				);
			}
		),
		vscode.commands.registerCommand(
			'git-cl.diffChangelist',
			async (...args: unknown[]) => {
				const changelistName = resolveChangelistName(args);
				const name = changelistName ?? await pickChangelistForAction(scmProvider, 'diff');
				if (!name) {
					return;
				}

				const store = scmProvider.getChangelistStore();
				store.load();
				const files = store.getFiles(name);
				if (files.length === 0) {
					vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
					return;
				}

				// Get git status to determine how to diff each file
				let gitStatusMap: Map<string, string>;
				try {
					gitStatusMap = await getGitStatus(gitRoot);
				} catch {
					vscode.window.showErrorMessage('git-cl: Failed to read git status.');
					return;
				}

				// Open diff tabs for each file
				let opened = 0;
				for (const filePath of files) {
					const status = gitStatusMap.get(filePath);
					const fileUri = vscode.Uri.file(path.join(gitRoot, filePath));
					const isUntracked = status === '??';
					const isDeleted = status !== undefined &&
						(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));

					if (isUntracked) {
						// Untracked files have no HEAD version — just open the file
						await vscode.commands.executeCommand('vscode.open', fileUri, {
							preview: false,
						});
					} else if (isDeleted) {
						// Deleted files — show HEAD version (read-only)
						const headUri = vscode.Uri.from({
							scheme: 'git-cl-head',
							path: `/${filePath}`,
						});
						await vscode.commands.executeCommand('vscode.open', headUri, {
							preview: false,
						});
					} else if (status) {
						// Modified/staged files — show diff (HEAD vs working copy)
						const headUri = vscode.Uri.from({
							scheme: 'git-cl-head',
							path: `/${filePath}`,
						});
						await vscode.commands.executeCommand('vscode.diff',
							headUri,
							fileUri,
							`${path.basename(filePath)} (Working Tree)`,
							{ preview: false }
						);
					}
					// Skip files with no git status (clean files)

					opened++;
				}

				if (opened === 0) {
					vscode.window.showInformationMessage(
						`git-cl: No changed files to diff in changelist "${name}".`
					);
				}
			}
		),
		vscode.commands.registerCommand(
			'git-cl.checkoutChangelist',
			async (...args: unknown[]) => {
				const changelistName = resolveChangelistName(args);
				const name = changelistName ?? await pickChangelistForAction(scmProvider, 'revert');
				if (!name) {
					return;
				}

				const store = scmProvider.getChangelistStore();
				store.load();
				const files = store.getFiles(name);
				if (files.length === 0) {
					vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
					return;
				}

				// Confirmation dialog — warns about data loss
				const answer = await vscode.window.showWarningMessage(
					`Revert ${files.length} file(s) in changelist "${name}" to HEAD? This will discard all uncommitted changes and cannot be undone.`,
					{ modal: true },
					'Revert',
					'Revert & Delete Changelist'
				);

				if (!answer) {
					return;
				}

				try {
					await gitCheckout([...files], gitRoot);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: Revert failed: ${msg}`);
					return;
				}

				// Delete the changelist if requested
				if (answer === 'Revert & Delete Changelist') {
					try {
						store.deleteChangelist(name);
						store.save();
					} catch (e: unknown) {
						const saveMsg = e instanceof Error ? e.message : String(e);
						vscode.window.showWarningMessage(`git-cl: Revert succeeded but failed to update changelist data: ${saveMsg}`);
					}
				}

				await scmProvider.refresh();
				vscode.window.showInformationMessage(
					`git-cl: Reverted ${files.length} file(s) in "${name}" to HEAD.`
				);
			}
		),
	];
}
