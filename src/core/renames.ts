/**
 * Rename handling shared by the Source Control tree and the board, so a rename
 * shows up the same way in both: as one file with its original name attached,
 * never as an add plus a delete.
 */

/** Renames whose both sides belong to the same group; a cross-group rename stays two entries. */
export function groupedRenames(
	renames: ReadonlyMap<string, string>,
	files: readonly string[]
): Map<string, string> {
	const fileSet = new Set(files);
	const grouped = new Map<string, string>();
	for (const [newPath, originalPath] of renames) {
		if (fileSet.has(newPath) && fileSet.has(originalPath)) {
			grouped.set(newPath, originalPath);
		}
	}
	return grouped;
}

/** Files with the original half of a grouped rename removed. */
export function visibleFiles(files: readonly string[], renames: ReadonlyMap<string, string>): string[] {
	const hidden = new Set(renames.values());
	return files.filter(file => !hidden.has(file));
}
