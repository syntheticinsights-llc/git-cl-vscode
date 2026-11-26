import * as vscode from 'vscode';
import * as path from 'path';
import { commitChangelist, stageChangelist } from '../actions/changelistActions';
import { getGitStatus, gitCheckout } from '../core/gitUtils';
import { unstageFiles } from '../host/builtinGit';
import { ChangelistWorkspace } from '../views/changelistWorkspace';
import { pickChangelistForAction, resolveChangelistName } from './commandArgs';

export function registerGitCommands(workspace: ChangelistWorkspace): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(
			'git-cl.stageChangelist',
			async (...args: unknown[]) => {
				const gitRoot = workspace.getGitRoot();
				const name = resolveChangelistName(args) ?? await pickChangelistForAction(workspace, 'stage');
				if (!name) {
					return;
				}

				const store = workspace.getChangelistStore();
				store.load();
				await stageChangelist({
					gitRoot,
					store,
					onChanged: () => workspace.refresh(),
				}, name);
			}
		),
		vscode.commands.registerCommand(
			'git-cl.unstageChangelist',
			async (...args: unknown[]) => {
				const gitRoot = workspace.getGitRoot();
				const name = resolveChangelistName(args) ?? await pickChangelistForAction(workspace, 'unstage');
				if (!name) {
					return;
				}

				const store = workspace.getChangelistStore();
				store.load();
				const files = store.getFiles(name);
				if (files.length === 0) {
					vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
					return;
				}

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

				await workspace.refresh();
			}
		),
		vscode.commands.registerCommand(
			'git-cl.commitChangelist',
			async (...args: unknown[]) => {
				const gitRoot = workspace.getGitRoot();
				const name = resolveChangelistName(args) ?? await pickChangelistForAction(workspace, 'commit');
				if (!name) {
					return;
				}
				const store = workspace.getChangelistStore();
				store.load();
				await commitChangelist({
					gitRoot,
					store,
					onChanged: async () => {
						workspace.reloadHeadDocuments();
						await workspace.refresh();
					},
				}, name);
			}
		),
		vscode.commands.registerCommand(
			'git-cl.diffChangelist',
			async (...args: unknown[]) => {
				const gitRoot = workspace.getGitRoot();
				const name = resolveChangelistName(args) ?? await pickChangelistForAction(workspace, 'diff');
				if (!name) {
					return;
				}

				const store = workspace.getChangelistStore();
				store.load();
				const files = store.getFiles(name);
				if (files.length === 0) {
					vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
					return;
				}

				let gitStatusMap: Map<string, string>;
				try {
					gitStatusMap = await getGitStatus(gitRoot);
				} catch {
					vscode.window.showErrorMessage('git-cl: Failed to read git status.');
					return;
				}

				let opened = 0;
				for (const filePath of files) {
					const status = gitStatusMap.get(filePath);
					const fileUri = vscode.Uri.file(path.join(gitRoot, filePath));
					const isUntracked = status === '??';
					const isDeleted = status !== undefined &&
						(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));

					if (isUntracked) {
						await vscode.commands.executeCommand('vscode.open', fileUri, {
							preview: false,
						});
					} else if (isDeleted) {
						const headUri = vscode.Uri.from({
							scheme: 'git-cl-head',
							path: `/${filePath}`,
							query: encodeURIComponent(gitRoot),
						});
						await vscode.commands.executeCommand('vscode.open', headUri, {
							preview: false,
						});
					} else if (status) {
						const headUri = vscode.Uri.from({
							scheme: 'git-cl-head',
							path: `/${filePath}`,
							query: encodeURIComponent(gitRoot),
						});
						await vscode.commands.executeCommand('vscode.diff',
							headUri,
							fileUri,
							`${path.basename(filePath)} (Working Tree)`,
							{ preview: false }
						);
					}

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
				const gitRoot = workspace.getGitRoot();
				const name = resolveChangelistName(args) ?? await pickChangelistForAction(workspace, 'revert');
				if (!name) {
					return;
				}

				const store = workspace.getChangelistStore();
				store.load();
				const files = store.getFiles(name);
				if (files.length === 0) {
					vscode.window.showInformationMessage(`git-cl: Changelist "${name}" is empty.`);
					return;
				}

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

				if (answer === 'Revert & Delete Changelist') {
					try {
						await store.update(s => s.deleteChangelist(name));
					} catch (e: unknown) {
						const saveMsg = e instanceof Error ? e.message : String(e);
						vscode.window.showWarningMessage(`git-cl: Revert succeeded but failed to update changelist data: ${saveMsg}`);
					}
				}

				await workspace.refresh();
				vscode.window.showInformationMessage(
					`git-cl: Reverted ${files.length} file(s) in "${name}" to HEAD.`
				);
			}
		),
	];
}
