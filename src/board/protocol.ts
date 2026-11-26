/**
 * Wire format between the changelist board webview and the extension host.
 *
 * The board keeps no state of its own: a webview is torn down and rebuilt
 * whenever its editor moves between windows or is hidden, so every render
 * starts from the latest [BoardSnapshot] the host pushes.
 */

/** Letters Source Control uses: modified, added, deleted, renamed, untracked, conflict. */
export type FileStatusCode = 'M' | 'A' | 'D' | 'R' | 'U' | '!';

/** A file in a changelist that git reports as unchanged on disk. */
export const NO_STATUS = 'none';

export interface BoardFile {
	/** Repository-relative path. */
	path: string;
	status: FileStatusCode | typeof NO_STATUS;
	renamedFrom?: string;
	/** Absent for untracked, binary and unchanged files, which have no line counts. */
	additions?: number;
	deletions?: number;
}

export interface BoardFolder {
	/** Repository-relative folder path; empty for the group root. */
	path: string;
	/** Folder name, or the whole compacted chain (``lib/src/util``). */
	name: string;
	folders: BoardFolder[];
	files: BoardFile[];
}

export interface BoardGroup {
	name: string;
	/** Flat list, used for counts and totals. */
	files: BoardFile[];
	/** Same files arranged the way Source Control shows them. */
	tree: BoardFolder;
	additions: number;
	deletions: number;
}

export interface BoardSnapshot {
	branch: string | null;
	changelists: BoardGroup[];
	hiddenChangelists: BoardGroup[];
	unassigned: BoardGroup;
}

/** One entry of the repository switcher. */
export interface RepoOption {
	root: string;
	label: string;
}

export type HostMessage =
	| {
		type: 'snapshot';
		snapshot: BoardSnapshot;
		/** Every repository VS Code sees, so the switcher mirrors Source Control. */
		repos: RepoOption[];
		activeRepo: string;
	}
	| {
		type: 'actionResult';
		action: 'stage' | 'commit';
		name: string;
		ok: boolean;
	};

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'switchRepo'; root: string }
	| { type: 'openFile'; path: string }
	| { type: 'stage'; name: string }
	| { type: 'commit'; name: string; message: string };
