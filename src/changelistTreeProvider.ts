import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ChangelistStore } from './changelistStore';
import { StashStore, StashMetadata } from './stashStore';
import { getGitStatusSnapshot, getHeadCommit, GitStatusMap } from './gitUtils';
import { buildFileTree, collectFiles, dirname, FileTreeFolder, ViewMode } from './fileTree';

const HEAD_SCHEME = 'git-cl-head';

/**
 * TextDocumentContentProvider that returns file content at HEAD.
 * Used for showing diff (HEAD vs working copy) when clicking files.
 */
class HeadContentProvider implements vscode.TextDocumentContentProvider {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly gitRoot: string) {}

	/** VS Code caches provided content, so loaded HEAD documents must be told when HEAD moves. */
	reloadOpenDocuments(): void {
		for (const document of vscode.workspace.textDocuments) {
			if (document.uri.scheme === HEAD_SCHEME) {
				this.changeEmitter.fire(document.uri);
			}
		}
	}

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

	private readonly changelistStore: ChangelistStore;
	private readonly stashStore: StashStore;
	private readonly disposables: vscode.Disposable[] = [];

	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	private lastWarnedMissingFiles = new Set<string>();

	// Cached data from last refresh
	private cachedChangelists: Record<string, string[]> = {};
	private cachedStashData: Record<string, StashMetadata> = {};
	private cachedGitStatus: GitStatusMap = new Map();
	private cachedRenames = new Map<string, string>();
	private cachedUnassigned: string[] = [];

	private readonly gitCommonDir: string;
	private readonly headContentProvider: HeadContentProvider;
	private lastHeadCommit: string | null | undefined;

	constructor(private readonly gitRoot: string, private readonly outputChannel?: vscode.OutputChannel, gitCommonDir?: string) {
		this.gitCommonDir = gitCommonDir ?? path.join(gitRoot, '.git');
		this.changelistStore = new ChangelistStore(gitRoot, this.gitCommonDir);
		this.stashStore = new StashStore(gitRoot, this.gitCommonDir);

		// Register HEAD content provider for diffs
		this.headContentProvider = new HeadContentProvider(gitRoot);
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, this.headContentProvider)
		);

		this.setupWatchers();
		this.refresh().catch(err => {
			const msg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Initial refresh error: ${msg}`);
		});
	}

	private setupWatchers(): void {
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

	/** Renames (new path → original) whose both sides are in the same group, shown as one item like VS Code's Source Control. */
	private groupedRenames(owner: FolderOwner, files: readonly string[]): Map<string, string> {
		const renames = new Map<string, string>();
		if (owner.type === 'stash') {
			return renames;
		}
		const fileSet = new Set(files);
		for (const [newPath, originalPath] of this.cachedRenames) {
			if (fileSet.has(newPath) && fileSet.has(originalPath)) {
				renames.set(newPath, originalPath);
			}
		}
		return renames;
	}

	private visibleFiles(files: readonly string[], renames: ReadonlyMap<string, string>): string[] {
		const hidden = new Set(renames.values());
		return files.filter(file => !hidden.has(file));
	}

	private visibleFileCount(owner: FolderOwner, files: readonly string[]): number {
		return this.visibleFiles(files, this.groupedRenames(owner, files)).length;
	}

	private childNodes(owner: FolderOwner, files: readonly string[]): TreeNode[] {
		const renames = this.groupedRenames(owner, files);
		const visible = this.visibleFiles(files, renames);
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
		this.changelistStore.load();
		this.stashStore.load();

		let gitStatus: GitStatusMap;
		let renames = new Map<string, string>();
		try {
			({ status: gitStatus, renames } = await getGitStatusSnapshot(this.gitRoot));
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Failed to read git status: ${errMsg}`);
			gitStatus = new Map();
		}

		this.cachedChangelists = this.changelistStore.getAll();
		this.cachedStashData = this.stashStore.getAll();
		this.cachedGitStatus = gitStatus;
		this.cachedRenames = renames;

		const headCommit = await getHeadCommit(this.gitRoot);
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
				item.description = `${this.visibleFileCount({ type: 'changelist', name: element.name }, files)} file(s)`;
				return item;
			}

			case 'changelistFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `cl:${element.changelistName}:${element.filePath}`;
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
				item.id = 'unassigned';
				item.contextValue = 'unassignedSection';
				item.description = `${this.visibleFileCount({ type: 'unassigned' }, this.cachedUnassigned)} file(s)`;
				return item;
			}

			case 'unassignedFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `unassigned:${element.filePath}`;
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
				item.id = `stash:${element.name}`;
				item.contextValue = 'stashedChangelist';
				item.iconPath = new vscode.ThemeIcon('list-unordered');
				item.description = `${element.metadata.files.length} file(s)`;
				return item;
			}

			case 'stashedFile': {
				const uri = vscode.Uri.file(path.join(this.gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `stash:${element.stashName}:${element.filePath}`;
				item.contextValue = 'stashedFile';
				item.description = this.listModeDescription(element.filePath);
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
		const filePaths = draggedNodes.flatMap(nodeFilePaths);

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
				vscode.Uri.from({ scheme: HEAD_SCHEME, path: `/${renamedFrom ?? filePath}` }),
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

	dispose(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
