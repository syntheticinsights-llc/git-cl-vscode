import * as vscode from 'vscode';
import { getGitStatus } from '../gitUtils';
import { ChangelistTreeDataProvider } from '../changelistTreeProvider';
import { renderReviewPrompt } from '../reviewPrompt';
import { editReviewTemplate, readReviewTemplate } from '../reviewTemplate';
import { pickChangelistForAction, resolveChangelistName, resolveStashName } from '../commandArgs';
import { unstashSingleChangelist } from '../stashOperations';

export function registerChangelistCommands(scmProvider: ChangelistTreeDataProvider, gitRoot: string): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(
			'git-cl.deleteChangelist',
			async (...args: unknown[]) => {
				const name = resolveChangelistName(args) ?? resolveStashName(args) ?? await pickChangelistForAction(scmProvider, 'disband');
				if (name) {
					await disbandChangelistWithConfirmation(scmProvider, gitRoot, name);
				}
			}
		),
		vscode.commands.registerCommand(
			'git-cl.deleteAllChangelists',
			async () => {
				const store = scmProvider.getChangelistStore();
				store.load();
				const stashStore = scmProvider.getStashStore();
				stashStore.load();
				const names = store.getNames();
				const hiddenNames = stashStore.getNames();

				if (names.length + hiddenNames.length === 0) {
					vscode.window.showInformationMessage('git-cl: No changelists to disband.');
					return;
				}

				const totalFiles = names.reduce((sum, name) => sum + store.getFiles(name).length, 0) +
					hiddenNames.reduce((sum, name) => sum + (stashStore.getStash(name)?.files.length ?? 0), 0);
				const hiddenNote = hiddenNames.length > 0 ? ' Hidden changes will be shown again first.' : '';

				const message = totalFiles > 0
					? `Disband all ${names.length + hiddenNames.length} changelist(s)? ${totalFiles} file(s) will be moved to Unassigned.${hiddenNote}`
					: `Disband all ${names.length} empty changelist(s)?`;

				const answer = await vscode.window.showWarningMessage(
					message,
					{ modal: true },
					'Disband All'
				);

				if (answer !== 'Disband All') {
					return;
				}

				for (const name of hiddenNames) {
					await unstashSingleChangelist(scmProvider, name, gitRoot, false);
				}

				store.load();
				try {
					store.deleteAll();
					store.save();
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(`git-cl: ${msg}`);
					return;
				}

				await scmProvider.refresh();
			}
		),
		vscode.commands.registerCommand('git-cl.pruneChangelist', async (...args: unknown[]) => {
			const name = resolveChangelistName(args) ?? await pickChangelistForAction(scmProvider, 'prune');
			if (name) {
				await pruneChangelists(scmProvider, gitRoot, [name]);
			}
		}),
		vscode.commands.registerCommand('git-cl.pruneAllChangelists', async () => {
			await pruneChangelists(scmProvider, gitRoot);
		}),
		vscode.commands.registerCommand('git-cl.copyFromChangelist', async (...args: unknown[]) => {
			const name = resolveChangelistName(args) ?? await pickChangelistForAction(scmProvider, 'copy from');
			if (name) {
				await pickAndCopyFromChangelist(scmProvider, gitRoot, name);
			}
		}),
		vscode.commands.registerCommand('git-cl.editReviewTemplate', () => editReviewTemplate(gitRoot)),
	];
}

/**
 * Remove entries that no longer have working-tree or index changes (already
 * committed, or reverted to HEAD), keeping each changelist limited to pending work.
 */
async function pruneChangelists(
	scmProvider: ChangelistTreeDataProvider,
	gitRoot: string,
	names?: string[]
): Promise<void> {
	let gitStatusMap: Map<string, string>;
	try {
		gitStatusMap = await getGitStatus(gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return;
	}

	const store = scmProvider.getChangelistStore();
	store.load();
	let prunedCount = 0;
	for (const name of names ?? store.getNames()) {
		const staleFiles = store.getFiles(name).filter(file => !gitStatusMap.has(file));
		store.removeFiles(name, staleFiles);
		prunedCount += staleFiles.length;
	}

	if (prunedCount === 0) {
		vscode.window.showInformationMessage('git-cl: No unchanged files to prune.');
		return;
	}

	store.save();
	await scmProvider.refresh();
	vscode.window.showInformationMessage(`git-cl: Pruned ${prunedCount} unchanged file(s).`);
}

/** Lets the user pick what to copy from a changelist: its name or a review prompt for it. */
async function pickAndCopyFromChangelist(
	scmProvider: ChangelistTreeDataProvider,
	gitRoot: string,
	name: string
): Promise<void> {
	const reviewPrompt = (): string => {
		const store = scmProvider.getChangelistStore();
		store.load();
		return renderReviewPrompt(readReviewTemplate(gitRoot), { changelist: name, files: store.getFiles(name) });
	};
	const choices = [
		{ label: '$(symbol-string) Copy Name', copied: 'Changelist name', text: () => name },
		{ label: '$(comment-discussion) Copy Review Prompt', copied: 'Review prompt', text: reviewPrompt },
	];

	const picked = await vscode.window.showQuickPick(choices, { placeHolder: `Copy from changelist "${name}"` });
	if (!picked) {
		return;
	}

	await vscode.env.clipboard.writeText(picked.text());
	vscode.window.showInformationMessage(`git-cl: ${picked.copied} copied to the clipboard.`);
}

/**
 * Disband a changelist after confirming with the user: its files move to
 * Unassigned with their changes kept. Hidden changes are shown again first.
 */
async function disbandChangelistWithConfirmation(
	scmProvider: ChangelistTreeDataProvider,
	gitRoot: string,
	name: string
): Promise<void> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const stashStore = scmProvider.getStashStore();
	stashStore.load();
	const hiddenFiles = stashStore.getStash(name)?.files;
	const files = hiddenFiles ?? store.getFiles(name);
	const hiddenNote = hiddenFiles ? ' Its hidden changes will be shown again first.' : '';

	const message = files.length > 0
		? `Disband changelist "${name}"? ${files.length} file(s) will be moved to Unassigned.${hiddenNote}`
		: `Disband empty changelist "${name}"?`;

	const answer = await vscode.window.showWarningMessage(
		message,
		{ modal: true },
		'Disband'
	);

	if (answer !== 'Disband') {
		return;
	}

	if (hiddenFiles && !await unstashSingleChangelist(scmProvider, name, gitRoot, false)) {
		return;
	}

	store.load();
	try {
		store.deleteChangelist(name);
		store.save();
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`git-cl: ${msg}`);
		return;
	}

	await scmProvider.refresh();
}
