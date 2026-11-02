import * as vscode from 'vscode';
import * as path from 'path';
import { gitAdd, gitReset } from './core/gitUtils';

interface BuiltinGitRepository {
	add(paths: string[]): Promise<void>;
	revert(paths: string[]): Promise<void>;
}

interface BuiltinGitApi {
	getRepository(uri: vscode.Uri): BuiltinGitRepository | null;
}

interface BuiltinGitExtension {
	getAPI(version: 1): BuiltinGitApi;
}

/**
 * VS Code's Git extension only notices index changes made by other processes after
 * a debounced, throttled refresh (1s debounce plus a 5s cool-down after each status),
 * so the Source Control view lags behind CLI writes. Running the operation through
 * its API refreshes that view as soon as the operation completes.
 */
async function getBuiltinGitRepository(gitRoot: string): Promise<BuiltinGitRepository | undefined> {
	try {
		const extension = vscode.extensions.getExtension<BuiltinGitExtension>('vscode.git');
		if (!extension) {
			return undefined;
		}
		const exports = extension.isActive ? extension.exports : await extension.activate();
		return exports.getAPI(1).getRepository(vscode.Uri.file(gitRoot)) ?? undefined;
	} catch {
		return undefined;
	}
}

function toAbsolutePaths(files: string[], gitRoot: string): string[] {
	return files.map(file => path.join(gitRoot, file));
}

export async function stageFiles(files: string[], gitRoot: string): Promise<void> {
	const repository = await getBuiltinGitRepository(gitRoot);
	if (repository) {
		await repository.add(toAbsolutePaths(files, gitRoot));
		return;
	}
	await gitAdd(files, gitRoot);
}

export async function unstageFiles(files: string[], gitRoot: string): Promise<void> {
	const repository = await getBuiltinGitRepository(gitRoot);
	if (repository) {
		await repository.revert(toAbsolutePaths(files, gitRoot));
		return;
	}
	await gitReset(files, gitRoot);
}
