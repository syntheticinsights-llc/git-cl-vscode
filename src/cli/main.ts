import { spawnSync } from 'child_process';
import { parseArgs } from 'util';
import { getGitCommonDir } from '../core/gitUtils';
import { CliCommand, CliExit, describeFailedCommand, OptionValues, print, printError, Repository } from './command';
import { diffCommand } from './diffCommand';
import { resolvePath } from './fileStatusFormat';
import { statusCommand } from './statusCommand';

const PROG = 'git-cl';
const MAIN_USAGE = 'git cl <command> [<args>]';

const COMMANDS: ReadonlyMap<string, CliCommand> = new Map([
	['status', statusCommand],
	['s', statusCommand],
	['st', statusCommand],
	['diff', diffCommand],
]);

const MAIN_HELP = `usage: ${MAIN_USAGE}

Commands:
  status (s, st)  Show file changes grouped by changelist
  diff            Show git diff for one or more changelists`;

interface ParsedArgs {
	flags: OptionValues;
	positionals: string[];
}

class UsageError extends Error {
	constructor(readonly usage: string, readonly prog: string, message: string) {
		super(message);
	}
}

async function main(args: string[]): Promise<number> {
	const [commandName, ...commandArgs] = args;
	if (commandName === undefined) {
		print(MAIN_HELP);
		return 0;
	}
	const command = COMMANDS.get(commandName);
	if (!command) {
		throw new UsageError(MAIN_USAGE, PROG, unknownCommandMessage(commandName, args));
	}
	const parsed = parseCommandArgs(command, commandArgs);
	if (!parsed) {
		print(`usage: ${command.usage}\n\n${command.help}`);
		return 0;
	}
	return command.run(await openRepository(), parsed.flags, parsed.positionals);
}

function unknownCommandMessage(commandName: string, args: string[]): string {
	if (commandName.startsWith('-')) {
		return `unrecognized arguments: ${args.join(' ')}`;
	}
	const choices = [...COMMANDS.keys()].map(name => `'${name}'`).join(', ');
	return `argument command: invalid choice: '${commandName}' (choose from ${choices})`;
}

function parseCommandArgs(command: CliCommand, args: string[]): ParsedArgs | undefined {
	const options = Object.fromEntries([
		['help', { type: 'boolean' as const, short: 'h' }],
		...command.flags.map(flag => [flag, { type: 'boolean' as const }]),
	]);
	const { values, positionals, tokens } = parseArgs({ args, options, allowPositionals: true, strict: false, tokens: true });
	if (values.help === true) {
		return undefined;
	}

	const prog = `${PROG} ${command.name}`;
	const optionTokens = tokens.filter(token => token.kind === 'option');
	const unknown = optionTokens.filter(token => !Object.prototype.hasOwnProperty.call(options, token.name));
	if (unknown.length > 0) {
		throw new UsageError(command.usage, prog, `unrecognized arguments: ${unknown.map(token => token.rawName).join(' ')}`);
	}
	const withValue = optionTokens.find(token => token.inlineValue);
	if (withValue) {
		throw new UsageError(command.usage, prog, `argument ${withValue.rawName}: ignored explicit argument '${withValue.value}'`);
	}
	if (command.requiredPositional && positionals.length === 0) {
		throw new UsageError(command.usage, prog, `the following arguments are required: ${command.requiredPositional}`);
	}
	return { flags: values as OptionValues, positionals };
}

async function openRepository(): Promise<Repository> {
	let gitCommonDir: string;
	try {
		gitCommonDir = await getGitCommonDir(process.cwd());
	} catch {
		print('Error: Not inside a Git repository.');
		print('Please run this command from within a Git repository.');
		throw new CliExit(1);
	}

	const command = ['git', 'rev-parse', '--show-toplevel'];
	const result = spawnSync(command[0], command.slice(1), { encoding: 'utf-8', stdio: ['inherit', 'pipe', 'inherit'] });
	if (result.status !== 0) {
		print(`Error: Not inside a Git repository. ${describeFailedCommand(command, result.status)}`);
		throw new CliExit(1);
	}
	return { gitRoot: resolvePath(result.stdout.trim()), gitCommonDir };
}

function exitCodeFor(error: unknown): number {
	if (error instanceof CliExit) {
		return error.exitCode;
	}
	if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
		return 1;
	}
	if (error instanceof UsageError) {
		printError(`usage: ${error.usage}\n${error.prog}: error: ${error.message}`);
		return 2;
	}
	printError(`${PROG}: error: ${error instanceof Error ? error.message : String(error)}`);
	return 1;
}

main(process.argv.slice(2)).then(
	exitCode => {
		process.exitCode = exitCode;
	},
	error => {
		process.exitCode = exitCodeFor(error);
	},
);
