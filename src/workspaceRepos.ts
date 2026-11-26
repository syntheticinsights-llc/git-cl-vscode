import * as path from 'path';
import * as vscode from 'vscode';
import { getGitCommonDir, getGitRoot } from './core/gitUtils';

export interface RepoRef {
	root: string;
	/** Where `cl.json` lives; differs from `root/.git` inside a worktree. */
	commonDir: string;
	/** Short name for the switcher, disambiguated when two repositories share a folder name. */
	label: string;
}

interface GitApiRepository {
	rootUri: vscode.Uri;
}

interface GitApi {
	repositories: GitApiRepository[];
	onDidOpenRepository: vscode.Event<GitApiRepository>;
	onDidCloseRepository: vscode.Event<GitApiRepository>;
	onDidChangeState: vscode.Event<string>;
}

interface GitExtension {
	getAPI(version: 1): GitApi;
}

/**
 * Repositories VS Code itself sees. Asking the built-in Git extension keeps the
 * board's set identical to the Source Control view — same nested-repository scan,
 * same `git.autoRepositoryDetection` and `git.repositoryScanMaxDepth` settings —
 * instead of inventing a second scanning rule.
 */
export async function detectRepos(): Promise<RepoRef[]> {
	const roots = await repositoryRoots();
	const repos: RepoRef[] = [];
	for (const root of roots) {
		try {
			repos.push({ root, commonDir: await getGitCommonDir(root), label: '' });
		} catch {
			// A folder that stopped being a repository between the scan and now.
		}
	}
	return withLabels(repos);
}

/**
 * Fires whenever VS Code's visible repository set may have changed — both when
 * workspace folders change and as the built-in Git extension asynchronously
 * discovers, opens, or closes nested repositories after startup.
 */
export function onDidChangeRepos(listener: () => void): vscode.Disposable {
	let disposed = false;
	const subscriptions: vscode.Disposable[] = [
		vscode.workspace.onDidChangeWorkspaceFolders(listener),
	];

	void builtinGitApi().then(api => {
		if (disposed || !api) {
			return;
		}
		subscriptions.push(
			api.onDidOpenRepository(listener),
			api.onDidCloseRepository(listener),
			api.onDidChangeState(listener)
		);
		// Catch repositories discovered while `vscode.git` was activating.
		if (api.repositories.length > 0) {
			listener();
		}
	});

	return {
		dispose(): void {
			disposed = true;
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			subscriptions.length = 0;
		},
	};
}

async function repositoryRoots(): Promise<string[]> {
	const fromGit = await builtinGitRoots();
	if (fromGit.length > 0) {
		return fromGit;
	}
	const roots: string[] = [];
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		try {
			roots.push(await getGitRoot(folder.uri.fsPath));
		} catch {
			// Not a repository.
		}
	}
	return roots;
}

async function builtinGitRoots(): Promise<string[]> {
	const api = await builtinGitApi();
	if (!api) {
		return [];
	}
	return [...new Set(api.repositories.map(repository => repository.rootUri.fsPath))];
}

async function builtinGitApi(): Promise<GitApi | undefined> {
	try {
		const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!extension) {
			return undefined;
		}
		const exports = extension.isActive ? extension.exports : await extension.activate();
		return exports.getAPI(1);
	} catch {
		return undefined;
	}
}

/**
 * Finds the deepest detected repository that owns `fsPath`, so a file inside a
 * nested repository matches the nested repo instead of its parent checkout.
 */
export function findRepoForPath(repos: readonly RepoRef[], fsPath: string): RepoRef | undefined {
	const resolved = path.resolve(fsPath);
	let best: RepoRef | undefined;
	for (const repo of repos) {
		const root = path.resolve(repo.root);
		if (resolved === root || resolved.startsWith(root + path.sep)) {
			if (!best || root.length > path.resolve(best.root).length) {
				best = repo;
			}
		}
	}
	return best;
}

function withLabels(repos: RepoRef[]): RepoRef[] {
	const byName = new Map<string, number>();
	for (const repo of repos) {
		const name = path.basename(repo.root);
		byName.set(name, (byName.get(name) ?? 0) + 1);
	}
	return repos.map(repo => {
		const name = path.basename(repo.root);
		const ambiguous = (byName.get(name) ?? 0) > 1;
		return { ...repo, label: ambiguous ? `${path.basename(path.dirname(repo.root))}/${name}` : name };
	});
}
