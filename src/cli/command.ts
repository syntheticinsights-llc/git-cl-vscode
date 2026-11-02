import * as fs from 'fs';

export interface Repository {
	gitRoot: string;
	gitCommonDir: string;
}

export type OptionValues = Record<string, boolean | undefined>;

export interface CliCommand {
	name: string;
	usage: string;
	help: string;
	flags: readonly string[];
	requiredPositionals?: readonly string[];
	run(repository: Repository, flags: OptionValues, positionals: string[]): number | Promise<number>;
}

export function print(text = ''): void {
	fs.writeSync(1, `${text}\n`);
}

export function printError(text: string): void {
	fs.writeSync(2, `${text}\n`);
}

export class CliExit extends Error {
	constructor(readonly exitCode: number) {
		super(`exit ${exitCode}`);
	}
}

export function describeFailedCommand(command: readonly string[], exitCode: number | null): string {
	const quoted = command.map(part => `'${part}'`).join(', ');
	return `Command '[${quoted}]' returned non-zero exit status ${exitCode}.`;
}
