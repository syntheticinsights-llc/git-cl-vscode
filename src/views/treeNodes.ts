import * as path from 'path';
import { collectFiles, dirname, FileTreeFolder } from '../core/fileTree';
import { StashMetadata } from '../core/stashStore';
import { LineStats } from '../core/untrackedStats';

/** Custom MIME type shared between the files view (drag source) and changelists view (drop target). */
export const FILE_DRAG_MIME = 'application/vnd.code.tree.git-cl.files';

/** Identifies which group of files is selected or owns a folder/file node. */
export type GroupRef =
	| { type: 'changelist'; name: string }
	| { type: 'unassigned' }
	| { type: 'stash'; name: string };

/** Root-level entries rendered in the Changelists view. */
export type ChangelistGroupNode =
	| { type: 'changelist'; name: string }
	| { type: 'stashedChangelist'; name: string; metadata: StashMetadata }
	| { type: 'unassignedSection' };

/** File and folder entries rendered in the Files view for the selected group. */
export type ChangelistFileNode =
	| { type: 'changelistFile'; filePath: string; changelistName: string; renamedFrom?: string }
	| { type: 'unassignedFile'; filePath: string; renamedFrom?: string }
	| { type: 'stashedFile'; filePath: string; stashName: string }
	| { type: 'folder'; owner: GroupRef; folder: FileTreeFolder; renames: ReadonlyMap<string, string> };

export type TreeNode = ChangelistGroupNode | ChangelistFileNode;

export function groupRefOf(node: ChangelistGroupNode): GroupRef {
	switch (node.type) {
		case 'changelist': return { type: 'changelist', name: node.name };
		case 'stashedChangelist': return { type: 'stash', name: node.name };
		case 'unassignedSection': return { type: 'unassigned' };
	}
}

export function groupRefKey(ref: GroupRef): string {
	switch (ref.type) {
		case 'changelist': return `cl:${ref.name}`;
		case 'unassigned': return 'unassigned';
		case 'stash': return `stash:${ref.name}`;
	}
}

export function sameGroupRef(a: GroupRef | undefined, b: GroupRef | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return groupRefKey(a) === groupRefKey(b);
}

export function groupLabel(ref: GroupRef): string {
	switch (ref.type) {
		case 'changelist': return ref.name;
		case 'stash': return ref.name;
		case 'unassigned': return 'Unassigned';
	}
}

export function folderContextValue(owner: GroupRef): string {
	switch (owner.type) {
		case 'changelist': return 'changelistFolder';
		case 'unassigned': return 'unassignedFolder';
		case 'stash': return 'stashedFolder';
	}
}

/** Expands folder nodes into the file nodes they contain; other nodes pass through. */
export function expandFolderNodes(nodes: readonly TreeNode[]): TreeNode[] {
	return nodes.flatMap<TreeNode>(node => {
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

export function fileNodeFor(owner: GroupRef, filePath: string, renamedFrom?: string): ChangelistFileNode {
	switch (owner.type) {
		case 'changelist': return { type: 'changelistFile', filePath, changelistName: owner.name, renamedFrom };
		case 'unassigned': return { type: 'unassignedFile', filePath, renamedFrom };
		case 'stash': return { type: 'stashedFile', filePath, stashName: owner.name };
	}
}

export function renameDescription(filePath: string, renamedFrom: string): string {
	return dirname(filePath) === dirname(renamedFrom) ? `← ${path.posix.basename(renamedFrom)}` : `← ${renamedFrom}`;
}

export function formatLineStats(stats: LineStats | undefined): string | undefined {
	if (!stats || (stats.additions === 0 && stats.deletions === 0)) {
		return undefined;
	}
	const parts: string[] = [];
	if (stats.additions > 0) {
		parts.push(`+${stats.additions}`);
	}
	if (stats.deletions > 0) {
		parts.push(`-${stats.deletions}`);
	}
	return parts.join(' ');
}

export function formatGroupDescription(fileCount: number, stats?: LineStats, suffix?: string): string {
	const countText = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
	const parts = [countText, formatLineStats(stats), suffix].filter((p): p is string => Boolean(p));
	return parts.join(' · ');
}
