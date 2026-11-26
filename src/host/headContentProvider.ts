import * as vscode from 'vscode';
import { execFile } from 'child_process';

export const HEAD_SCHEME = 'git-cl-head';

/**
 * TextDocumentContentProvider that returns file content at HEAD.
 * Used for showing diff (HEAD vs working copy) when clicking files or running `Diff Changelist`.
 */
export class HeadContentProvider implements vscode.TextDocumentContentProvider {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changeEmitter.event;
	/** HEAD content per repository path; cleared whenever HEAD moves, which is the only way it can change. */
	private readonly cache = new Map<string, string>();
	private defaultGitRoot: string;

	constructor(gitRoot: string, private readonly outputChannel?: vscode.OutputChannel) {
		this.defaultGitRoot = gitRoot;
	}

	setDefaultGitRoot(gitRoot: string): void {
		this.defaultGitRoot = gitRoot;
	}

	/** VS Code caches provided content, so loaded HEAD documents must be told when HEAD moves. */
	reloadOpenDocuments(): void {
		this.cache.clear();
		for (const document of vscode.workspace.textDocuments) {
			if (document.uri.scheme === HEAD_SCHEME) {
				this.changeEmitter.fire(document.uri);
			}
		}
	}

	provideTextDocumentContent(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<string> {
		if (token?.isCancellationRequested) {
			return Promise.reject(new vscode.CancellationError());
		}
		const relativePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
		if (uri.fragment === 'empty') {
			this.log(`head [empty] ${relativePath} (0ms)`);
			return Promise.resolve('');
		}
		// The query carries the repository the diff belongs to; without it every
		// repository would be served from this provider's own checkout.
		const gitRoot = uri.query ? decodeURIComponent(uri.query) : this.defaultGitRoot;
		const key = `${gitRoot}\u0000${relativePath}`;
		const cached = this.cache.get(key);
		if (cached !== undefined) {
			this.log(`head [cache] ${relativePath} (${cached.length} chars, 0ms)`);
			return Promise.resolve(cached);
		}

		// Clicking through files quickly replaces the diff editor before content arrives;
		// VS Code cancels this request, so the git process is killed instead of queueing.
		const startedAt = Date.now();
		const abort = new AbortController();
		const subscription = token?.onCancellationRequested(() => abort.abort());
		return new Promise((resolve, reject) => {
			execFile(
				'git',
				['show', `HEAD:${relativePath}`],
				{ cwd: gitRoot, maxBuffer: 10 * 1024 * 1024, timeout: 10_000, signal: abort.signal },
				(error, stdout) => {
					subscription?.dispose();
					const elapsed = Date.now() - startedAt;
					if (abort.signal.aborted || token?.isCancellationRequested) {
						this.log(`head [cancelled] ${relativePath} (${elapsed}ms)`);
						// Reject cancellations instead of returning '' so VS Code never
						// caches an empty document for a file whose load was interrupted.
						reject(new vscode.CancellationError());
						return;
					}
					if (error) {
						// Missing at HEAD (new file) or unreadable object; cache '' until HEAD moves.
						this.remember(key, '');
						this.log(`head [missing] ${relativePath} (${elapsed}ms)`);
						resolve('');
						return;
					}
					this.remember(key, stdout);
					this.log(`head [git-show] ${relativePath} (${stdout.length} chars, ${elapsed}ms)`);
					resolve(stdout);
				}
			);
		});
	}

	private log(message: string): void {
		this.outputChannel?.appendLine(`[${new Date().toISOString()}] git-cl: ${message}`);
	}

	private remember(key: string, content: string): void {
		if (this.cache.size >= 200) {
			const oldest = this.cache.keys().next();
			if (!oldest.done) {
				this.cache.delete(oldest.value);
			}
		}
		this.cache.set(key, content);
	}
}
