import { ChangelistStore, resolveRepoPath } from '../core/changelistStore';
import { assertFilesNotHidden } from '../core/hiddenChangelists';
import { StashStore } from '../core/stashStore';
import { CliCommand, OptionValues, print, Repository } from './command';

export const removeCommand: CliCommand = {
	name: 'remove',
	usage: 'git-cl remove [-h] FILE [FILE ...]',
	help: `Remove one or more files from whichever changelist holds them.

positional arguments:
  FILE        Files to remove

options:
  -h, --help  show this help message and exit`,
	flags: [],
	requiredPositionals: ['FILE'],
	run: removeFiles,
};

async function removeFiles({ gitRoot, gitCommonDir }: Repository, _flags: OptionValues, args: string[]): Promise<number> {
	const files = args.map(arg => resolveRepoPath(arg, process.cwd(), gitRoot));
	const stashStore = new StashStore(gitRoot, gitCommonDir);
	const messages = await new ChangelistStore(gitRoot, gitCommonDir).update(store => {
		stashStore.load();
		assertFilesNotHidden(files, stashStore);
		return files.map((file, i) => {
			const name = store.findChangelist(file);
			if (name === null) {
				return `'${args[i]}' was not found in any changelist.`;
			}
			store.removeFiles(name, [file]);
			return `Removed '${file}' from changelist '${name}'`;
		});
	});
	messages.forEach(message => print(message));
	return 0;
}
