import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomicFile';
import { withLock } from './lock';

/** Categories of files in a stash, matching Python git-cl format */
export interface FileCategories {
	unstaged_changes: string[];
	staged_additions: string[];
	untracked: string[];
	deleted: string[];
}

/** Metadata for a single stashed changelist, matching Python git-cl format */
export interface StashMetadata {
	stash_ref: string;
	stash_message: string;
	files: string[];
	timestamp: string;
	source_branch: string;
	file_categories: FileCategories;
}

/** JSON shape of cl-stashes.json: mapping of changelist name → stash metadata */
export type StashData = Record<string, StashMetadata>;

/**
 * StashStore manages .git/cl-stashes.json — the mapping of changelist names
 * to stash metadata.
 *
 * Data format is compatible with the Python git-cl tool.
 */
export class StashStore {
	private readonly gitCommonDir: string;
	private readonly filePath: string;
	private data: StashData = {};

	constructor(private readonly gitRoot: string, gitCommonDir?: string) {
		this.gitCommonDir = gitCommonDir ?? path.join(gitRoot, '.git');
		this.filePath = path.join(this.gitCommonDir, 'cl-stashes.json');
	}

	/** Load stash data from disk. Returns empty data if file doesn't exist. */
	load(): void {
		try {
			const raw = fs.readFileSync(this.filePath, 'utf-8');
			const parsed = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				this.data = {};
				return;
			}
			// Validate structure
			const result: StashData = {};
			for (const [name, meta] of Object.entries(parsed)) {
				if (isValidStashMetadata(meta)) {
					result[name] = meta as StashMetadata;
				}
			}
			this.data = result;
		} catch {
			this.data = {};
		}
	}

	/** Save stash data to disk. Empty data results in an empty object. */
	save(): void {
		writeFileAtomic(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
	}

	/** Load, apply mutator, and save while holding the git-cl lock. Nothing is saved if mutator throws. */
	update<T>(mutator: (store: StashStore) => T): Promise<T> {
		return withLock(this.gitCommonDir, () => {
			this.load();
			const result = mutator(this);
			this.save();
			return result;
		});
	}

	/** Get all stashed changelists. */
	getAll(): Readonly<StashData> {
		return this.data;
	}

	/** Get metadata for a specific stashed changelist. */
	getStash(name: string): Readonly<StashMetadata> | undefined {
		return this.data[name];
	}

	/** Get all stashed changelist names. */
	getNames(): string[] {
		return Object.keys(this.data);
	}

	/** Add or update a stashed changelist entry. */
	setStash(name: string, metadata: StashMetadata): void {
		this.data[name] = metadata;
	}

	/** Remove a stashed changelist entry. Returns the metadata or undefined. */
	removeStash(name: string): StashMetadata | undefined {
		const meta = this.data[name];
		delete this.data[name];
		return meta;
	}

	/** Get the set of all files across all stashed changelists. */
	getStashedFiles(): Set<string> {
		const files = new Set<string>();
		for (const meta of Object.values(this.data)) {
			for (const f of meta.files) {
				files.add(f);
			}
		}
		return files;
	}

	/** Get the path to cl-stashes.json */
	getFilePath(): string {
		return this.filePath;
	}
}

/** Type guard for StashMetadata validation */
function isValidStashMetadata(value: unknown): value is StashMetadata {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.stash_ref === 'string' &&
		typeof obj.stash_message === 'string' &&
		Array.isArray(obj.files) &&
		obj.files.every((f: unknown) => typeof f === 'string') &&
		typeof obj.timestamp === 'string' &&
		typeof obj.source_branch === 'string' &&
		typeof obj.file_categories === 'object' &&
		obj.file_categories !== null &&
		isValidFileCategories(obj.file_categories)
	);
}

/** Type guard for FileCategories validation */
function isValidFileCategories(value: unknown): value is FileCategories {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const requiredArrays = ['unstaged_changes', 'staged_additions', 'untracked', 'deleted'];
	return requiredArrays.every(
		key => Array.isArray(obj[key]) && (obj[key] as unknown[]).every((f: unknown) => typeof f === 'string')
	);
}
