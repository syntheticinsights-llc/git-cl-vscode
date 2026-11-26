import * as vscode from 'vscode';
import { commitChangelist, stageChangelist } from '../changelistActions';
import { openWorkingTreeDiff, WorkingTreeFileState } from '../workingTreeDiff';
import { detectRepos, onDidChangeRepos, RepoRef } from '../workspaceRepos';
import { renderBoardHtml } from './boardHtml';
import { BoardFile, HostMessage, RepoOption, WebviewMessage } from './protocol';
import { changelistStoreFor, readBoardSnapshot } from './repoSession';

export const BOARD_VIEW_TYPE = 'git-cl.board';
const ACTIVE_REPO_KEY = 'git-cl.board.repo';
/**
 * Only files that change when a changelist or a branch changes. The index is
 * deliberately not watched: `git status` itself refreshes it, so watching it
 * would schedule a repaint after every repaint.
 */
const REPO_WATCH_FILES = ['cl.json', 'cl-stashes.json', 'HEAD'];

/**
 * The changelist board: a webview panel drawing every repository VS Code knows
 * about, switchable from its own header, draggable into a floating window.
 *
 * The panel holds no state of its own. Each snapshot is read fresh from the
 * active repository, so a reloaded webview, a restart, or a write from the CLI
 * elsewhere all come back correct; the active repository is remembered in
 * global state so a restored panel opens where the user left it.
 */
export class ChangelistBoard implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private panelDisposables: vscode.Disposable[] = [];
	private watchers: vscode.Disposable[] = [];
	private repos: RepoRef[] = [];
	private preferredRepo: RepoRef | undefined;
	private activeRoot: string | undefined;
	/** True once the user explicitly picked a repo in this session, so late repo discovery won't override it. */
	private userSwitchedRepo = false;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private repoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** True once the current webview DOM has finished booting and sent `ready`. */
	private webviewReady = false;
	/** Guards against a slow read landing after a newer one. */
	private pushToken = 0;
	/** Serializes `openFile` calls so rapid clicks never race on the same preview diff tab. */
	private openingFile = false;
	private pendingOpenFile: string | undefined;
	/** Rename sources from the last snapshot, so opening a diff needs no extra git run. */
	private renamesForFiles = new Map<string, string>();
	/** How each file differs from HEAD, likewise carried over from the last snapshot. */
	private fileStates = new Map<string, WorkingTreeFileState>();
	private invalidateHeadCache: (() => void) | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel?: vscode.OutputChannel
	) {
		this.disposables.push(
			onDidChangeRepos(() => this.scheduleRepoRefresh()),
			vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh())
		);
	}

	setPreferredRepo(repo: RepoRef): void {
		this.preferredRepo = repo;
	}

	setHeadCacheInvalidator(invalidate: () => void): void {
		this.invalidateHeadCache = invalidate;
	}

	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(this.panel.viewColumn, false);
			if (this.webviewReady) {
				await this.push();
			}
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			BOARD_VIEW_TYPE,
			'Changelists',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			this.webviewOptions()
		);
		this.attach(panel);
	}

	/** Called by the WebviewPanelSerializer when VS Code restores a persisted board. */
	restore(panel: vscode.WebviewPanel): void {
		if (this.panel && this.panel !== panel) {
			// User already opened a fresh board before the persisted tab was lazily revived.
			panel.dispose();
			return;
		}
		this.attach(panel);
	}

	/**
	 * Wires up a newly created or restored panel synchronously.
	 *
	 * Must NOT await `postMessage`: during revival, VS Code waits for
	 * `deserializeWebviewPanel` to settle before mounting the iframe, while
	 * `postMessage` waits for the iframe to mount before resolving — awaiting
	 * it here deadlocks the restored panel in a permanent loading state.
	 */
	private attach(panel: vscode.WebviewPanel): void {
		this.disposePanelListeners();
		this.panel = panel;
		this.webviewReady = false;
		panel.webview.options = this.webviewOptions();
		this.panelDisposables = [
			panel.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(message)),
			panel.onDidChangeViewState(event => {
				// retainContextWhenHidden is false, so hiding tears down the iframe;
				// it will send `ready` again when revealed.
				if (!event.webviewPanel.visible) {
					this.webviewReady = false;
				}
			}),
			panel.onDidDispose(() => {
				if (this.panel === panel) {
					this.panel = undefined;
					this.webviewReady = false;
					this.disposePanelListeners();
					this.setWatchedRepo(undefined);
				}
			}),
		];
		panel.webview.html = renderBoardHtml(panel.webview, this.context.extensionUri);
		void this.refreshRepos();
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		if (this.repoRefreshTimer) {
			clearTimeout(this.repoRefreshTimer);
		}
		this.disposePanelListeners();
		this.setWatchedRepo(undefined);
		this.panel?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
		return {
			enableScripts: true,
			retainContextWhenHidden: false,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
		};
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.webviewReady = true;
				await this.refreshRepos();
				return;
			case 'refresh':
				await this.refreshRepos();
				return;
			case 'switchRepo':
				await this.activate(message.root);
				return;
			case 'openFile':
				await this.openFile(message.path);
				return;
			case 'stage': {
				const ok = await this.runWithStore((repo, store) => stageChangelist(this.target(repo, store), message.name));
				this.postMessage({ type: 'actionResult', action: 'stage', name: message.name, ok });
				return;
			}
			case 'commit': {
				// An empty message means the board could not ask for one (narrow panel),
				// so fall through to the command's own prompt.
				const ok = await this.runWithStore(async (repo, store) => {
					const committed = await commitChangelist(
						this.target(repo, store),
						message.name,
						message.message.trim() || undefined
					);
					if (committed) {
						this.invalidateHeadCache?.();
					}
					return committed;
				});
				this.postMessage({ type: 'actionResult', action: 'commit', name: message.name, ok });
				return;
			}
		}
	}

	/** Re-reads the repository list and the active repository's data. */
	private async refreshRepos(): Promise<void> {
		const startedAt = Date.now();
		try {
			this.repos = await detectRepos();
		} catch (error: unknown) {
			this.report('repository scan', error);
			return;
		}
		this.trace(`refreshRepos detected ${this.repos.length} repo(s) in ${Date.now() - startedAt}ms`);
		const remembered = this.context.globalState.get<string>(ACTIVE_REPO_KEY);
		// Before the user manually switches repos, prefer the remembered repo so
		// late-discovered nested repos restore where the user left off.
		const wanted = this.userSwitchedRepo
			? [this.activeRoot, remembered, this.preferredRepo?.root]
			: [remembered, this.activeRoot, this.preferredRepo?.root];
		this.activeRoot = wanted.find(root => root !== undefined && this.repos.some(repo => repo.root === root))
			?? this.repos[0]?.root;
		this.setWatchedRepo(this.activeRoot);
		await this.push();
	}

	private async activate(root: string): Promise<void> {
		if (!this.repos.some(repo => repo.root === root)) {
			await this.refreshRepos();
			return;
		}
		this.userSwitchedRepo = true;
		this.activeRoot = root;
		await this.context.globalState.update(ACTIVE_REPO_KEY, root);
		this.setWatchedRepo(root);
		await this.push();
	}

	private activeRepo(): RepoRef | undefined {
		return this.repos.find(repo => repo.root === this.activeRoot);
	}

	private async push(): Promise<void> {
		const panel = this.panel;
		const repo = this.activeRepo();
		if (!panel || !repo || !this.webviewReady) {
			return;
		}
		const token = ++this.pushToken;
		const startedAt = Date.now();
		try {
			const snapshot = await readBoardSnapshot(
				repo,
				vscode.workspace.getConfiguration('scm').get<boolean>('compactFolders', true)
			);
			const readMs = Date.now() - startedAt;
			if (token !== this.pushToken || !this.webviewReady || this.panel !== panel) {
				this.trace(`push #${token} dropped (${repo.label}, ${readMs}ms)`);
				return;
			}
			const repos: RepoOption[] = this.repos.map(({ root, label }) => ({ root, label }));
			this.renamesForFiles = new Map();
			this.fileStates = new Map();
			let fileCount = 0;
			for (const group of [...snapshot.changelists, ...snapshot.hiddenChangelists, snapshot.unassigned]) {
				for (const file of group.files) {
					fileCount++;
					if (file.renamedFrom) {
						this.renamesForFiles.set(file.path, file.renamedFrom);
					}
					this.fileStates.set(file.path, fileStateOf(file));
				}
			}
			const message: HostMessage = { type: 'snapshot', snapshot, repos, activeRepo: repo.root };
			const postStartedAt = Date.now();
			this.trace(`push #${token} read=${readMs}ms files=${fileCount} repo=${repo.label}`);
			void panel.webview.postMessage(message).then(delivered => {
				this.trace(`push #${token} postMessage delivered=${delivered} in ${Date.now() - postStartedAt}ms`);
			});
		} catch (error: unknown) {
			this.report('snapshot', error);
		}
	}

	private postMessage(message: HostMessage): void {
		if (!this.panel || !this.webviewReady) {
			return;
		}
		void this.panel.webview.postMessage(message);
	}

	private target(repo: RepoRef, store: ReturnType<typeof changelistStoreFor>) {
		return {
			gitRoot: repo.root,
			store,
			onChanged: () => this.push(),
		};
	}

	/** Runs an action against the repository on screen, then repaints. */
	private async runWithStore(
		action: (repo: RepoRef, store: ReturnType<typeof changelistStoreFor>) => Promise<boolean>
	): Promise<boolean> {
		const repo = this.activeRepo();
		if (!repo) {
			return false;
		}
		const store = changelistStoreFor(repo);
		store.load();
		try {
			return await action(repo, store);
		} finally {
			await this.push();
		}
	}

	private async openFile(filePath: string): Promise<void> {
		if (this.openingFile) {
			this.trace(`openFile queued latest=${filePath} (replacing ${this.pendingOpenFile ?? 'none'})`);
			this.pendingOpenFile = filePath;
			return;
		}
		this.openingFile = true;
		let next: string | undefined = filePath;
		try {
			while (next !== undefined) {
				const targetPath = next;
				next = undefined;
				await this.openSingleFile(targetPath);
				if (this.pendingOpenFile !== undefined) {
					next = this.pendingOpenFile;
					this.pendingOpenFile = undefined;
				}
			}
		} finally {
			this.openingFile = false;
			this.pendingOpenFile = undefined;
		}
	}

	private async openSingleFile(filePath: string): Promise<void> {
		const startedAt = Date.now();
		let repo = this.activeRepo();
		if (!repo) {
			await this.refreshRepos();
			repo = this.activeRepo();
			if (!repo) {
				this.trace(`openFile skipped (no active repo): ${filePath}`);
				return;
			}
		}
		const state = this.fileStates.get(filePath);
		const viewColumn = this.diffColumn();
		this.trace(`openFile start path=${filePath} state=${state ?? 'unknown'} col=${viewColumn} panelCol=${this.panel?.viewColumn ?? 'none'}`);
		try {
			const renamedFrom = this.renamesForFiles.get(filePath);
			await openWorkingTreeDiff(repo.root, filePath, renamedFrom, {
				viewColumn,
				preview: true,
				preserveFocus: true,
				state,
			});
			this.trace(`openFile done path=${filePath} in ${Date.now() - startedAt}ms`);
		} catch (error: unknown) {
			this.trace(`openFile error path=${filePath} after ${Date.now() - startedAt}ms`);
			this.report('open diff', error);
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`git-cl: Failed to open diff: ${message}`);
		}
	}

	/**
	 * The editor group right of the board. Passing it every time keeps the diff
	 * in one fixed place, so clicking through files replaces that pane instead of
	 * opening tabs wherever focus happens to be.
	 */
	private diffColumn(): vscode.ViewColumn {
		const column = this.panel?.viewColumn ?? vscode.ViewColumn.One;
		// In the last column there is nothing to the right, so the diff goes one to
		// the left rather than landing on the board's own group.
		return column >= vscode.ViewColumn.Nine
			? vscode.ViewColumn.Eight
			: ((column + 1) as vscode.ViewColumn);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => void this.push(), 300);
	}

	/** Coalesces bursty `onDidOpenRepository` events as VS Code finishes scanning nested repos. */
	private scheduleRepoRefresh(): void {
		if (!this.panel) {
			return;
		}
		if (this.repoRefreshTimer) {
			clearTimeout(this.repoRefreshTimer);
		}
		this.repoRefreshTimer = setTimeout(() => void this.refreshRepos(), 150);
	}

	/** Watches only the repository on screen; switching moves the watchers. */
	private setWatchedRepo(root: string | undefined): void {
		for (const watcher of this.watchers) {
			watcher.dispose();
		}
		this.watchers = [];
		const repo = this.repos.find(candidate => candidate.root === root);
		if (!repo) {
			return;
		}
		for (const file of REPO_WATCH_FILES) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(repo.commonDir), file)
			);
			const onChange = () => {
				if (file === 'HEAD') {
					this.invalidateHeadCache?.();
				}
				this.scheduleRefresh();
			};
			watcher.onDidChange(onChange);
			watcher.onDidCreate(onChange);
			watcher.onDidDelete(onChange);
			this.watchers.push(watcher);
		}
	}

	private disposePanelListeners(): void {
		for (const disposable of this.panelDisposables) {
			disposable.dispose();
		}
		this.panelDisposables = [];
	}

	private report(action: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.trace(`Board ${action} failed: ${message}`);
	}

	private trace(message: string): void {
		this.outputChannel?.appendLine(`[${new Date().toISOString()}] git-cl: ${message}`);
	}
}

/**
 * The board's file metadata tells the diff opener enough without running git again.
 * A newly added binary file (status 'A' with no line counts) has no HEAD version
 * and cannot be text-diffed against `git-cl-head`, so open it directly like untracked;
 * a newly added text file uses an empty virtual HEAD document so `git show` is skipped.
 */
function fileStateOf(file: BoardFile): WorkingTreeFileState {
	if (file.status === 'U') {
		return 'untracked';
	}
	if (file.status === 'A') {
		if (file.additions === undefined && file.deletions === undefined) {
			return 'untracked';
		}
		if (!file.renamedFrom) {
			return 'added';
		}
	}
	return file.status === 'D' ? 'deleted' : 'changed';
}
