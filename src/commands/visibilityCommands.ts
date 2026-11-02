import * as vscode from 'vscode';
import { ChangelistTreeDataProvider } from '../changelistTreeProvider';
import { pickChangelistForAction, pickStashedChangelistForAction, resolveChangelistName, resolveStashName } from '../commandArgs';
import { stashSingleChangelist, unstashSingleChangelist } from '../stashOperations';

export function registerVisibilityCommands(scmProvider: ChangelistTreeDataProvider, gitRoot: string): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('git-cl.hideChangelist', async (...args: unknown[]) => {
			const name = resolveChangelistName(args) ?? await pickChangelistForAction(scmProvider, 'hide');
			if (name && await stashSingleChangelist(scmProvider, name, gitRoot)) {
				await scmProvider.refresh();
			}
		}),
		vscode.commands.registerCommand('git-cl.showChangelist', async (...args: unknown[]) => {
			const name = resolveStashName(args) ?? await pickStashedChangelistForAction(scmProvider, 'show');
			if (name && await unstashSingleChangelist(scmProvider, name, gitRoot, false)) {
				await scmProvider.refresh();
			}
		}),
		vscode.commands.registerCommand(
			'git-cl.stashAllChangelists',
			async () => {
				const store = scmProvider.getChangelistStore();
				store.load();
				const names = [...store.getNames()];

				if (names.length === 0) {
					vscode.window.showInformationMessage('git-cl: No changelists to stash.');
					return;
				}

				let stashedCount = 0;
				for (const name of names) {
					const success = await stashSingleChangelist(scmProvider, name, gitRoot);
					if (success) {
						stashedCount++;
					}
				}

				await scmProvider.refresh();
				if (stashedCount > 0) {
					vscode.window.showInformationMessage(
						`git-cl: Stashed ${stashedCount} changelist(s).`
					);
				}
			}
		),
		vscode.commands.registerCommand(
			'git-cl.unstashAllChangelists',
			async () => {
				const stashStore = scmProvider.getStashStore();
				stashStore.load();
				const names = [...stashStore.getNames()];

				if (names.length === 0) {
					vscode.window.showInformationMessage('git-cl: No stashed changelists to unstash.');
					return;
				}

				let unstashedCount = 0;
				for (const name of names) {
					const success = await unstashSingleChangelist(scmProvider, name, gitRoot, false);
					if (success) {
						unstashedCount++;
					}
				}

				await scmProvider.refresh();
				if (unstashedCount > 0) {
					vscode.window.showInformationMessage(
						`git-cl: Unstashed ${unstashedCount} changelist(s).`
					);
				}
			}
		),
	];
}
