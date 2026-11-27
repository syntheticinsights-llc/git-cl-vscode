import * as vscode from 'vscode';
import { showFormattedStatus } from './actions/statusReport';
import { registerBranchCommands } from './commands/branchCommands';
import { registerChangelistCommands } from './commands/changelistCommands';
import { registerFileCommands } from './commands/fileCommands';
import { registerGitCommands } from './commands/gitCommands';
import { registerVisibilityCommands } from './commands/visibilityCommands';
import { ViewMode } from './core/fileTree';
import { getGitRoot } from './core/gitUtils';
import { detectRepos, RepoRef } from './host/workspaceRepos';
import { ChangelistFilesProvider } from './views/changelistFilesProvider';
import { ChangelistListProvider } from './views/changelistListProvider';
import { ChangelistWorkspace } from './views/changelistWorkspace';
import { groupRefOf, sameGroupRef } from './views/treeNodes';
import { TreeRepoSwitcher } from './views/treeRepoSwitcher';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const outputChannel = vscode.window.createOutputChannel('git-cl');
	context.subscriptions.push(outputChannel);

	const repos = await detectRepos();
	if (repos.length === 0) {
		outputChannel.appendLine('git-cl: No git repository found in this workspace.');
		return;
	}
	const primary = await primaryRepo(repos);

	const rememberedTreeRoot = context.globalState.get<string>('git-cl.tree.repo');
	const initialRepo = repos.find(repo => repo.root === rememberedTreeRoot) ?? primary;
	vscode.commands.executeCommand('setContext', 'git-cl:hasGitRoot', true);

	const workspace = new ChangelistWorkspace(context, initialRepo.root, outputChannel, initialRepo.commonDir);
	const listProvider = new ChangelistListProvider(workspace);
	const filesProvider = new ChangelistFilesProvider(workspace);

	const listTreeView = vscode.window.createTreeView('git-cl.changelists', {
		treeDataProvider: listProvider,
		dragAndDropController: listProvider,
		canSelectMany: false,
	});
	const filesTreeView = vscode.window.createTreeView('git-cl.changelistFiles', {
		treeDataProvider: filesProvider,
		dragAndDropController: filesProvider,
		showCollapseAll: true,
		canSelectMany: true,
	});

	const syncListSelection = (): void => {
		if (!listTreeView.visible) {
			return;
		}
		const targetNode = workspace.getSelectedGroupNode();
		if (!targetNode) {
			return;
		}
		const currentSelected = listTreeView.selection[0];
		if (currentSelected && sameGroupRef(groupRefOf(currentSelected), groupRefOf(targetNode))) {
			return;
		}
		void Promise.resolve(listTreeView.reveal(targetNode, { select: true, focus: false })).catch(() => {
			// Ignore races when a concurrent refresh replaces the node before reveal resolves.
		});
	};

	const syncViews = (): void => {
		listProvider.syncViewChrome(listTreeView);
		filesProvider.syncViewChrome(filesTreeView);
		syncListSelection();
	};
	syncViews();

	const repoSwitcher = new TreeRepoSwitcher(context, listTreeView, workspace, repos, initialRepo);
	const setViewMode = (mode: ViewMode) =>
		vscode.workspace.getConfiguration('git-cl').update('viewMode', mode, vscode.ConfigurationTarget.Global);

	context.subscriptions.push(
		workspace,
		listProvider,
		filesProvider,
		listTreeView,
		filesTreeView,
		repoSwitcher,
		listTreeView.onDidChangeSelection(event => {
			const selected = event.selection[0];
			if (selected) {
				workspace.selectGroup(groupRefOf(selected));
			}
		}),
		listTreeView.onDidChangeVisibility(event => {
			if (event.visible) {
				syncListSelection();
			}
		}),
		workspace.onDidChangeData(syncViews),
		workspace.onDidChangeSelection(syncViews),
		vscode.commands.registerCommand('git-cl.switchRepository', () => repoSwitcher.pickRepository()),
		vscode.commands.registerCommand('git-cl.viewAsTree', () => setViewMode('tree')),
		vscode.commands.registerCommand('git-cl.viewAsList', () => setViewMode('list')),
		vscode.commands.registerCommand('git-cl.showStatus', () =>
			showFormattedStatus(outputChannel, workspace, workspace.getGitRoot())
		),
		...registerFileCommands(workspace, uri => repoSwitcher.ensureRepoForUri(uri)),
		...registerChangelistCommands(workspace),
		...registerGitCommands(workspace),
		...registerVisibilityCommands(workspace),
		...registerBranchCommands(workspace),
	);
	outputChannel.appendLine(`git-cl extension activated (${repos.length} repositories).`);
}

/** Prefers the repository that owns the first workspace folder. */
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
