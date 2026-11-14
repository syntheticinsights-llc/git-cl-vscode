import { ChangelistStore } from '../core/changelistStore';
import { getGitStatus } from '../core/gitUtils';
import { assertNotHidden } from '../core/hiddenChangelists';
import { StashStore } from '../core/stashStore';
import { CliCommand, CliExit, OptionValues, print, printError, Repository } from './command';

export const pruneCommand: CliCommand = {
	name: 'prune',
	usage: 'git-cl prune [-h] [--dry-run] [CHANGELIST ...]',
	help: `Remove the files git reports no change for (already committed, or reverted
to HEAD), so each changelist holds only pending work. The files themselves
are left alone.

positional arguments:
  CHANGELIST  Changelists to prune (default: all)

options:
  -h, --help  show this help message and exit
  --dry-run   Only report what would be removed`,
	flags: ['dry-run'],
	run: pruneChangelists,
};

async function pruneChangelists({ gitRoot, gitCommonDir }: Repository, flags: OptionValues, names: string[]): Promise<number> {
	let gitStatus: ReadonlyMap<string, string>;
	try {
		gitStatus = await getGitStatus(gitRoot);
	} catch (error) {
		printError(`Error getting git status: ${error instanceof Error ? error.message : String(error)}`);
		throw new CliExit(1);
	}

	const isDryRun = flags['dry-run'] === true;
	const stashStore = new StashStore(gitRoot, gitCommonDir);
	const messages = await new ChangelistStore(gitRoot, gitCommonDir).update(store => {
		stashStore.load();
		assertNotHidden(names, stashStore);
		const unknownNames = names.filter(name => !store.getNames().includes(name));
		const unchanged = store.findUnchangedFiles(
			gitStatus,
			names.length === 0 ? undefined : names.filter(name => !unknownNames.includes(name)),
		);
		if (!isDryRun) {
			for (const [name, files] of unchanged) {
				store.removeFiles(name, [...files]);
			}
		}
		return [
			...unknownNames.map(name => `Changelist '${name}' not found.`),
			...describeRemovals(unchanged, isDryRun),
		];
	});

	if (messages.length === 0) {
		print('No unchanged files to prune.');
		return 0;
	}
	messages.forEach(message => print(message));
	return 0;
}

function describeRemovals(unchanged: ReadonlyMap<string, readonly string[]>, isDryRun: boolean): string[] {
	const verb = isDryRun ? 'Would remove' : 'Removed';
	return [...unchanged].flatMap(([name, files]) =>
		files.map(file => `${verb} '${file}' from changelist '${name}'`)
	);
}
