import * as fs from 'fs';
import * as path from 'path';
import { ChangelistStore, resolveRepoPath } from '../core/changelistStore';
import { StashStore } from '../core/stashStore';
import { CliCommand, OptionValues, print, Repository } from './command';

export const addCommand: CliCommand = {
	name: 'add',
	usage: 'git-cl add [-h] CHANGELIST FILE [FILE ...]',
	help: `Add one or more files to a changelist, creating it if needed. Files are moved
out of any other changelist.

positional arguments:
  CHANGELIST  Changelist to add the files to
  FILE        Files to add

options:
  -h, --help  show this help message and exit`,
	flags: [],
	requiredPositionals: ['CHANGELIST', 'FILE'],
	run: addFiles,
};

async function addFiles({ gitRoot, gitCommonDir }: Repository, _flags: OptionValues, [name, ...args]: string[]): Promise<number> {
	const files = args.map(arg => resolveRepoPath(arg, process.cwd(), gitRoot));
	args.forEach((arg, i) => {
		if (!fs.existsSync(path.join(gitRoot, files[i]))) {
			print(`Warning: File '${arg}' does not exist.`);
		}
	});

	const store = new ChangelistStore(gitRoot, gitCommonDir);
	await store.addFilesLocked(name, files, new StashStore(gitRoot, gitCommonDir));
	print(`Added to '${name}': [${files.map(file => `'${file}'`).join(', ')}]`);
	return 0;
}
