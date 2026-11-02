import * as vscode from 'vscode';
import * as path from 'path';
import { getGitRoot, getGitCommonDir, getGitStatus, gitCommit, gitCheckout, getCurrentBranch, gitCheckoutBranch, gitBranchExists, gitCheckoutExistingBranch } from './gitUtils';
import { ChangelistTreeDataProvider } from './changelistTreeProvider';
import { ViewMode } from './fileTree';
import { stageFiles, unstageFiles } from './builtinGit';
import { renderReviewPrompt } from './reviewPrompt';
import { editReviewTemplate, readReviewTemplate } from './reviewTemplate';
import { pickChangelist, pickChangelistForAction, pickStashedChangelistForAction, resolveChangelistName, resolveFilePathFromArg, resolveFilePaths, resolveFilePathsFromChangelists, resolveStashName } from './commandArgs';
import { showFormattedStatus } from './statusReport';
import { stashSingleChangelist, unstashSingleChangelist } from './stashOperations';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const outputChannel = vscode.window.createOutputChannel('git-cl');
	context.subscriptions.push(outputChannel);

	// Find git root from first workspace folder
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		outputChannel.appendLine('git-cl: No workspace folder found.');
		return;
	}

	let gitRoot: string;
	try {
		gitRoot = await getGitRoot(workspaceFolder.uri.fsPath);
	} catch {
		outputChannel.appendLine('git-cl: Not a git repository.');
		return;
	}

	// Resolve the common git dir (handles worktrees where .git is a file, not a directory)
	let gitCommonDir: string;
	try {
		gitCommonDir = await getGitCommonDir(workspaceFolder.uri.fsPath);
	} catch {
		gitCommonDir = path.join(gitRoot, '.git');
	}

	// Initialize TreeView provider (changelists section in Source Control sidebar)
	vscode.commands.executeCommand('setContext', 'git-cl:hasGitRoot', true);
	const scmProvider = new ChangelistTreeDataProvider(gitRoot, outputChannel, gitCommonDir);
	const treeView = vscode.window.createTreeView('git-cl.changelists', {
		treeDataProvider: scmProvider,
		dragAndDropController: scmProvider,
		showCollapseAll: true,
		canSelectMany: true,
	});
	context.subscriptions.push(scmProvider, treeView);

	const setViewMode = (mode: ViewMode) =>
		vscode.workspace.getConfiguration('git-cl').update('viewMode', mode, vscode.ConfigurationTarget.Global);
	context.subscriptions.push(
		vscode.commands.registerCommand('git-cl.viewAsTree', () => setViewMode('tree')),
		vscode.commands.registerCommand('git-cl.viewAsList', () => setViewMode('list')),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('git-cl.pruneChangelist', async (...args: unknown[]) => {
			const name = resolveChangelistName(args) ?? await pickChangelistForAction(scmProvider, 'prune');
			if (name) {
				await pruneChangelists(scmProvider, gitRoot, [name]);
			}
		}),
		vscode.commands.registerCommand('git-cl.pruneAllChangelists', async () => {
			await pruneChangelists(scmProvider, gitRoot);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('git-cl.copyFromChangelist', async (...args: unknown[]) => {
			const name = resolveChangelistName(args) ?? await pickChangelistForAction(scmProvider, 'copy from');
			if (name) {
				await pickAndCopyFromChangelist(scmProvider, gitRoot, name);
			}
		}),
		vscode.commands.registerCommand('git-cl.editReviewTemplate', () => editReviewTemplate(gitRoot)),
	);

	const statusCmd = vscode.commands.registerCommand('git-cl.showStatus', async () => {
		await showFormattedStatus(outputChannel, scmProvider, gitRoot);
	});

	const addToChangelistCmd = vscode.commands.registerCommand(
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
	);

	const removeFromChangelistCmd = vscode.commands.registerCommand(
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
	);

	const openFileDiffCmd = vscode.commands.registerCommand(
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
	);

	const deleteChangelistCmd = vscode.commands.registerCommand(
		'git-cl.deleteChangelist',
		async (...args: unknown[]) => {
			const name = resolveChangelistName(args) ?? resolveStashName(args) ?? await pickChangelistForAction(scmProvider, 'disband');
			if (name) {
				await disbandChangelistWithConfirmation(scmProvider, gitRoot, name);
			}
		}
	);

	const deleteAllChangelistsCmd = vscode.commands.registerCommand(
		'git-cl.deleteAllChangelists',
		async () => {
			const store = scmProvider.getChangelistStore();
			store.load();
			const stashStore = scmProvider.getStashStore();
			stashStore.load();
			const names = store.getNames();
			const hiddenNames = stashStore.getNames();

			if (names.length + hiddenNames.length === 0) {
				vscode.window.showInformationMessage('git-cl: No changelists to disband.');
				return;
			}

			const totalFiles = names.reduce((sum, name) => sum + store.getFiles(name).length, 0) +
				hiddenNames.reduce((sum, name) => sum + (stashStore.getStash(name)?.files.length ?? 0), 0);
			const hiddenNote = hiddenNames.length > 0 ? ' Hidden changes will be shown again first.' : '';

			const message = totalFiles > 0
				? `Disband all ${names.length + hiddenNames.length} changelist(s)? ${totalFiles} file(s) will be moved to Unassigned.${hiddenNote}`
				: `Disband all ${names.length} empty changelist(s)?`;

			const answer = await vscode.window.showWarningMessage(
				message,
				{ modal: true },
				'Disband All'
			);

			if (answer !== 'Disband All') {
				return;
			}

			for (const name of hiddenNames) {
				await unstashSingleChangelist(scmProvider, name, gitRoot, false);
			}

			store.load();
			try {
				store.deleteAll();
				store.save();
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: ${msg}`);
				return;
			}

			await scmProvider.refresh();
		}
	);

	const stageChangelistCmd = vscode.commands.registerCommand(
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
	);

	const unstageChangelistCmd = vscode.commands.registerCommand(
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
	);

	const commitChangelistCmd = vscode.commands.registerCommand(
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
	);

	const diffChangelistCmd = vscode.commands.registerCommand(
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
	);

	const checkoutChangelistCmd = vscode.commands.registerCommand(
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
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('git-cl.hideChangelist', async (...args: unknown[]) => {
			const name = resolveChangelistName(args) ?? await pickChangelistForAction(scmProvider, 'hide');
			if (name && await stashSingleChangelist(scmProvider, name, gitRoot)) {
				await scmProvider.refresh();
			}
		}),
		vscode.commands.registerCommand('git-cl.showChangelist', async (...args: unknown[]) => {
			const name = resolveStashName(args) ?? await pickStashedChangelistForAction(scmProvider, 'show');
			if (name && await unstashSingleChangelist(scmProvider, name, gitRoot, false)) {
				await scmProvider.refresh();
			}
		}),
	);

	const stashAllChangelistsCmd = vscode.commands.registerCommand(
		'git-cl.stashAllChangelists',
		async () => {
			const store = scmProvider.getChangelistStore();
			store.load();
			const names = [...store.getNames()];

			if (names.length === 0) {
				vscode.window.showInformationMessage('git-cl: No changelists to stash.');
				return;
			}

			let stashedCount = 0;
			for (const name of names) {
				const success = await stashSingleChangelist(scmProvider, name, gitRoot);
				if (success) {
					stashedCount++;
				}
			}

			await scmProvider.refresh();
			if (stashedCount > 0) {
				vscode.window.showInformationMessage(
					`git-cl: Stashed ${stashedCount} changelist(s).`
				);
			}
		}
	);

	const unstashAllChangelistsCmd = vscode.commands.registerCommand(
		'git-cl.unstashAllChangelists',
		async () => {
			const stashStore = scmProvider.getStashStore();
			stashStore.load();
			const names = [...stashStore.getNames()];

			if (names.length === 0) {
				vscode.window.showInformationMessage('git-cl: No stashed changelists to unstash.');
				return;
			}

			let unstashedCount = 0;
			for (const name of names) {
				const success = await unstashSingleChangelist(scmProvider, name, gitRoot, false);
				if (success) {
					unstashedCount++;
				}
			}

			await scmProvider.refresh();
			if (unstashedCount > 0) {
				vscode.window.showInformationMessage(
					`git-cl: Unstashed ${unstashedCount} changelist(s).`
				);
			}
		}
	);

	const branchFromChangelistCmd = vscode.commands.registerCommand(
		'git-cl.branchFromChangelist',
		async (...args: unknown[]) => {
			const changelistName = resolveChangelistName(args);
			const name = changelistName ?? await pickChangelistForAction(scmProvider, 'branch from');
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

			// Prompt for branch name (defaults to changelist name)
			const branchName = await vscode.window.showInputBox({
				prompt: 'Enter branch name',
				value: name,
				placeHolder: 'feature/my-branch',
				validateInput: async (value) => {
					if (!value || value.trim().length === 0) {
						return 'Branch name cannot be empty';
					}
					// Basic branch name validation
					if (/[\s~^:?*\[\\]/.test(value)) {
						return 'Branch name contains invalid characters';
					}
					return null;
				},
			});
			if (!branchName) {
				return;
			}

			// Check if branch already exists
			const exists = await gitBranchExists(branchName, gitRoot);
			if (exists) {
				vscode.window.showErrorMessage(`git-cl: Branch "${branchName}" already exists.`);
				return;
			}

			// Get current branch for base branch prompt and rollback
			let currentBranch: string | null;
			try {
				currentBranch = await getCurrentBranch(gitRoot);
			} catch {
				vscode.window.showErrorMessage('git-cl: Failed to determine current branch.');
				return;
			}

			const currentBranchLabel = currentBranch ?? 'HEAD';

			// Optionally prompt for base branch (defaults to current branch)
			const baseBranch = await vscode.window.showInputBox({
				prompt: `Base branch (leave empty for current: ${currentBranchLabel})`,
				placeHolder: currentBranchLabel,
			});
			// undefined = cancelled, empty string = use default
			if (baseBranch === undefined) {
				return;
			}
			const resolvedBase = baseBranch.trim() || undefined;

			// Validate: no unassigned uncommitted changes
			let gitStatusMap: Map<string, string>;
			try {
				gitStatusMap = await getGitStatus(gitRoot);
			} catch {
				vscode.window.showErrorMessage('git-cl: Failed to read git status.');
				return;
			}

			const stashStore = scmProvider.getStashStore();
			stashStore.load();
			const stashedFiles = stashStore.getStashedFiles();

			// Collect all files assigned to active changelists
			const assignedFiles = new Set<string>();
			const allChangelists = store.getAll();
			for (const clFiles of Object.values(allChangelists)) {
				for (const f of clFiles) {
					assignedFiles.add(f);
				}
			}

			// Check for unassigned uncommitted changes
			const unassigned: string[] = [];
			for (const [filePath] of gitStatusMap) {
				if (!assignedFiles.has(filePath) && !stashedFiles.has(filePath)) {
					unassigned.push(filePath);
				}
			}

			if (unassigned.length > 0) {
				const answer = await vscode.window.showWarningMessage(
					`There are ${unassigned.length} unassigned uncommitted file(s) that would be lost during branch creation. Please assign them to a changelist first, or commit/stash them.\n\nFiles: ${unassigned.slice(0, 5).join(', ')}${unassigned.length > 5 ? '...' : ''}`,
					{ modal: true },
					'Cancel'
				);
				// Only option is cancel (or dismiss)
				return;
			}

			// Stash all active changelists
			const activeNames = [...store.getNames()];
			const stashedByUs: string[] = [];

			for (const clName of activeNames) {
				const clFiles = store.getFiles(clName);
				if (clFiles.length === 0) {
					continue;
				}
				const success = await stashSingleChangelist(scmProvider, clName, gitRoot);
				if (!success) {
					// Rollback: unstash everything we already stashed
					for (const stashedName of stashedByUs.reverse()) {
						await unstashSingleChangelist(scmProvider, stashedName, gitRoot, true);
					}
					vscode.window.showErrorMessage(`git-cl: Failed to stash changelist "${clName}". Branch creation aborted.`);
					await scmProvider.refresh();
					return;
				}
				stashedByUs.push(clName);
			}

			// Create and switch to the new branch
			try {
				await gitCheckoutBranch(branchName, gitRoot, resolvedBase);
			} catch (e: unknown) {
				// Rollback: unstash all changelists and stay on original branch
				for (const stashedName of stashedByUs.reverse()) {
					await unstashSingleChangelist(scmProvider, stashedName, gitRoot, true);
				}
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`git-cl: Failed to create branch "${branchName}": ${msg}`);
				await scmProvider.refresh();
				return;
			}

			// Unstash the target changelist only
			const unstashSuccess = await unstashSingleChangelist(scmProvider, name, gitRoot, true);
			if (!unstashSuccess) {
				// Rollback: switch back to original branch, unstash everything
				try {
					if (currentBranch) {
						await gitCheckoutExistingBranch(currentBranch, gitRoot);
					}
				} catch { /* best effort */ }
				for (const stashedName of stashedByUs.reverse()) {
					await unstashSingleChangelist(scmProvider, stashedName, gitRoot, true);
				}
				vscode.window.showErrorMessage(`git-cl: Failed to unstash changelist "${name}" on new branch. Rolled back to original branch.`);
				await scmProvider.refresh();
				return;
			}

			await scmProvider.refresh();
			vscode.window.showInformationMessage(
				`git-cl: Created branch "${branchName}" with changelist "${name}".`
			);
		}
	);

	context.subscriptions.push(statusCmd, addToChangelistCmd, removeFromChangelistCmd, openFileDiffCmd, deleteChangelistCmd, deleteAllChangelistsCmd, stageChangelistCmd, unstageChangelistCmd, commitChangelistCmd, diffChangelistCmd, checkoutChangelistCmd, stashAllChangelistsCmd, unstashAllChangelistsCmd, branchFromChangelistCmd);
	outputChannel.appendLine('git-cl extension activated.');
}

/**
 * Remove entries that no longer have working-tree or index changes (already
 * committed, or reverted to HEAD), keeping each changelist limited to pending work.
 */
async function pruneChangelists(
	scmProvider: ChangelistTreeDataProvider,
	gitRoot: string,
	names?: string[]
): Promise<void> {
	let gitStatusMap: Map<string, string>;
	try {
		gitStatusMap = await getGitStatus(gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return;
	}

	const store = scmProvider.getChangelistStore();
	store.load();
	let prunedCount = 0;
	for (const name of names ?? store.getNames()) {
		const staleFiles = store.getFiles(name).filter(file => !gitStatusMap.has(file));
		store.removeFiles(name, staleFiles);
		prunedCount += staleFiles.length;
	}

	if (prunedCount === 0) {
		vscode.window.showInformationMessage('git-cl: No unchanged files to prune.');
		return;
	}

	store.save();
	await scmProvider.refresh();
	vscode.window.showInformationMessage(`git-cl: Pruned ${prunedCount} unchanged file(s).`);
}


/** Lets the user pick what to copy from a changelist: its name or a review prompt for it. */
async function pickAndCopyFromChangelist(
	scmProvider: ChangelistTreeDataProvider,
	gitRoot: string,
	name: string
): Promise<void> {
	const reviewPrompt = (): string => {
		const store = scmProvider.getChangelistStore();
		store.load();
		return renderReviewPrompt(readReviewTemplate(gitRoot), { changelist: name, files: store.getFiles(name) });
	};
	const choices = [
		{ label: '$(symbol-string) Copy Name', copied: 'Changelist name', text: () => name },
		{ label: '$(comment-discussion) Copy Review Prompt', copied: 'Review prompt', text: reviewPrompt },
	];

	const picked = await vscode.window.showQuickPick(choices, { placeHolder: `Copy from changelist "${name}"` });
	if (!picked) {
		return;
	}

	await vscode.env.clipboard.writeText(picked.text());
	vscode.window.showInformationMessage(`git-cl: ${picked.copied} copied to the clipboard.`);
}

/**
 * Disband a changelist after confirming with the user: its files move to
 * Unassigned with their changes kept. Hidden changes are shown again first.
 */
async function disbandChangelistWithConfirmation(
	scmProvider: ChangelistTreeDataProvider,
	gitRoot: string,
	name: string
): Promise<void> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const stashStore = scmProvider.getStashStore();
	stashStore.load();
	const hiddenFiles = stashStore.getStash(name)?.files;
	const files = hiddenFiles ?? store.getFiles(name);
	const hiddenNote = hiddenFiles ? ' Its hidden changes will be shown again first.' : '';

	const message = files.length > 0
		? `Disband changelist "${name}"? ${files.length} file(s) will be moved to Unassigned.${hiddenNote}`
		: `Disband empty changelist "${name}"?`;

	const answer = await vscode.window.showWarningMessage(
		message,
		{ modal: true },
		'Disband'
	);

	if (answer !== 'Disband') {
		return;
	}

	if (hiddenFiles && !await unstashSingleChangelist(scmProvider, name, gitRoot, false)) {
		return;
	}

	store.load();
	try {
		store.deleteChangelist(name);
		store.save();
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: ${msg}`);
		return;
	}

	await scmProvider.refresh();
}

export function deactivate(): void {
	// cleanup
}
