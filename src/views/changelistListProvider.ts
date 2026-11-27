import * as vscode from 'vscode';
import { ChangelistWorkspace } from './changelistWorkspace';
import {
	ChangelistFileNode,
	ChangelistGroupNode,
	FILE_DRAG_MIME,
	formatGroupDescription,
	groupRefKey,
	groupRefOf,
	nodeFilePaths,
} from './treeNodes';

/**
 * Flat list of changelists, hidden changelists, and Unassigned.
 * Selecting a row drives the companion [ChangelistFilesProvider].
 */
export class ChangelistListProvider
	implements vscode.TreeDataProvider<ChangelistGroupNode>, vscode.TreeDragAndDropController<ChangelistGroupNode>, vscode.Disposable
{
	readonly dragMimeTypes: readonly string[] = [];
	readonly dropMimeTypes: readonly string[] = [FILE_DRAG_MIME];

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ChangelistGroupNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly subscription: vscode.Disposable;

	constructor(private readonly workspace: ChangelistWorkspace) {
		this.subscription = workspace.onDidChangeData(() => this._onDidChangeTreeData.fire(undefined));
	}

	/** Keeps the view title badge in step with how many changelists the list holds. */
	syncViewChrome(treeView: vscode.TreeView<ChangelistGroupNode>): void {
		const changelists = this.workspace
			.getGroupNodes()
			.filter(node => node.type === 'changelist' || node.type === 'stashedChangelist').length;
		if (changelists === 0) {
			treeView.badge = undefined;
			return;
		}
		treeView.badge = {
			value: changelists,
			tooltip: `${changelists} ${changelists === 1 ? 'changelist' : 'changelists'}`,
		};
	}

	getParent(): undefined {
		return undefined;
	}

	getChildren(element?: ChangelistGroupNode): ChangelistGroupNode[] {
		return element ? [] : this.workspace.getGroupNodes();
	}

	getTreeItem(element: ChangelistGroupNode): vscode.TreeItem {
		const repoPrefix = `${this.workspace.getGitRoot()}:`;
		const ref = groupRefOf(element);
		const fileCount = this.workspace.getVisibleFiles(ref).length;
		const stats = this.workspace.getGroupLineStats(ref);

		switch (element.type) {
			case 'changelist': {
				const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
				item.id = `${repoPrefix}${groupRefKey(ref)}`;
				item.contextValue = 'changelist';
				item.iconPath = new vscode.ThemeIcon('list-unordered');
				item.description = formatGroupDescription(fileCount, stats);
				return item;
			}
			case 'stashedChangelist': {
				const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
				item.id = `${repoPrefix}${groupRefKey(ref)}`;
				item.contextValue = 'stashedChangelist';
				item.iconPath = new vscode.ThemeIcon('eye-closed');
				item.description = formatGroupDescription(element.metadata.files.length, undefined, 'hidden');
				item.tooltip = `Hidden changelist (stashed from ${element.metadata.source_branch})`;
				return item;
			}
			case 'unassignedSection': {
				const item = new vscode.TreeItem('Unassigned', vscode.TreeItemCollapsibleState.None);
				item.id = `${repoPrefix}${groupRefKey(ref)}`;
				item.contextValue = 'unassignedSection';
				item.iconPath = new vscode.ThemeIcon('circle-outline');
				item.description = formatGroupDescription(fileCount, stats);
				return item;
			}
		}
	}

	handleDrag(): void {
		// Groups themselves are drop targets, not draggable.
	}

	async handleDrop(
		target: ChangelistGroupNode | undefined,
		dataTransfer: vscode.DataTransfer
	): Promise<void> {
		if (!target) {
			return;
		}
		const transferItem = dataTransfer.get(FILE_DRAG_MIME);
		if (!transferItem) {
			return;
		}
		const draggedNodes = transferItem.value as ChangelistFileNode[] | undefined;
		if (!draggedNodes || draggedNodes.length === 0) {
			return;
		}

		if (target.type === 'changelist') {
			await this.workspace.assignFiles(target.name, draggedNodes.flatMap(nodeFilePaths));
			return;
		}
		if (target.type === 'unassignedSection') {
			const filePaths = draggedNodes
				.filter(node => node.type === 'changelistFile')
				.flatMap(nodeFilePaths);
			await this.workspace.removeFiles(filePaths);
		}
	}

	dispose(): void {
		this.subscription.dispose();
		this._onDidChangeTreeData.dispose();
	}
}
