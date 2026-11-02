import * as vscode from 'vscode';
import * as path from 'path';
import { getGitRoot, getGitCommonDir } from './gitUtils';
import { ChangelistTreeDataProvider } from './changelistTreeProvider';
import { ViewMode } from './fileTree';
import { showFormattedStatus } from './statusReport';
import { registerFileCommands } from './commands/fileCommands';
import { registerChangelistCommands } from './commands/changelistCommands';
import { registerGitCommands } from './commands/gitCommands';
import { registerVisibilityCommands } from './commands/visibilityCommands';
import { registerBranchCommands } from './commands/branchCommands';

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

	const statusCmd = vscode.commands.registerCommand('git-cl.showStatus', async () => {
		await showFormattedStatus(outputChannel, scmProvider, gitRoot);
	});

	context.subscriptions.push(
		statusCmd,
		...registerFileCommands(scmProvider, gitRoot),
		...registerChangelistCommands(scmProvider, gitRoot),
		...registerGitCommands(scmProvider, gitRoot),
		...registerVisibilityCommands(scmProvider, gitRoot),
		...registerBranchCommands(scmProvider, gitRoot),
	);
	outputChannel.appendLine('git-cl extension activated.');
}

export function deactivate(): void {
	// cleanup
}
