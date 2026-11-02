import { ChangelistStore } from '../core/changelistStore';
import { assertNotHidden } from '../core/hiddenChangelists';
import { StashStore } from '../core/stashStore';
import { CliCommand, OptionValues, print, Repository } from './command';

export const deleteCommand: CliCommand = {
	name: 'delete',
	usage: 'git-cl delete [-h] [--all] [CHANGELIST ...]',
	help: `Delete one or more changelists, or all of them with --all. The files themselves
are not changed.

positional arguments:
  CHANGELIST  Changelists to delete

options:
  -h, --help  show this help message and exit
  --all       Delete all changelists`,
	flags: ['all'],
	run: deleteChangelists,
};

async function deleteChangelists({ gitRoot, gitCommonDir }: Repository, flags: OptionValues, names: string[]): Promise<number> {
	const deleteAll = flags.all === true;
	if (deleteAll && names.length > 0) {
		throw new Error('Cannot specify changelist names and --all together.');
	}
	if (!deleteAll && names.length === 0) {
		throw new Error('No changelist names provided.');
	}

	const stashStore = new StashStore(gitRoot, gitCommonDir);
	const messages = await new ChangelistStore(gitRoot, gitCommonDir).update(store => {
		stashStore.load();
		assertNotHidden(names, stashStore);
		return deleteAll ? [deleteEvery(store)] : names.map(name => deleteNamed(store, name));
	});
	messages.forEach(message => print(message));
	return 0;
}

function deleteEvery(store: ChangelistStore): string {
	const count = store.getNames().length;
	if (count === 0) {
		return 'No changelists to delete.';
	}
	store.deleteAll();
	return `Deleted all ${count} changelists.`;
}

function deleteNamed(store: ChangelistStore, name: string): string {
	if (!store.getNames().includes(name)) {
		return `Changelist '${name}' not found.`;
	}
	store.deleteChangelist(name);
	return `Deleted changelist '${name}'`;
}
