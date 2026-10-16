export type ViewMode = 'tree' | 'list';

export interface FileTreeFolder {
	path: string;
	label: string;
	folders: FileTreeFolder[];
	files: string[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function basename(filePath: string): string {
	return filePath.substring(filePath.lastIndexOf('/') + 1);
}

/**
 * Builds a folder hierarchy from repository-relative file paths, ordered like
 * VS Code's Source Control tree: folders first, then files, by natural name order.
 * With `compact`, single-child folder chains collapse into one node (e.g. "lib/src/util").
 */
export function buildFileTree(files: readonly string[], compact: boolean): FileTreeFolder {
	const root: FileTreeFolder = { path: '', label: '', folders: [], files: [] };
	const foldersByPath = new Map<string, FileTreeFolder>([['', root]]);

	for (const file of files) {
		const segments = file.split('/');
		let parent = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const folderPath = segments.slice(0, i + 1).join('/');
			let folder = foldersByPath.get(folderPath);
			if (!folder) {
				folder = { path: folderPath, label: segments[i], folders: [], files: [] };
				foldersByPath.set(folderPath, folder);
				parent.folders.push(folder);
			}
			parent = folder;
		}
		parent.files.push(file);
	}

	sortFolder(root);
	if (compact) {
		root.folders = root.folders.map(compactFolder);
	}
	return root;
}

function sortFolder(folder: FileTreeFolder): void {
	folder.folders.sort((a, b) => collator.compare(a.label, b.label));
	folder.files.sort((a, b) => collator.compare(basename(a), basename(b)));
	folder.folders.forEach(sortFolder);
}

function compactFolder(folder: FileTreeFolder): FileTreeFolder {
	let current = folder;
	let label = folder.label;
	while (current.files.length === 0 && current.folders.length === 1) {
		current = current.folders[0];
		label = `${label}/${current.label}`;
	}
	return {
		path: current.path,
		label,
		folders: current.folders.map(compactFolder),
		files: current.files,
	};
}

/** All file paths contained in the folder, recursively. */
export function collectFiles(folder: FileTreeFolder): string[] {
	return [...folder.files, ...folder.folders.flatMap(collectFiles)];
}

/** Folder part of a repository-relative path, or undefined for root-level files. */
export function dirname(filePath: string): string | undefined {
	const index = filePath.lastIndexOf('/');
	return index === -1 ? undefined : filePath.substring(0, index);
}
