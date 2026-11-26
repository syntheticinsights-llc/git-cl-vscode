import * as vscode from 'vscode';
import { getGitRoot } from './core/gitUtils';
import { ChangelistTreeDataProvider } from './changelistTreeProvider';
import { BOARD_VIEW_TYPE, ChangelistBoard } from './board/changelistBoard';
import { ViewMode } from './fileTree';
import { showFormattedStatus } from './statusReport';
import { TreeRepoSwitcher } from './treeRepoSwitcher';
import { detectRepos, RepoRef } from './workspaceRepos';
import { registerFileCommands } from './commands/fileCommands';
import { registerChangelistCommands } from './commands/changelistCommands';
import { registerGitCommands } from './commands/gitCommands';
import { registerVisibilityCommands } from './commands/visibilityCommands';
import { registerBranchCommands } from './commands/branchCommands';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const outputChannel = vscode.window.createOutputChannel('git-cl');
	context.subscriptions.push(outputChannel);

	// Register the board serializer synchronously before any await so VS Code
	// restoring a panel on reload always finds it immediately.
	const board = new ChangelistBoard(context, outputChannel);
	context.subscriptions.push(
		board,
		vscode.commands.registerCommand('git-cl.openBoard', () => board.show()),
		vscode.window.registerWebviewPanelSerializer(BOARD_VIEW_TYPE, {
			deserializeWebviewPanel(panel: vscode.WebviewPanel) {
				board.restore(panel);
				return Promise.resolve();
			},
		})
	);

	const repos = await detectRepos();
	if (repos.length === 0) {
		outputChannel.appendLine('git-cl: No git repository found in this workspace.');
		return;
	}
	const primary = await primaryRepo(repos);
	board.setPreferredRepo(primary);

	// Initialize TreeView provider (changelists section in Source Control sidebar)
	const rememberedTreeRoot = context.globalState.get<string>('git-cl.tree.repo');
	const initialTreeRepo = repos.find(repo => repo.root === rememberedTreeRoot) ?? primary;
	vscode.commands.executeCommand('setContext', 'git-cl:hasGitRoot', true);
	const scmProvider = new ChangelistTreeDataProvider(initialTreeRepo.root, outputChannel, initialTreeRepo.commonDir);
	board.setHeadCacheInvalidator(() => scmProvider.reloadHeadDocuments());
	const treeView = vscode.window.createTreeView('git-cl.changelists', {
		treeDataProvider: scmProvider,
		dragAndDropController: scmProvider,
		showCollapseAll: true,
		canSelectMany: true,
	});
	const repoSwitcher = new TreeRepoSwitcher(context, treeView, scmProvider, repos, initialTreeRepo);
	context.subscriptions.push(
		scmProvider,
		treeView,
		repoSwitcher,
		vscode.commands.registerCommand('git-cl.switchRepository', () => repoSwitcher.pickRepository())
	);

	const setViewMode = (mode: ViewMode) =>
		vscode.workspace.getConfiguration('git-cl').update('viewMode', mode, vscode.ConfigurationTarget.Global);
	context.subscriptions.push(
		vscode.commands.registerCommand('git-cl.viewAsTree', () => setViewMode('tree')),
		vscode.commands.registerCommand('git-cl.viewAsList', () => setViewMode('list')),
	);

	const statusCmd = vscode.commands.registerCommand('git-cl.showStatus', async () => {
		await showFormattedStatus(outputChannel, scmProvider, scmProvider.getGitRoot());
	});

	context.subscriptions.push(
		statusCmd,
		...registerFileCommands(scmProvider, uri => repoSwitcher.ensureRepoForUri(uri)),
		...registerChangelistCommands(scmProvider),
		...registerGitCommands(scmProvider),
		...registerVisibilityCommands(scmProvider),
		...registerBranchCommands(scmProvider),
	);
	outputChannel.appendLine(`git-cl extension activated (${repos.length} repositories).`);
}

/** The tree serves the first workspace folder's repository; that is the one it always served. */
async function primaryRepo(repos: RepoRef[]): Promise<RepoRef> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		try {
			const root = await getGitRoot(folder.uri.fsPath);
			const match = repos.find(repo => repo.root === root);
			if (match) {
				return match;
			}
		} catch {
			// The first folder is not a repository; fall through to the scan result.
		}
	}
	return repos[0];
}

export function deactivate(): void {
	// cleanup
}
