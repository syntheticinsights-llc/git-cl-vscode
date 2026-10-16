import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ChangelistStore } from './changelistStore';
import { StashStore, StashMetadata } from './stashStore';
import { getGitStatus, GitStatusMap } from './gitUtils';
import { buildFileTree, collectFiles, dirname, FileTreeFolder, ViewMode } from './fileTree';

const HEAD_SCHEME = 'git-cl-head';

/**
 * TextDocumentContentProvider that returns file content at HEAD.
 * Used for showing diff (HEAD vs working copy) when clicking files.
 */
class HeadContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly gitRoot: string) {}

	provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const relativePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
		return new Promise((resolve) => {
			execFile(
				'git',
				['show', `HEAD:${relativePath}`],
				{ cwd: this.gitRoot, maxBuffer: 10 * 1024 * 1024 },
				(error, stdout) => {
					if (error) {
						// File doesn't exist at HEAD (new/untracked file)
						resolve('');
						return;
					}
					resolve(stdout);
				}
			);
		});
	}
}

function formatStashLabel(name: string, meta: StashMetadata): string {
	const date = new Date(meta.timestamp).toLocaleDateString();
	return `${name} (stashed from ${meta.source_branch}, ${date})`;
}

export type FolderOwner =
	| { type: 'changelist'; name: string }
	| { type: 'unassigned' }
	| { type: 'stash'; name: string };

export type TreeNode =
	| { type: 'changelist'; name: string }
	| { type: 'changelistFile'; filePath: string; changelistName: string }
	| { type: 'unassignedSection' }
	| { type: 'unassignedFile'; filePath: string }
	| { type: 'stashedChangelist'; name: string; metadata: StashMetadata }
	| { type: 'stashedFile'; filePath: string; stashName: string }
	| { type: 'folder'; owner: FolderOwner; folder: FileTreeFolder };

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
		return collectFiles(node.folder).map(filePath => fileNodeFor(node.owner, filePath));
	});
}

function fileNodeFor(owner: FolderOwner, filePath: string): TreeNode {
	switch (owner.type) {
		case 'changelist': return { type: 'changelistFile', filePath, changelistName: owner.name };
		case 'unassigned': return { type: 'unassignedFile', filePath };
		case 'stash': return { type: 'stashedFile', filePath, stashName: owner.name };
	}
}

const TREE_MIME_TYPE = 'application/vnd.code.tree.git-cl.changelists';

/**
 * TreeDataProvider that surfaces changelists in a TreeView within the
 * Source Control sidebar.
 *
 * Tree structure: [active changelists] → Unassigned → [stashed changelists].
 */
export class ChangelistTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>, vscode.Disposable {
	readonly dropMimeTypes = [TREE_MIME_TYPE];
	readonly dragMimeTypes = [TREE_MIME_TYPE];
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly changelistStore: ChangelistStore;
	private readonly stashStore: StashStore;
	private readonly disposables: vscode.Disposable[] = [];

	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	private lastWarnedMissingFiles = new Set<string>();

	// Cached data from last refresh
	private cachedChangelists: Record<string, string[]> = {};
	private cachedStashData: Record<string, StashMetadata> = {};
	private cachedGitStatus: GitStatusMap = new Map();
	private cachedUnassigned: string[] = [];

	private readonly gitCommonDir: string;

	constructor(private readonly gitRoot: string, private readonly outputChannel?: vscode.OutputChannel, gitCommonDir?: string) {
		this.gitCommonDir = gitCommonDir ?? path.join(gitRoot, '.git');
		this.changelistStore = new ChangelistStore(gitRoot, this.gitCommonDir);
		this.stashStore = new StashStore(gitRoot, this.gitCommonDir);

		// Register HEAD content provider for diffs
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(
				HEAD_SCHEME,
				new HeadContentProvider(gitRoot)
			)
		);

		this.setupWatchers();
		this.refresh().catch(err => {
			const msg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Initial refresh error: ${msg}`);
		});
	}

	private setupWatchers(): void {
		const gitDir = this.gitCommonDir;

		// Watch cl.json, cl-stashes.json, git index, and HEAD (for branch switches)
		const patterns = ['cl.json', 'cl-stashes.json', 'index', 'HEAD'];
		for (const file of patterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(gitDir), file)
			);
			watcher.onDidChange(() => this.debouncedRefresh());
			watcher.onDidCreate(() => this.debouncedRefresh());
			watcher.onDidDelete(() => this.debouncedRefresh());
			this.disposables.push(watcher);
		}

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

	private get viewMode(): ViewMode {
		return vscode.workspace.getConfiguration('git-cl').get<ViewMode>('viewMode', 'tree');
	}

	private get compactFolders(): boolean {
		return vscode.workspace.getConfiguration('scm').get<boolean>('compactFolders', true);
	}

	private updateViewModeContext(): void {
		vscode.commands.executeCommand('setContext', VIEW_MODE_CONTEXT_KEY, this.viewMode);
	}

	private childNodes(owner: FolderOwner, files: readonly string[]): TreeNode[] {
		if (this.viewMode === 'list') {
			return [...files]
				.sort((a, b) => pathCollator.compare(a, b))
				.map(filePath => fileNodeFor(owner, filePath));
		}
		return this.folderChildNodes(owner, buildFileTree(files, this.compactFolders));
	}

	private folderChildNodes(owner: FolderOwner, folder: FileTreeFolder): TreeNode[] {
		return [
			...folder.folders.map(child => ({ type: 'folder' as const, owner, folder: child })),
			...folder.files.map(filePath => fileNodeFor(owner, filePath)),
		];
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
		this.changelistStore.load();
		this.stashStore.load();

		let gitStatus: GitStatusMap;
		try {
			gitStatus = await getGitStatus(this.gitRoot);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Failed to read git status: ${errMsg}`);
			gitStatus = new Map();
		}

		this.cachedChangelists = this.changelistStore.getAll();
		this.cachedStashData = this.stashStore.getAll();
		this.cachedGitStatus = gitStatus;

		// Compute unassigned files
		const assignedFiles = new Set<string>();
		for (const files of Object.values(this.cachedChangelists)) {
			for (const f of files) {
				assignedFiles.add(f);
			}
		}

		const stashedFiles = this.stashStore.getStashedFiles();
		this.cachedUnassigned = [];
		for (const [filePath] of gitStatus) {
			if (!assignedFiles.has(filePath) && !stashedFiles.has(filePath)) {
				this.cachedUnassigned.push(filePath);
			}
		}

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

	getTreeItem(element: TreeNode): vscode.TreeItem {
		switch (element.type) {
			case 'changelist': {
				const files = this.cachedChangelists[element.name] ?? [];
				const item = new vscode.TreeItem(
					element.name,
					vscode.TreeItemCollapsibleState.Expanded
				);
				item.id = `cl:${element.name}`;
				item.contextValue = 'changelist';
				item.iconPath = new vscode.ThemeIcon('list-unordered');
				item.description = `${files.length} file(s)`;
				return item;
			}

			case 'changelistFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `cl:${element.changelistName}:${element.filePath}`;
				item.contextValue = 'changelistFile';
				item.description = this.listModeDescription(element.filePath);
				item.command = this.createFileCommand(element.filePath, uri);
				item.resourceUri = uri;
				this.applyFileDecorations(item, element.filePath, uri);
				return item;
			}

			case 'unassignedSection': {
				const item = new vscode.TreeItem(
					'Unassigned',
					vscode.TreeItemCollapsibleState.Collapsed
				);
				item.id = 'unassigned';
				item.contextValue = 'unassignedSection';
				item.description = `${this.cachedUnassigned.length} file(s)`;
				return item;
			}

			case 'unassignedFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `unassigned:${element.filePath}`;
				item.contextValue = 'unassignedFile';
				item.description = this.listModeDescription(element.filePath);
				item.command = this.createFileCommand(element.filePath, uri);
				item.resourceUri = uri;
				this.applyFileDecorations(item, element.filePath, uri);
				return item;
			}

			case 'stashedChangelist': {
				const item = new vscode.TreeItem(
					formatStashLabel(element.name, element.metadata),
					vscode.TreeItemCollapsibleState.Collapsed
				);
				item.id = `stash:${element.name}`;
				item.contextValue = 'stashedChangelist';
				item.iconPath = new vscode.ThemeIcon('archive');
				return item;
			}

			case 'stashedFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `stash:${element.stashName}:${element.filePath}`;
				item.contextValue = 'stashedFile';
				item.description = [this.listModeDescription(element.filePath), '(stashed)'].filter(Boolean).join(' ');
				item.resourceUri = uri;
				return item;
			}

			case 'folder': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.folder.path));
				const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Expanded);
				item.label = element.folder.label;
				item.id = `${folderOwnerId(element.owner)}:folder:${element.folder.path}`;
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

			// Unassigned section (only if there are unassigned files)
			if (this.cachedUnassigned.length > 0) {
				nodes.push({ type: 'unassignedSection' });
			}

			// Stashed changelists
			for (const [name, metadata] of Object.entries(this.cachedStashData)) {
				nodes.push({ type: 'stashedChangelist', name, metadata });
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
				return this.folderChildNodes(element.owner, element.folder);

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
					.filter((n): n is Extract<TreeNode, { type: 'changelistFile' }> => n.type === 'changelistFile')
					.map(n => n.filePath);
				if (filePaths.length > 0) {
					for (const filePath of filePaths) {
						const clName = this.changelistStore.findChangelist(filePath);
						if (clName) {
							this.changelistStore.removeFiles(clName, [filePath]);
						}
					}
					this.changelistStore.save();
					await this.refresh();
				}
			}
			return;
		}

		// Collect file paths from dragged nodes
		const filePaths = draggedNodes
			.filter((n): n is Extract<TreeNode, { type: 'changelistFile' | 'unassignedFile' }> =>
				n.type === 'changelistFile' || n.type === 'unassignedFile'
			)
			.map(n => n.filePath);

		if (filePaths.length === 0) {
			return;
		}

		try {
			this.changelistStore.addFiles(targetChangelist, filePaths, this.stashStore);
			this.changelistStore.save();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`git-cl: ${msg}`);
			return;
		}

		await this.refresh();
	}

	private createFileCommand(filePath: string, uri: vscode.Uri): vscode.Command {
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
				vscode.Uri.from({ scheme: HEAD_SCHEME, path: `/${filePath}` }),
				uri,
				`${path.basename(filePath)} (Working Tree)`,
			],
		};
	}

	private applyFileDecorations(item: vscode.TreeItem, filePath: string, uri: vscode.Uri): void {
		const status = this.cachedGitStatus.get(filePath) ?? '  ';
		const isDeleted = status[1] === 'D' || (status[0] === 'D' && status[1] === ' ');
		const isMissing = !isDeleted && !fs.existsSync(uri.fsPath);

		if (isMissing) {
			item.tooltip = `${filePath} [missing from disk]`;
			item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
		} else {
			item.tooltip = `${filePath} [${status.trim() || 'clean'}]`;
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

	dispose(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
