import * as vscode from 'vscode';
import * as path from 'path';
import { buildFileTree, dirname, FileTreeFolder } from '../core/fileTree';
import { ChangelistWorkspace } from './changelistWorkspace';
import {
	ChangelistFileNode,
	expandFolderNodes,
	FILE_DRAG_MIME,
	fileNodeFor,
	folderContextValue,
	formatGroupDescription,
	formatLineStats,
	groupLabel,
	GroupRef,
	groupRefKey,
	renameDescription,
} from './treeNodes';

const pathCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Displays the files belonging to the currently selected group in [ChangelistWorkspace].
 * Files and folders can be dragged onto any group in [ChangelistListProvider].
 */
export class ChangelistFilesProvider
	implements vscode.TreeDataProvider<ChangelistFileNode>, vscode.TreeDragAndDropController<ChangelistFileNode>, vscode.Disposable
{
	readonly dragMimeTypes: readonly string[] = [FILE_DRAG_MIME];
	readonly dropMimeTypes: readonly string[] = [];

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ChangelistFileNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly subscriptions: vscode.Disposable[];

	constructor(private readonly workspace: ChangelistWorkspace) {
		this.subscriptions = [
			workspace.onDidChangeData(() => this._onDidChangeTreeData.fire(undefined)),
			workspace.onDidChangeSelection(() => this._onDidChangeTreeData.fire(undefined)),
		];
	}

	/** Keeps the Files view header and empty-state message aligned with the active selection. */
	syncViewChrome(treeView: vscode.TreeView<ChangelistFileNode>): void {
		const selected = this.workspace.getSelectedGroup();
		if (!selected) {
			treeView.title = 'Files';
			treeView.description = undefined;
			treeView.message = 'No changes in this repository.';
			return;
		}
		const visibleCount = this.workspace.getVisibleFiles(selected).length;
		const stats = this.workspace.getGroupLineStats(selected);
		const suffix = selected.type === 'stash' ? 'hidden' : undefined;
		treeView.title = groupLabel(selected);
		treeView.description = formatGroupDescription(visibleCount, stats, suffix);
		treeView.message = visibleCount === 0 ? 'This changelist has no files.' : undefined;
	}

	getChildren(element?: ChangelistFileNode): ChangelistFileNode[] {
		if (!element) {
			const selected = this.workspace.getSelectedGroup();
			if (!selected) {
				return [];
			}
			const renames = this.workspace.getGroupRenames(selected);
			const visible = this.workspace.getVisibleFiles(selected);
			if (this.workspace.getViewMode() === 'list') {
				return [...visible]
					.sort((a, b) => pathCollator.compare(a, b))
					.map(filePath => fileNodeFor(selected, filePath, renames.get(filePath)));
			}
			return this.folderChildNodes(selected, buildFileTree(visible, this.workspace.getCompactFolders()), renames);
		}

		if (element.type === 'folder') {
			return this.folderChildNodes(element.owner, element.folder, element.renames);
		}
		return [];
	}

	getTreeItem(element: ChangelistFileNode): vscode.TreeItem {
		const gitRoot = this.workspace.getGitRoot();
		const repoPrefix = `${gitRoot}:`;

		switch (element.type) {
			case 'changelistFile': {
				const uri = vscode.Uri.file(path.join(gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `${repoPrefix}cl:${element.changelistName}:${element.filePath}`;
				item.contextValue = 'changelistFile';
				item.description = this.fileDescription(element.filePath, element.renamedFrom, true);
				item.command = this.openDiffCommand(element);
				item.resourceUri = uri;
				this.applyFileDecorations(item, element.filePath, element.renamedFrom);
				return item;
			}
			case 'unassignedFile': {
				const uri = vscode.Uri.file(path.join(gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `${repoPrefix}unassigned:${element.filePath}`;
				item.contextValue = 'unassignedFile';
				item.description = this.fileDescription(element.filePath, element.renamedFrom, true);
				item.command = this.openDiffCommand(element);
				item.resourceUri = uri;
				this.applyFileDecorations(item, element.filePath, element.renamedFrom);
				return item;
			}
			case 'stashedFile': {
				const uri = vscode.Uri.file(path.join(gitRoot, element.filePath));
				const item = new vscode.TreeItem(uri);
				item.id = `${repoPrefix}stash:${element.stashName}:${element.filePath}`;
				item.contextValue = 'stashedFile';
				item.description = this.fileDescription(element.filePath, undefined, false);
				item.resourceUri = uri;
				item.tooltip = `${element.filePath} [hidden]`;
				return item;
			}
			case 'folder': {
				const uri = vscode.Uri.file(path.join(gitRoot, element.folder.path));
				const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Expanded);
				item.label = element.folder.label;
				item.id = `${repoPrefix}${groupRefKey(element.owner)}:folder:${element.folder.path}`;
				item.contextValue = folderContextValue(element.owner);
				item.iconPath = vscode.ThemeIcon.Folder;
				item.tooltip = element.folder.path;
				return item;
			}
		}
	}

	handleDrag(source: readonly ChangelistFileNode[], dataTransfer: vscode.DataTransfer): void {
		const draggable = expandFolderNodes(source).filter(
			(node): node is ChangelistFileNode => node.type === 'changelistFile' || node.type === 'unassignedFile'
		);
		if (draggable.length > 0) {
			dataTransfer.set(FILE_DRAG_MIME, new vscode.DataTransferItem(draggable));
		}
	}

	handleDrop(): void {
		// Files are dropped onto groups in ChangelistListProvider.
	}

	dispose(): void {
		for (const sub of this.subscriptions) {
			sub.dispose();
		}
		this._onDidChangeTreeData.dispose();
	}

	private folderChildNodes(
		owner: GroupRef,
		folder: FileTreeFolder,
		renames: ReadonlyMap<string, string>
	): ChangelistFileNode[] {
		return [
			...folder.folders.map(child => ({ type: 'folder' as const, owner, folder: child, renames })),
			...folder.files.map(filePath => fileNodeFor(owner, filePath, renames.get(filePath))),
		];
	}

	private fileDescription(
		filePath: string,
		renamedFrom: string | undefined,
		includeStats: boolean
	): string | undefined {
		const folderHint = this.workspace.getViewMode() === 'list' ? dirname(filePath) : undefined;
		const renameHint = renamedFrom ? renameDescription(filePath, renamedFrom) : undefined;
		const statsHint = includeStats ? formatLineStats(this.workspace.getFileLineStats(filePath)) : undefined;
		const parts = [folderHint, renameHint, statsHint].filter((p): p is string => Boolean(p));
		return parts.join(' · ') || undefined;
	}

	private openDiffCommand(node: ChangelistFileNode): vscode.Command {
		return {
			title: 'Open Diff',
			command: 'git-cl.openFileDiff',
			arguments: [node, { preview: true }],
		};
	}

	private applyFileDecorations(item: vscode.TreeItem, filePath: string, renamedFrom?: string): void {
		if (this.workspace.isFileMissing(filePath)) {
			item.tooltip = `${filePath} [missing from disk]`;
			item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
			return;
		}
		const status = this.workspace.getFileStatus(filePath) ?? '  ';
		item.tooltip = renamedFrom
			? `${renamedFrom} → ${filePath} [renamed]`
			: `${filePath} [${status.trim() || 'clean'}]`;
	}
}
