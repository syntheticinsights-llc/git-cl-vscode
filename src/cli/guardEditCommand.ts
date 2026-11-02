import * as fs from 'fs';
import * as path from 'path';
import { getGitCommonDir, getGitRoot } from '../core/gitUtils';
import { assertFilesNotHidden, HiddenChangelistError, HiddenFileSource } from '../core/hiddenChangelists';
import { StashStore } from '../core/stashStore';
import { printError } from './command';
import { relativeToRoot, resolvePath } from './fileStatusFormat';

interface HookInput {
	cwd?: unknown;
	tool_input?: { file_path?: unknown; notebook_path?: unknown };
}

export async function guardEdit(): Promise<number> {
	try {
		const filePath = editedFilePath(fs.readFileSync(0, 'utf-8'));
		if (filePath === undefined) {
			return 0;
		}
		const message = await hiddenEditMessage(filePath);
		if (message === undefined) {
			return 0;
		}
		printError(message);
		return 2;
	} catch {
		return 0;
	}
}

function editedFilePath(stdin: string): string | undefined {
	const input = JSON.parse(stdin) as HookInput;
	const toolInput = input.tool_input ?? {};
	const target = toolInput.file_path ?? toolInput.notebook_path;
	if (typeof target !== 'string' || target === '') {
		return undefined;
	}
	const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
	const absolute = path.resolve(cwd, target);
	return path.join(resolvePath(path.dirname(absolute)), path.basename(absolute));
}

async function hiddenEditMessage(filePath: string): Promise<string | undefined> {
	const searchDir = nearestExistingDirectory(path.dirname(filePath));
	const [gitRoot, gitCommonDir] = await Promise.all([getGitRoot(searchDir), getGitCommonDir(searchDir)]);
	const stashes = new StashStore(gitRoot, gitCommonDir);
	stashes.load();
	return findHiddenEdit(filePath, resolvePath(gitRoot), stashes);
}

function nearestExistingDirectory(dir: string): string {
	const parent = path.dirname(dir);
	return fs.existsSync(dir) || parent === dir ? dir : nearestExistingDirectory(parent);
}

export function findHiddenEdit(filePath: string, gitRoot: string, stashes: HiddenFileSource): string | undefined {
	const file = relativeToRoot(filePath, gitRoot);
	if (file === undefined || file === '') {
		return undefined;
	}
	try {
		assertFilesNotHidden([file], stashes);
		return undefined;
	} catch (error) {
		if (error instanceof HiddenChangelistError) {
			return error.message;
		}
		throw error;
	}
}
