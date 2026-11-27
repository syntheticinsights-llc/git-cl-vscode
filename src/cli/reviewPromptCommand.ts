import * as fs from 'fs';
import { ChangelistStore } from '../core/changelistStore';
import { assertNotHidden } from '../core/hiddenChangelists';
import { readReviewTemplateFile, renderReviewPrompt } from '../core/reviewPrompt';
import { StashStore } from '../core/stashStore';
import { CliCommand, OptionValues, printError, Repository } from './command';

export const reviewPromptCommand: CliCommand = {
	name: 'review-prompt',
	usage: 'git-cl review-prompt [-h] CHANGELIST',
	help: `Print the rendered review prompt for a changelist, using
.vscode/git-cl-review-prompt.md when present or the built-in template otherwise.

positional arguments:
  CHANGELIST  Changelist to generate a review prompt for

options:
  -h, --help  show this help message and exit`,
	flags: [],
	requiredPositionals: ['CHANGELIST'],
	run: runReviewPrompt,
};

/** Renders the review prompt for `name`, returning `undefined` when the changelist does not exist. */
export function buildReviewPromptForChangelist({ gitRoot, gitCommonDir }: Repository, name: string): string | undefined {
	const stashStore = new StashStore(gitRoot, gitCommonDir);
	stashStore.load();
	assertNotHidden([name], stashStore);

	const store = new ChangelistStore(gitRoot, gitCommonDir);
	store.load();
	const changelists = store.getAll();
	if (!Object.prototype.hasOwnProperty.call(changelists, name)) {
		return undefined;
	}

	const template = readReviewTemplateFile(gitRoot);
	return renderReviewPrompt(template, { changelist: name, files: changelists[name] });
}

function runReviewPrompt(repository: Repository, _flags: OptionValues, positionals: string[]): number {
	if (positionals.length > 1) {
		printError(`Error: Expected a single changelist name, got ${positionals.length}.`);
		return 1;
	}
	const name = positionals[0];
	const prompt = buildReviewPromptForChangelist(repository, name);
	if (prompt === undefined) {
		printError(`Changelist '${name}' not found.`);
		return 1;
	}
	fs.writeSync(1, prompt.endsWith('\n') ? prompt : `${prompt}\n`);
	return 0;
}
