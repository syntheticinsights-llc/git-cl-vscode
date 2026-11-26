/**
 * Files git reports as changed that no changelist and no hidden changelist
 * claims. Shared by the Source Control tree and the board so both agree on
 * what "Unassigned" means.
 */
export function unassignedFiles(
	paths: Iterable<string>,
	assigned: ReadonlySet<string>,
	stashed: ReadonlySet<string>
): string[] {
	const files: string[] = [];
	for (const filePath of paths) {
		if (!assigned.has(filePath) && !stashed.has(filePath)) {
			files.push(filePath);
		}
	}
	return files;
}
