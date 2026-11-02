import * as vscode from 'vscode';
import * as path from 'path';
import { getGitStatus } from './gitUtils';
import { ChangelistTreeDataProvider, expandFolderNodes, nodeFilePaths, TreeNode } from './changelistTreeProvider';
import { validateChangelistName } from './changelistStore';

/**
 * Resolve a single file path from a command argument.
 * Handles both TreeNode (from our tree view) and SourceControlResourceState
 * (from built-in Git context menu).
 */
export function resolveFilePathFromArg(
	gitRoot: string,
	arg: unknown
): string | undefined {
	if (!arg || typeof arg !== 'object') {
		return undefined;
	}

	// TreeNode from our tree view
	if ('type' in (arg as Record<string, unknown>)) {
		const node = arg as TreeNode;
		if (node.type === 'changelistFile' || node.type === 'unassignedFile') {
			return node.filePath;
		}
		return undefined;
	}

	// SourceControlResourceState from built-in Git
	if ('resourceUri' in (arg as Record<string, unknown>)) {
		const resource = arg as vscode.SourceControlResourceState;
		return path.relative(gitRoot, resource.resourceUri.fsPath)
			.split(path.sep).join('/');
	}

	return undefined;
}

/**
 * Resolve the file paths a command argument refers to; folder nodes expand to
 * every file they contain, and a merged rename covers both of its paths.
 */
function resolveFilePathsFromArg(gitRoot: string, arg: unknown): string[] {
	if (arg && typeof arg === 'object' && 'type' in arg) {
		return expandFolderNodes([arg as TreeNode]).flatMap(nodeFilePaths);
	}
	const filePath = resolveFilePathFromArg(gitRoot, arg);
	return filePath ? [filePath] : [];
}

/**
 * Resolve file paths from command arguments (context menu) or prompt the user
 * to select files from git status (command palette).
 * Handles both TreeNode args (from our tree view) and SourceControlResourceState
 * args (from built-in Git's context menu).
 */
export async function resolveFilePaths(
	gitRoot: string,
	args: unknown[]
): Promise<string[] | undefined> {
	// Context menu with multi-select: second arg is the array of selected items
	if (args.length >= 2 && Array.isArray(args[1])) {
		const items = args[1] as unknown[];
		const paths = [...new Set(items.flatMap(item => resolveFilePathsFromArg(gitRoot, item)))];
		if (paths.length > 0) {
			return paths;
		}
	}

	// Context menu single-select: first arg is the clicked item
	if (args.length >= 1 && args[0]) {
		const filePaths = resolveFilePathsFromArg(gitRoot, args[0]);
		if (filePaths.length > 0) {
			return filePaths;
		}
	}

	// Command palette — show file picker from git status
	let gitStatus: Map<string, string>;
	try {
		gitStatus = await getGitStatus(gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return undefined;
	}

	if (gitStatus.size === 0) {
		vscode.window.showInformationMessage('git-cl: No changed files to add.');
		return undefined;
	}

	const items: vscode.QuickPickItem[] = [];
	for (const [filePath, status] of gitStatus) {
		items.push({
			label: filePath,
			description: status.trim(),
		});
	}

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: 'Select files to add to a changelist',
	});

	if (!picked || picked.length === 0) {
		return undefined;
	}

	return picked.map(item => item.label);
}

/**
 * Resolve file paths for removal: from context menu args or prompt the user
 * to pick files from existing changelists (command palette).
 */
export async function resolveFilePathsFromChangelists(
	gitRoot: string,
	scmProvider: ChangelistTreeDataProvider,
	args: unknown[]
): Promise<string[] | undefined> {
	// Context menu with multi-select: second arg is the array of selected items
	if (args.length >= 2 && Array.isArray(args[1])) {
		const items = args[1] as unknown[];
		const paths = [...new Set(items.flatMap(item => resolveFilePathsFromArg(gitRoot, item)))];
		if (paths.length > 0) {
			return paths;
		}
	}

	// Context menu single-select: first arg is the clicked item
	if (args.length >= 1 && args[0]) {
		const filePaths = resolveFilePathsFromArg(gitRoot, args[0]);
		if (filePaths.length > 0) {
			return filePaths;
		}
	}

	// Command palette — show file picker from all changelists
	const store = scmProvider.getChangelistStore();
	store.load();
	const changelists = store.getAll();

	const items: vscode.QuickPickItem[] = [];
	for (const [name, files] of Object.entries(changelists)) {
		for (const filePath of files) {
			items.push({
				label: filePath,
				description: name,
			});
		}
	}

	if (items.length === 0) {
		vscode.window.showInformationMessage('git-cl: No files in any changelist to remove.');
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: 'Select files to remove from their changelist',
	});

	if (!picked || picked.length === 0) {
		return undefined;
	}

	return picked.map(item => item.label);
}

/**
 * Show a QuickPick to select an existing changelist or create a new one.
 */
export async function pickChangelist(
	scmProvider: ChangelistTreeDataProvider
): Promise<string | undefined> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const existingNames = store.getNames();

	const createNewLabel = '$(plus) Create New Changelist';
	const items: vscode.QuickPickItem[] = [
		{ label: createNewLabel, description: 'Enter a new changelist name' },
		...existingNames.map(name => ({
			label: name,
			description: `${store.getFiles(name).length} file(s)`,
		})),
	];

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select or create a changelist',
	});

	if (!picked) {
		return undefined;
	}

	if (picked.label === createNewLabel) {
		const name = await vscode.window.showInputBox({
			prompt: 'Enter changelist name',
			placeHolder: 'my-feature',
			validateInput: value => validateChangelistName(value),
		});
		return name ?? undefined;
	}

	return picked.label;
}

/**
 * Resolve changelist name from context menu args (tree node click).
 * Returns the name or undefined if not invoked from a changelist node.
 */
export function resolveChangelistName(
	args: unknown[]
): string | undefined {
	if (args.length < 1 || !args[0]) {
		return undefined;
	}

	const node = args[0] as TreeNode;
	if (typeof node === 'object' && node !== null && 'type' in node && node.type === 'changelist') {
		return node.name;
	}

	return undefined;
}

/**
 * Show QuickPick to select a changelist for a given action (command palette flow).
 */
export async function pickChangelistForAction(
	scmProvider: ChangelistTreeDataProvider,
	action: string
): Promise<string | undefined> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const names = store.getNames();

	if (names.length === 0) {
		vscode.window.showInformationMessage(`git-cl: No changelists to ${action}.`);
		return undefined;
	}

	const items: vscode.QuickPickItem[] = names.map(name => ({
		label: name,
		description: `${store.getFiles(name).length} file(s)`,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Select a changelist to ${action}`,
	});

	return picked?.label;
}

/**
 * Resolve stash changelist name from context menu args (tree node click).
 * Returns the name or undefined if not invoked from a stashed changelist node.
 */
export function resolveStashName(args: unknown[]): string | undefined {
	if (args.length < 1 || !args[0]) {
		return undefined;
	}

	const node = args[0] as TreeNode;
	if (typeof node === 'object' && node !== null && 'type' in node && node.type === 'stashedChangelist') {
		return node.name;
	}

	return undefined;
}

/**
 * Show QuickPick to select a stashed changelist for an action (command palette flow).
 */
export async function pickStashedChangelistForAction(
	scmProvider: ChangelistTreeDataProvider,
	action: string
): Promise<string | undefined> {
	const stashStore = scmProvider.getStashStore();
	stashStore.load();
	const names = stashStore.getNames();

	if (names.length === 0) {
		vscode.window.showInformationMessage(`git-cl: No stashed changelists to ${action}.`);
		return undefined;
	}

	const items: vscode.QuickPickItem[] = names.map(name => {
		const meta = stashStore.getStash(name);
		const date = meta ? new Date(meta.timestamp).toLocaleString() : '';
		const branch = meta?.source_branch ?? '';
		return {
			label: name,
			description: `${meta?.files.length ?? 0} file(s) — from ${branch}, ${date}`,
		};
	});

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Select a stashed changelist to ${action}`,
	});

	return picked?.label;
}
