import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ChangelistStore } from './core/changelistStore';
import { StashStore, StashMetadata } from './core/stashStore';
import { getGitStatusSnapshot, getHeadCommit, GitStatusMap } from './core/gitUtils';
import { buildFileTree, collectFiles, dirname, FileTreeFolder, ViewMode } from './fileTree';
import { unassignedFiles } from './core/unassigned';
import { groupedRenames, visibleFiles } from './core/renames';

const HEAD_SCHEME = 'git-cl-head';

/**
 * TextDocumentContentProvider that returns file content at HEAD.
 * Used for showing diff (HEAD vs working copy) when clicking files.
 */
class HeadContentProvider implements vscode.TextDocumentContentProvider {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changeEmitter.event;
	/** HEAD content per repository path; cleared whenever HEAD moves, which is the only way it can change. */
	private readonly cache = new Map<string, string>();

	private defaultGitRoot: string;

	constructor(gitRoot: string, private readonly outputChannel?: vscode.OutputChannel) {
		this.defaultGitRoot = gitRoot;
	}

	setDefaultGitRoot(gitRoot: string): void {
		this.defaultGitRoot = gitRoot;
	}

	/** VS Code caches provided content, so loaded HEAD documents must be told when HEAD moves. */
	reloadOpenDocuments(): void {
		this.cache.clear();
		for (const document of vscode.workspace.textDocuments) {
			if (document.uri.scheme === HEAD_SCHEME) {
				this.changeEmitter.fire(document.uri);
			}
		}
	}

	provideTextDocumentContent(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<string> {
		if (token?.isCancellationRequested) {
			return Promise.reject(new vscode.CancellationError());
		}
		const relativePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
		if (uri.fragment === 'empty') {
			this.log(`head [empty] ${relativePath} (0ms)`);
			return Promise.resolve('');
		}
		// The query carries the repository the diff belongs to; without it every
		// repository would be served from this provider's own checkout.
		const gitRoot = uri.query ? decodeURIComponent(uri.query) : this.defaultGitRoot;
		const key = `${gitRoot}\u0000${relativePath}`;
		const cached = this.cache.get(key);
		if (cached !== undefined) {
			this.log(`head [cache] ${relativePath} (${cached.length} chars, 0ms)`);
			return Promise.resolve(cached);
		}

		// Clicking through files quickly replaces the diff editor before content arrives;
		// VS Code cancels this request, so the git process is killed instead of queueing.
		const startedAt = Date.now();
		const abort = new AbortController();
		const subscription = token?.onCancellationRequested(() => abort.abort());
		return new Promise((resolve, reject) => {
			execFile(
				'git',
				['show', `HEAD:${relativePath}`],
				{ cwd: gitRoot, maxBuffer: 10 * 1024 * 1024, timeout: 10_000, signal: abort.signal },
				(error, stdout) => {
					subscription?.dispose();
					const elapsed = Date.now() - startedAt;
					if (abort.signal.aborted || token?.isCancellationRequested) {
						this.log(`head [cancelled] ${relativePath} (${elapsed}ms)`);
						// Reject cancellations instead of returning '' so VS Code never
						// caches an empty document for a file whose load was interrupted.
						reject(new vscode.CancellationError());
						return;
					}
					if (error) {
						// Missing at HEAD (new file) or unreadable object; cache '' until HEAD moves.
						this.remember(key, '');
						this.log(`head [missing] ${relativePath} (${elapsed}ms)`);
						resolve('');
						return;
					}
					this.remember(key, stdout);
					this.log(`head [git-show] ${relativePath} (${stdout.length} chars, ${elapsed}ms)`);
					resolve(stdout);
				}
			);
		});
	}

	private log(message: string): void {
		this.outputChannel?.appendLine(`[${new Date().toISOString()}] git-cl: ${message}`);
	}

	private remember(key: string, content: string): void {
		if (this.cache.size >= 200) {
			const oldest = this.cache.keys().next();
			if (!oldest.done) {
				this.cache.delete(oldest.value);
			}
		}
		this.cache.set(key, content);
	}
}

export type FolderOwner =
	| { type: 'changelist'; name: string }
	| { type: 'unassigned' }
	| { type: 'stash'; name: string };

export type TreeNode =
	| { type: 'changelist'; name: string }
	| { type: 'changelistFile'; filePath: string; changelistName: string; renamedFrom?: string }
	| { type: 'unassignedSection' }
	| { type: 'unassignedFile'; filePath: string; renamedFrom?: string }
	| { type: 'stashedChangelist'; name: string; metadata: StashMetadata }
	| { type: 'stashedFile'; filePath: string; stashName: string }
	| { type: 'folder'; owner: FolderOwner; folder: FileTreeFolder; renames: ReadonlyMap<string, string> };

/** Cached changelist and git state from the last [ChangelistTreeDataProvider.refresh]. */
export interface BoardData {
	changelists: Record<string, string[]>;
	hiddenChangelists: Record<string, string[]>;
	unassigned: string[];
	status: GitStatusMap;
	renames: Map<string, string>;
}

const VIEW_MODE_CONTEXT_KEY = 'git-cl:viewMode';

const pathCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function folderOwnerId(owner: FolderOwner): string {
	switch (owner.type) {
		case 'changelist': return `cl:${owner.name}`;
		case 'unassigned': return 'unassigned';
		case 'stash': return `stash:${owner.name}`;
	}
}

function folderContextValue(owner: FolderOwner): string {
	switch (owner.type) {
		case 'changelist': return 'changelistFolder';
		case 'unassigned': return 'unassignedFolder';
		case 'stash': return 'stashedFolder';
	}
}

/** Expands folder nodes into the file nodes they contain; other nodes pass through. */
export function expandFolderNodes(nodes: readonly TreeNode[]): TreeNode[] {
	return nodes.flatMap(node => {
		if (node.type !== 'folder') {
			return [node];
		}
		return collectFiles(node.folder).map(filePath => fileNodeFor(node.owner, filePath, node.renames.get(filePath)));
	});
}

/** Every repository path a file node stands for: a merged rename covers both its new and original path. */
export function nodeFilePaths(node: TreeNode): string[] {
	if (node.type !== 'changelistFile' && node.type !== 'unassignedFile') {
		return [];
	}
	return node.renamedFrom ? [node.filePath, node.renamedFrom] : [node.filePath];
}

function fileNodeFor(owner: FolderOwner, filePath: string, renamedFrom?: string): TreeNode {
	switch (owner.type) {
		case 'changelist': return { type: 'changelistFile', filePath, changelistName: owner.name, renamedFrom };
		case 'unassigned': return { type: 'unassignedFile', filePath, renamedFrom };
		case 'stash': return { type: 'stashedFile', filePath, stashName: owner.name };
	}
}

function renameDescription(filePath: string, renamedFrom: string): string {
	return dirname(filePath) === dirname(renamedFrom) ? `← ${path.posix.basename(renamedFrom)}` : `← ${renamedFrom}`;
}

const TREE_MIME_TYPE = 'application/vnd.code.tree.git-cl.changelists';

/**
 * TreeDataProvider that surfaces changelists in a TreeView within the
 * Source Control sidebar.
 *
 * Tree structure: [active changelists] → [hidden (stashed) changelists] → Unassigned.
 */
export class ChangelistTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>, vscode.Disposable {
	readonly dropMimeTypes = [TREE_MIME_TYPE];
	readonly dragMimeTypes = [TREE_MIME_TYPE];
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private changelistStore: ChangelistStore;
	private stashStore: StashStore;
	private readonly disposables: vscode.Disposable[] = [];
	private repoWatchers: vscode.Disposable[] = [];

	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	private lastWarnedMissingFiles = new Set<string>();
	private refreshToken = 0;

	// Cached data from last refresh
	private cachedChangelists: Record<string, string[]> = {};
	private cachedStashData: Record<string, StashMetadata> = {};
	private cachedGitStatus: GitStatusMap = new Map();
	private cachedRenames = new Map<string, string>();
	private cachedUnassigned: string[] = [];

	private gitRoot: string;
	private gitCommonDir: string;
	private readonly headContentProvider: HeadContentProvider;
	private lastHeadCommit: string | null | undefined;

	constructor(gitRoot: string, private readonly outputChannel?: vscode.OutputChannel, gitCommonDir?: string) {
		this.gitRoot = gitRoot;
		this.gitCommonDir = gitCommonDir ?? path.join(gitRoot, '.git');
		this.changelistStore = new ChangelistStore(this.gitRoot, this.gitCommonDir);
		this.stashStore = new StashStore(this.gitRoot, this.gitCommonDir);

		// Register HEAD content provider for diffs
		this.headContentProvider = new HeadContentProvider(this.gitRoot, this.outputChannel);
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, this.headContentProvider)
		);

		this.setupGlobalListeners();
		this.setupRepoWatchers();
		this.refresh().catch(err => {
			const msg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Initial refresh error: ${msg}`);
		});
	}

	/** Switches the tree view to another repository and reloads its changelists and watchers. */
	async setRepository(gitRoot: string, gitCommonDir?: string): Promise<void> {
		const nextCommonDir = gitCommonDir ?? path.join(gitRoot, '.git');
		if (this.gitRoot === gitRoot && this.gitCommonDir === nextCommonDir) {
			return;
		}
		this.gitRoot = gitRoot;
		this.gitCommonDir = nextCommonDir;
		this.changelistStore = new ChangelistStore(this.gitRoot, this.gitCommonDir);
		this.stashStore = new StashStore(this.gitRoot, this.gitCommonDir);
		this.headContentProvider.setDefaultGitRoot(this.gitRoot);
		this.lastHeadCommit = undefined;
		this.lastWarnedMissingFiles = new Set();
		this.cachedChangelists = {};
		this.cachedStashData = {};
		this.cachedGitStatus = new Map();
		this.cachedRenames = new Map();
		this.cachedUnassigned = [];
		this.setupRepoWatchers();
		await this.refresh();
	}

	private setupGlobalListeners(): void {
		this.updateViewModeContext();
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('git-cl.viewMode') || e.affectsConfiguration('scm.compactFolders')) {
					this.updateViewModeContext();
					this._onDidChangeTreeData.fire(undefined);
				}
			})
		);

		// Refresh on file saves (git status may change)
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(() => this.debouncedRefresh())
		);
	}

	private setupRepoWatchers(): void {
		for (const watcher of this.repoWatchers) {
			watcher.dispose();
		}
		this.repoWatchers = [];
		const gitDir = this.gitCommonDir;

		// Watch cl.json, cl-stashes.json, git index, HEAD (branch switches) and logs/HEAD (every HEAD move)
		const patterns = ['cl.json', 'cl-stashes.json', 'index', 'HEAD', 'logs/HEAD'];
		for (const file of patterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(gitDir), file)
			);
			watcher.onDidChange(() => this.debouncedRefresh());
			watcher.onDidCreate(() => this.debouncedRefresh());
			watcher.onDidDelete(() => this.debouncedRefresh());
			this.repoWatchers.push(watcher);
		}
	}

	private get viewMode(): ViewMode {
		return vscode.workspace.getConfiguration('git-cl').get<ViewMode>('viewMode', 'tree');
	}

	private get compactFolders(): boolean {
		return vscode.workspace.getConfiguration('scm').get<boolean>('compactFolders', true);
	}

	private updateViewModeContext(): void {
		vscode.commands.executeCommand('setContext', VIEW_MODE_CONTEXT_KEY, this.viewMode);
	}

	/** Hidden changelists have no files on disk, so renames never apply to them. */
	private renamesInGroup(owner: FolderOwner, files: readonly string[]): Map<string, string> {
		return owner.type === 'stash' ? new Map() : groupedRenames(this.cachedRenames, files);
	}

	private visibleFileCount(owner: FolderOwner, files: readonly string[]): number {
		return visibleFiles(files, this.renamesInGroup(owner, files)).length;
	}

	private childNodes(owner: FolderOwner, files: readonly string[]): TreeNode[] {
		const renames = this.renamesInGroup(owner, files);
		const visible = visibleFiles(files, renames);
		if (this.viewMode === 'list') {
			return visible
				.sort((a, b) => pathCollator.compare(a, b))
				.map(filePath => fileNodeFor(owner, filePath, renames.get(filePath)));
		}
		return this.folderChildNodes(owner, buildFileTree(visible, this.compactFolders), renames);
	}

	private folderChildNodes(owner: FolderOwner, folder: FileTreeFolder, renames: ReadonlyMap<string, string>): TreeNode[] {
		return [
			...folder.folders.map(child => ({ type: 'folder' as const, owner, folder: child, renames })),
			...folder.files.map(filePath => fileNodeFor(owner, filePath, renames.get(filePath))),
		];
	}

	private fileDescription(filePath: string, renamedFrom: string | undefined): string | undefined {
		const parts = [this.listModeDescription(filePath), renamedFrom && renameDescription(filePath, renamedFrom)];
		return parts.filter(Boolean).join(' ') || undefined;
	}

	private listModeDescription(filePath: string): string | undefined {
		return this.viewMode === 'list' ? dirname(filePath) : undefined;
	}

	private debouncedRefresh(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			this.refresh().catch(err => {
				const msg = err instanceof Error ? err.message : String(err);
				this.outputChannel?.appendLine(`git-cl: Refresh error: ${msg}`);
			});
		}, 300);
	}

	async refresh(): Promise<void> {
		const token = ++this.refreshToken;
		const gitRoot = this.gitRoot;
		const changelistStore = this.changelistStore;
		const stashStore = this.stashStore;

		changelistStore.load();
		stashStore.load();

		let gitStatus: GitStatusMap;
		let renames = new Map<string, string>();
		try {
			({ status: gitStatus, renames } = await getGitStatusSnapshot(gitRoot));
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Failed to read git status: ${errMsg}`);
			gitStatus = new Map();
		}

		const headCommit = await getHeadCommit(gitRoot);
		if (token !== this.refreshToken || gitRoot !== this.gitRoot) {
			return;
		}

		this.cachedChangelists = changelistStore.getAll();
		this.cachedStashData = stashStore.getAll();
		this.cachedGitStatus = gitStatus;
		this.cachedRenames = renames;

		if (this.lastHeadCommit !== undefined && headCommit !== this.lastHeadCommit) {
			this.headContentProvider.reloadOpenDocuments();
		}
		this.lastHeadCommit = headCommit;

		// Compute unassigned files
		const assignedFiles = new Set<string>();
		for (const files of Object.values(this.cachedChangelists)) {
			for (const f of files) {
				assignedFiles.add(f);
			}
		}

		this.cachedUnassigned = unassignedFiles(gitStatus.keys(), assignedFiles, stashStore.getStashedFiles());

		// Check for files in changelists that no longer exist on disk
		const currentMissingFiles = new Set<string>();
		for (const files of Object.values(this.cachedChangelists)) {
			for (const filePath of files) {
				const status = gitStatus.get(filePath);
				const isGitDeleted = status !== undefined &&
					(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));
				if (!isGitDeleted && !fs.existsSync(path.join(this.gitRoot, filePath))) {
					currentMissingFiles.add(filePath);
				}
			}
		}

		// Warn about newly missing files (avoid repeating for already-warned files)
		const newlyMissing = [...currentMissingFiles].filter(f => !this.lastWarnedMissingFiles.has(f));
		if (newlyMissing.length > 0) {
			const fileList = newlyMissing.slice(0, 3).join(', ');
			const suffix = newlyMissing.length > 3 ? ` and ${newlyMissing.length - 3} more` : '';
			vscode.window.showWarningMessage(
				`git-cl: ${newlyMissing.length} file(s) in changelists no longer exist on disk: ${fileList}${suffix}`
			);
		}
		this.lastWarnedMissingFiles = currentMissingFiles;

		this._onDidChangeTreeData.fire(undefined);
	}

	/** The last refreshed state, for views that render the same data as the tree. */
	getBoardData(): BoardData {
		return {
			changelists: this.cachedChangelists,
			hiddenChangelists: Object.fromEntries(
				Object.entries(this.cachedStashData).map(([name, metadata]) => [name, metadata.files])
			),
			unassigned: this.cachedUnassigned,
			status: this.cachedGitStatus,
			renames: this.cachedRenames,
		};
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		const repoPrefix = `${this.gitRoot}:`;
		switch (element.type) {
			case 'changelist': {
				const files = this.cachedChangelists[element.name] ?? [];
				const item = new vscode.TreeItem(
					element.name,
					vscode.TreeItemCollapsibleState.Expanded
				);
				item.id = `${repoPrefix}cl:${element.name}`;
				item.contextValue = 'changelist';
				item.iconPath = new vscode.ThemeIcon('list-unordered');
				item.description = `${this.visibleFileCount({ type: 'changelist', name: element.name }, files)} file(s)`;
				return item;
			}

			case 'changelistFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `${repoPrefix}cl:${element.changelistName}:${element.filePath}`;
				item.contextValue = 'changelistFile';
				item.description = this.fileDescription(element.filePath, element.renamedFrom);
				item.command = this.createFileCommand(element.filePath, uri, element.renamedFrom);
				item.resourceUri = uri;
				this.applyFileDecorations(item, element.filePath, uri, element.renamedFrom);
				return item;
			}

			case 'unassignedSection': {
				const item = new vscode.TreeItem(
					'Unassigned',
					vscode.TreeItemCollapsibleState.Collapsed
				);
				item.id = `${repoPrefix}unassigned`;
				item.contextValue = 'unassignedSection';
				item.description = `${this.visibleFileCount({ type: 'unassigned' }, this.cachedUnassigned)} file(s)`;
				return item;
			}

			case 'unassignedFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `${repoPrefix}unassigned:${element.filePath}`;
				item.contextValue = 'unassignedFile';
				item.description = this.fileDescription(element.filePath, element.renamedFrom);
				item.command = this.createFileCommand(element.filePath, uri, element.renamedFrom);
				item.resourceUri = uri;
				this.applyFileDecorations(item, element.filePath, uri, element.renamedFrom);
				return item;
			}

			case 'stashedChangelist': {
				const item = new vscode.TreeItem(
					element.name,
					vscode.TreeItemCollapsibleState.Expanded
				);
				item.id = `${repoPrefix}stash:${element.name}`;
				item.contextValue = 'stashedChangelist';
				item.iconPath = new vscode.ThemeIcon('list-unordered');
				item.description = `${element.metadata.files.length} file(s)`;
				return item;
			}

			case 'stashedFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `${repoPrefix}stash:${element.stashName}:${element.filePath}`;
				item.contextValue = 'stashedFile';
				item.description = this.listModeDescription(element.filePath);
				item.resourceUri = uri;
				return item;
			}

			case 'folder': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.folder.path));
				const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Expanded);
				item.label = element.folder.label;
				item.id = `${repoPrefix}${folderOwnerId(element.owner)}:folder:${element.folder.path}`;
				item.contextValue = folderContextValue(element.owner);
				item.iconPath = vscode.ThemeIcon.Folder;
				item.tooltip = element.folder.path;
				return item;
			}
		}
	}

	getChildren(element?: TreeNode): TreeNode[] {
		if (!element) {
			// Root level
			const nodes: TreeNode[] = [];

			// Active changelists
			for (const name of Object.keys(this.cachedChangelists)) {
				nodes.push({ type: 'changelist', name });
			}

			// Hidden (stashed) changelists
			for (const [name, metadata] of Object.entries(this.cachedStashData)) {
				nodes.push({ type: 'stashedChangelist', name, metadata });
			}

			// Unassigned section (only if there are unassigned files)
			if (this.cachedUnassigned.length > 0) {
				nodes.push({ type: 'unassignedSection' });
			}

			return nodes;
		}

		switch (element.type) {
			case 'changelist':
				return this.childNodes(element, this.cachedChangelists[element.name] ?? []);

			case 'unassignedSection':
				return this.childNodes({ type: 'unassigned' }, this.cachedUnassigned);

			case 'stashedChangelist':
				return this.childNodes({ type: 'stash', name: element.name }, element.metadata.files);

			case 'folder':
				return this.folderChildNodes(element.owner, element.folder, element.renames);

			default:
				return [];
		}
	}

	handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): void {
		// Only allow dragging file nodes (changelist files and unassigned files)
		const draggable = expandFolderNodes(source).filter(
			n => n.type === 'changelistFile' || n.type === 'unassignedFile'
		);
		if (draggable.length > 0) {
			dataTransfer.set(TREE_MIME_TYPE, new vscode.DataTransferItem(draggable));
		}
	}

	async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
		const transferItem = dataTransfer.get(TREE_MIME_TYPE);
		if (!transferItem) {
			return;
		}

		const draggedNodes: TreeNode[] = transferItem.value;
		if (!draggedNodes || draggedNodes.length === 0) {
			return;
		}

		// Determine target changelist name
		let targetChangelist: string | undefined;
		if (target) {
			if (target.type === 'changelist') {
				targetChangelist = target.name;
			} else if (target.type === 'changelistFile') {
				targetChangelist = target.changelistName;
			} else if (target.type === 'folder' && target.owner.type === 'changelist') {
				targetChangelist = target.owner.name;
			}
		}

		// Dropping onto unassigned section or stashed items: remove from changelist
		if (!targetChangelist) {
			const isUnassignedTarget = target?.type === 'unassignedSection' || target?.type === 'unassignedFile' ||
				(target?.type === 'folder' && target.owner.type === 'unassigned');
			if (isUnassignedTarget) {
				const filePaths = draggedNodes
					.filter(n => n.type === 'changelistFile')
					.flatMap(nodeFilePaths);
				if (filePaths.length > 0) {
					await this.changelistStore.update(store => {
						for (const filePath of filePaths) {
							const clName = store.findChangelist(filePath);
							if (clName) {
								store.removeFiles(clName, [filePath]);
							}
						}
					});
					await this.refresh();
				}
			}
			return;
		}

		// Collect file paths from dragged nodes
		const filePaths = draggedNodes.flatMap(nodeFilePaths);

		if (filePaths.length === 0) {
			return;
		}

		try {
			await this.changelistStore.addFilesLocked(targetChangelist, filePaths, this.stashStore);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`git-cl: ${msg}`);
			return;
		}

		await this.refresh();
	}

	private createFileCommand(filePath: string, uri: vscode.Uri, renamedFrom?: string): vscode.Command {
		const status = this.cachedGitStatus.get(filePath) ?? '  ';
		const isDeleted = status[1] === 'D' || (status[0] === 'D' && status[1] === ' ');
		const isUntracked = status === '??';
		const isMissing = !isDeleted && !fs.existsSync(uri.fsPath);

		if (isUntracked || isMissing) {
			return { title: 'Open File', command: 'vscode.open', arguments: [uri] };
		}

		return {
			title: 'Open Diff',
			command: 'vscode.diff',
			arguments: [
				vscode.Uri.from({
					scheme: HEAD_SCHEME,
					path: `/${renamedFrom ?? filePath}`,
					query: encodeURIComponent(this.gitRoot),
				}),
				uri,
				renamedFrom
					? `${path.basename(renamedFrom)} → ${path.basename(filePath)} (Working Tree)`
					: `${path.basename(filePath)} (Working Tree)`,
			],
		};
	}

	private applyFileDecorations(item: vscode.TreeItem, filePath: string, uri: vscode.Uri, renamedFrom?: string): void {
		const status = this.cachedGitStatus.get(filePath) ?? '  ';
		const isDeleted = status[1] === 'D' || (status[0] === 'D' && status[1] === ' ');
		const isMissing = !isDeleted && !fs.existsSync(uri.fsPath);

		if (isMissing) {
			item.tooltip = `${filePath} [missing from disk]`;
			item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
		} else {
			item.tooltip = renamedFrom
				? `${renamedFrom} → ${filePath} [renamed]`
				: `${filePath} [${status.trim() || 'clean'}]`;
		}
	}

	getChangelistStore(): ChangelistStore {
		return this.changelistStore;
	}

	getStashStore(): StashStore {
		return this.stashStore;
	}

	getGitRoot(): string {
		return this.gitRoot;
	}

	/** Clears cached HEAD contents and notifies open `git-cl-head` diff editors to reload. */
	reloadHeadDocuments(): void {
		this.headContentProvider.reloadOpenDocuments();
	}

	dispose(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		for (const watcher of this.repoWatchers) {
			watcher.dispose();
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
