import { StashStore } from './stashStore';

export type HiddenChangelistSource = Pick<StashStore, 'getNames'>;
export type HiddenFileSource = Pick<StashStore, 'getAll'>;

const ASK_USER = 'is hidden by the user (stashed). Do not edit its files; ask the user before continuing.';

export class HiddenChangelistError extends Error {
	constructor(readonly lines: readonly string[]) {
		super(lines.join('\n'));
		this.name = 'HiddenChangelistError';
	}
}

export function findHiddenChangelists(names: Iterable<string>, stashes: HiddenChangelistSource): string[] {
	const hidden = new Set(stashes.getNames());
	return [...new Set(names)].filter(name => hidden.has(name));
}

export function assertNotHidden(names: Iterable<string>, stashes: HiddenChangelistSource): void {
	const hidden = findHiddenChangelists(names, stashes);
	if (hidden.length > 0) {
		throw new HiddenChangelistError(hidden.map(name => `Changelist "${name}" ${ASK_USER}`));
	}
}

export function assertFilesNotHidden(files: Iterable<string>, stashes: HiddenFileSource): void {
	const owners = new Map<string, string>();
	for (const [name, metadata] of Object.entries(stashes.getAll())) {
		metadata.files.forEach(file => owners.set(file, name));
	}
	const lines = [...new Set(files)]
		.filter(file => owners.has(file))
		.map(file => `File "${file}" belongs to changelist "${owners.get(file)}", which ${ASK_USER}`);
	if (lines.length > 0) {
		throw new HiddenChangelistError(lines);
	}
}
