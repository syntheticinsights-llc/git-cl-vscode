import * as vscode from 'vscode';
import { getCurrentBranch, getGitStatus, gitBranchExists, gitCheckoutBranch, gitCheckoutExistingBranch } from '../gitUtils';
import { ChangelistTreeDataProvider } from '../changelistTreeProvider';
import { pickChangelistForAction, resolveChangelistName } from '../commandArgs';
import { stashSingleChangelist, unstashSingleChangelist } from '../stashOperations';

export function registerBranchCommands(scmProvider: ChangelistTreeDataProvider, gitRoot: string): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(
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
		),
	];
}
