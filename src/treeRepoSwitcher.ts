import * as vscode from 'vscode';
import { ChangelistTreeDataProvider, TreeNode } from './changelistTreeProvider';
import { ChangelistStore } from './core/changelistStore';
import { getGitStatus } from './core/gitUtils';
import { detectRepos, findRepoForPath, onDidChangeRepos, RepoRef } from './workspaceRepos';

const ACTIVE_TREE_REPO_KEY = 'git-cl.tree.repo';
const HAS_MULTIPLE_REPOS_CONTEXT = 'git-cl:hasMultipleRepos';

interface RepoPickItem extends vscode.QuickPickItem {
	repo: RepoRef;
	hasActivity: boolean;
}

/**
 * Coordinates repository switching for the Source Control TreeView.
 *
 * Keeps a single Changelists view uncluttered: when only one repository exists
 * the UI stays unchanged; when multiple repositories are detected, the active
 * repo name appears in the view description and a title-bar button opens a
 * QuickPick listing each repo's changelist and change counts.
 */
export class TreeRepoSwitcher implements vscode.Disposable {
	private repos: RepoRef[];
	private activeRepo: RepoRef;
	private userSwitched = false;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly treeView: vscode.TreeView<TreeNode>,
		private readonly scmProvider: ChangelistTreeDataProvider,
		initialRepos: RepoRef[],
		initialActive: RepoRef
	) {
		this.repos = initialRepos;
		this.activeRepo = initialActive;
		this.syncUiChrome();

		this.disposables.push(
			onDidChangeRepos(() => this.scheduleSync())
		);
	}

	async pickRepository(): Promise<void> {
		this.repos = await detectRepos();
		this.syncUiChrome();
		if (this.repos.length === 0) {
			return;
		}

		const items = await Promise.all(this.repos.map(repo => this.buildPickItem(repo)));
		items.sort((a, b) => Number(b.hasActivity) - Number(a.hasActivity));

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select repository for Changelists view',
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) {
			return;
		}
		await this.activate(picked.repo, true);
	}

	/**
	 * When a file command is invoked from built-in Source Control on a file inside
	 * another repository, switch the tree provider to that repository first so the
	 * file is added to its own `.git/cl.json`.
	 */
	async ensureRepoForUri(uri: vscode.Uri): Promise<void> {
		let owner = findRepoForPath(this.repos, uri.fsPath);
		if (!owner) {
			this.repos = await detectRepos();
			owner = findRepoForPath(this.repos, uri.fsPath);
		}
		if (owner && owner.root !== this.activeRepo.root) {
			await this.activate(owner, true);
		}
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private scheduleSync(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => void this.syncRepos(), 150);
	}

	private async syncRepos(): Promise<void> {
		const detected = await detectRepos();
		if (detected.length === 0) {
			return;
		}
		this.repos = detected;

		const remembered = this.context.globalState.get<string>(ACTIVE_TREE_REPO_KEY);
		const wanted = this.userSwitched
			? [this.activeRepo.root, remembered]
			: [remembered, this.activeRepo.root];
		const targetRoot = wanted.find(root => root !== undefined && this.repos.some(repo => repo.root === root));
		const nextRepo = this.repos.find(repo => repo.root === targetRoot) ?? this.repos[0];

		if (nextRepo.root !== this.activeRepo.root) {
			await this.activate(nextRepo, false);
			return;
		}
		// Keep label updated in case another repo with the same folder name appeared.
		this.activeRepo = nextRepo;
		this.syncUiChrome();
	}

	private async activate(repo: RepoRef, byUser: boolean): Promise<void> {
		if (byUser) {
			this.userSwitched = true;
			await this.context.globalState.update(ACTIVE_TREE_REPO_KEY, repo.root);
		}
		this.activeRepo = repo;
		this.syncUiChrome();
		await this.scmProvider.setRepository(repo.root, repo.commonDir);
	}

	private syncUiChrome(): void {
		const multiple = this.repos.length > 1;
		void vscode.commands.executeCommand('setContext', HAS_MULTIPLE_REPOS_CONTEXT, multiple);
		this.treeView.description = multiple ? this.activeRepo.label : undefined;
	}

	private async buildPickItem(repo: RepoRef): Promise<RepoPickItem> {
		const store = new ChangelistStore(repo.root, repo.commonDir);
		store.load();
		const clCount = store.getNames().length;
		let changeCount = 0;
		try {
			changeCount = (await getGitStatus(repo.root)).size;
		} catch {
			// Best-effort summary; a failing status check should not block switching.
		}

		const isCurrent = repo.root === this.activeRepo.root;
		const summaryParts: string[] = [];
		if (clCount > 0) {
			summaryParts.push(`${clCount} changelist${clCount === 1 ? '' : 's'}`);
		}
		if (changeCount > 0) {
			summaryParts.push(`${changeCount} change${changeCount === 1 ? '' : 's'}`);
		}
		const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : 'clean';

		return {
			repo,
			hasActivity: clCount > 0 || changeCount > 0,
			label: `${isCurrent ? '$(check) ' : '$(repo) '}${repo.label}`,
			description: summary,
			detail: repo.root,
		};
	}
}
