import { execFile } from 'child_process';
import * as path from 'path';

/** Result of parsing git status --porcelain output */
export type GitStatusMap = Map<string, string>;

/** A single stash entry from git stash list */
export interface StashEntry {
	ref: string;
	message: string;
}

/** Options for gitDiff */
export interface DiffOptions {
	staged?: boolean;
}

/**
 * Execute a git command using execFile (no shell) for safety.
 * All commands run with cwd set to the given directory.
 */
function execGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				const msg = stderr.trim() || stdout.trim() || error.message;
				reject(new Error(`git ${args[0]} failed: ${msg}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/**
 * Returns the absolute path to the repository root.
 * Runs `git rev-parse --show-toplevel` from the given directory.
 */
export async function getGitRoot(cwd: string): Promise<string> {
	const output = await execGit(['rev-parse', '--show-toplevel'], cwd);
	return output.trim();
}

/**
 * Returns the absolute path to the common git directory.
 * In a regular repo this is `<root>/.git`, in a worktree it resolves to
 * the main repository's `.git` directory (where cl.json lives).
 */
export async function getGitCommonDir(cwd: string): Promise<string> {
	const output = await execGit(['rev-parse', '--git-common-dir'], cwd);
	const result = output.trim();
	// --git-common-dir may return a relative path; resolve it
	return path.resolve(cwd, result);
}

export interface GitStatusSnapshot {
	/** Repository-relative path → 2-character status code; both sides of a rename are listed separately. */
	status: GitStatusMap;
	/** New path → original path for every rename git detected. */
	renames: Map<string, string>;
}

function renameSideCode(code: string, renamedCode: 'A' | 'D'): string {
	return code === 'R' || code === 'C' ? renamedCode : code;
}

/**
 * Parses `git status --porcelain -z` output. A rename entry ("R  new\0old")
 * is split into an add of the new path and a delete of the original, so
 * every path keeps its own status, and the pairing is reported in `renames`.
 */
export function parsePorcelainStatus(output: string): GitStatusSnapshot {
	const status: GitStatusMap = new Map();
	const renames = new Map<string, string>();
	const entries = output.split('\0');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) {
			continue;
		}
		const [x, y] = entry;
		const filePath = entry.substring(3);
		const isRename = x === 'R' || y === 'R';
		const hasOrigin = isRename || x === 'C' || y === 'C';
		if (!hasOrigin) {
			status.set(filePath, entry.substring(0, 2));
			continue;
		}
		const origin = entries[++i];
		status.set(filePath, renameSideCode(x, 'A') + renameSideCode(y, 'A'));
		if (isRename && origin) {
			status.set(origin, x === 'R' ? 'D ' : ' D');
			renames.set(filePath, origin);
		}
	}
	return { status, renames };
}

export interface GitStatusOptions {
	/** `all` lists the files inside an untracked directory one by one; `no` leaves untracked files out. */
	untrackedFiles?: 'all' | 'no';
}

export async function getGitStatusSnapshot(gitRoot: string, { untrackedFiles = 'all' }: GitStatusOptions = {}): Promise<GitStatusSnapshot> {
	// --no-optional-locks keeps `git status` from refreshing and rewriting the index.
	// Without it every status write fires the index watcher, which schedules another
	// status, and the extension ends up repainting itself in a loop.
	return parsePorcelainStatus(
		await execGit(['--no-optional-locks', 'status', '--porcelain', '-z', `--untracked-files=${untrackedFiles}`], gitRoot)
	);
}

/**
 * Returns a map of repository-relative path → 2-character status code
 * (e.g., " M", "??", "A "). Renamed files appear as a delete of the
 * original path plus an add of the new one.
 */
export async function getGitStatus(gitRoot: string): Promise<GitStatusMap> {
	return (await getGitStatusSnapshot(gitRoot)).status;
}

/**
 * Line counts of the working tree against HEAD, keyed by repository-relative path.
 *
 * `-z` keeps paths containing tabs or newlines parseable, and running without a
 * pathspec avoids the command-line length limit that a few hundred changed files
 * reach on Windows. A rename arrives as `added\tremoved\t\0old\0new\0`; only the
 * new path gets the counts, because the old one is what disappeared.
 */
export async function getWorkingTreeLineStats(
	gitRoot: string
): Promise<Map<string, { additions: number; deletions: number }>> {
	const stats = new Map<string, { additions: number; deletions: number }>();
	// --no-optional-locks prevents `git diff HEAD` from refreshing the index and
	// re-triggering the `.git/index` watcher in ChangelistTreeDataProvider.
	const output = await execGit(['--no-optional-locks', 'diff', '--numstat', '-z', 'HEAD'], gitRoot);
	const fields = output.split('\0');
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (!field) {
			continue;
		}
		// Only the first two tabs separate fields; the path may itself contain tabs.
		const firstTab = field.indexOf('\t');
		const secondTab = field.indexOf('\t', firstTab + 1);
		if (firstTab < 0 || secondTab < 0) {
			continue;
		}
		const added = field.slice(0, firstTab);
		const removed = field.slice(firstTab + 1, secondTab);
		const path = field.slice(secondTab + 1);
		if (added === '-' || removed === '-') {
			continue;
		}
		const counts = { additions: Number(added), deletions: Number(removed) };
		if (path) {
			stats.set(path, counts);
			continue;
		}
		// A rename or copy leaves the path empty and stores both paths as the next two fields.
		index += 2;
		const newPath = fields[index];
		if (newPath) {
			stats.set(newPath, counts);
		}
	}
	return stats;
}

/**
 * Stages the specified files via `git add`.
 * Paths are resolved relative to git root.
 */
export async function gitAdd(files: string[], gitRoot: string): Promise<void> {
	if (files.length === 0) {
		return;
	}
	await execGit(['add', '--', ...files], gitRoot);
}

/**
 * Unstages the specified files via `git reset HEAD`.
 */
export async function gitReset(files: string[], gitRoot: string): Promise<void> {
	if (files.length === 0) {
		return;
	}
	await execGit(['reset', 'HEAD', '--', ...files], gitRoot);
}

/**
 * Reverts files to HEAD via `git checkout HEAD --`.
 */
export async function gitCheckout(files: string[], gitRoot: string): Promise<void> {
	if (files.length === 0) {
		return;
	}
	await execGit(['checkout', 'HEAD', '--', ...files], gitRoot);
}

/**
 * Commits specified files with the given message.
 * Files are staged first via `git add`, then committed.
 */
export async function gitCommit(files: string[], message: string, gitRoot: string): Promise<void> {
	if (files.length === 0) {
		throw new Error('No files to commit');
	}
	if (!message || message.trim().length === 0) {
		throw new Error('Commit message cannot be empty');
	}
	// Stage the files first
	await gitAdd(files, gitRoot);
	// Commit only the staged files
	await execGit(['commit', '-m', message], gitRoot);
}

/**
 * Returns diff output for the specified files.
 * Supports --staged flag via options.
 */
export async function gitDiff(files: string[], gitRoot: string, options?: DiffOptions): Promise<string> {
	const args = ['diff'];
	if (options?.staged) {
		args.push('--staged');
	}
	if (files.length > 0) {
		args.push('--', ...files);
	}
	return execGit(args, gitRoot);
}

/**
 * Creates a stash with the given message.
 * If files are specified, only those files are stashed (using --).
 * Use includeUntracked to also stash untracked files.
 */
export async function gitStashPush(message: string, gitRoot: string, files?: string[], options?: { includeUntracked?: boolean }): Promise<void> {
	const args = ['stash', 'push', '-m', message];
	if (options?.includeUntracked) {
		args.push('--include-untracked');
	}
	if (files && files.length > 0) {
		args.push('--', ...files);
	}
	await execGit(args, gitRoot);
}

/**
 * Drops a specific stash reference (e.g., "stash@{0}").
 */
export async function gitStashDrop(ref: string, gitRoot: string): Promise<void> {
	await execGit(['stash', 'drop', ref], gitRoot);
}

/**
 * Pops a specific stash reference (e.g., "stash@{0}").
 */
export async function gitStashPop(ref: string, gitRoot: string): Promise<void> {
	await execGit(['stash', 'pop', ref], gitRoot);
}

/**
 * Lists stash entries with their references and messages.
 */
export async function gitStashList(gitRoot: string): Promise<StashEntry[]> {
	let output: string;
	try {
		output = await execGit(['stash', 'list'], gitRoot);
	} catch {
		return [];
	}
	const entries: StashEntry[] = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		// Format: "stash@{0}: On branch: message"
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) {
			continue;
		}
		const ref = line.substring(0, colonIndex);
		const message = line.substring(colonIndex + 2);
		entries.push({ ref, message });
	}
	return entries;
}

/**
 * Returns the current branch name, or null if in detached HEAD state.
 */
export async function getCurrentBranch(gitRoot: string): Promise<string | null> {
	try {
		const output = await execGit(['symbolic-ref', '--short', 'HEAD'], gitRoot);
		return output.trim() || null;
	} catch {
		// Detached HEAD state
		return null;
	}
}

/**
 * Returns the commit HEAD points to, or null when HEAD is unborn.
 */
export async function getHeadCommit(gitRoot: string): Promise<string | null> {
	try {
		return (await execGit(['rev-parse', 'HEAD'], gitRoot)).trim();
	} catch {
		return null;
	}
}

/**
 * Creates and switches to a new branch.
 * If base is provided, the branch is created from that base ref.
 */
export async function gitCheckoutBranch(name: string, gitRoot: string, base?: string): Promise<void> {
	const args = ['checkout', '-b', name];
	if (base) {
		args.push(base);
	}
	await execGit(args, gitRoot);
}

/**
 * Checks if a local branch exists.
 */
export async function gitBranchExists(name: string, gitRoot: string): Promise<boolean> {
	try {
		await execGit(['rev-parse', '--verify', `refs/heads/${name}`], gitRoot);
		return true;
	} catch {
		return false;
	}
}

/**
 * Switches to an existing branch.
 */
export async function gitCheckoutExistingBranch(name: string, gitRoot: string): Promise<void> {
	await execGit(['checkout', name], gitRoot);
}
