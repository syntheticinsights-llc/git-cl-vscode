import * as fs from 'fs';
import * as path from 'path';
import * as tty from 'tty';
import { print } from './command';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';

export const CONFLICT_CODES: ReadonlySet<string> = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

export function shouldUseColor(noColorFlag: boolean): boolean {
	return !noColorFlag && !process.env.NO_COLOR && tty.isatty(1);
}

export function resolvePath(filePath: string): string {
	const absolute = path.resolve(filePath);
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		const parent = path.dirname(absolute);
		return parent === absolute ? absolute : path.join(resolvePath(parent), path.basename(absolute));
	}
}

export function relativeToRoot(absolutePath: string, gitRoot: string): string | undefined {
	const relative = path.relative(gitRoot, absolutePath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return undefined;
	}
	return relative.split(path.sep).join('/');
}

export function relativeToCwd(absolutePath: string): string {
	return (path.relative(resolvePath(process.cwd()), absolutePath) || '.').replace(/\\/g, '/');
}

export function formatFileStatus(file: string, statusMap: ReadonlyMap<string, string>, gitRoot: string, useColor: boolean): string {
	const absolute = resolvePath(path.resolve(gitRoot, file));
	const shownPath = relativeToCwd(absolute);
	const rootRelative = relativeToRoot(absolute, gitRoot);
	if (rootRelative === undefined) {
		throw new Error(`'${absolute}' is not in the subpath of '${gitRoot}'`);
	}
	let status = statusMap.get(rootRelative) ?? '  ';
	if (status === '  ' && !fs.existsSync(absolute)) {
		status = 'XX';
		print(`Warning: The file '${shownPath}' does not exist on the current branch.\n`
			+ `         Remove it from changelist with 'git cl rm ${shownPath}'.`);
	}
	const line = `  [${status}] ${shownPath}`;
	return useColor ? `${statusColor(status)}${line}${RESET}` : line;
}

function statusColor(status: string): string {
	const [staged, unstaged] = status;
	if (CONFLICT_CODES.has(status)) {
		return RED;
	}
	if (status === '??') {
		return BLUE;
	}
	if (staged === 'A') {
		return GREEN;
	}
	if (staged !== ' ' && unstaged === ' ') {
		return GREEN;
	}
	if (staged === ' ' && unstaged !== ' ') {
		return RED;
	}
	if (staged !== ' ' && unstaged !== ' ') {
		return MAGENTA;
	}
	return RESET;
}
