import * as vscode from 'vscode';
import { getGitStatus } from './gitUtils';
import { ChangelistTreeDataProvider } from './changelistTreeProvider';

// ANSI color codes for output channel formatting
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

/**
 * Map a 2-char git porcelain status to an ANSI-colored status label.
 */
function colorizeStatus(status: string): string {
	if (status === '??') {
		return `${GREEN}??${RESET}`;
	}

	const index = status[0];
	const working = status[1];

	// Conflicts
	if (index === 'U' || working === 'U' ||
		(index === 'A' && working === 'A') ||
		(index === 'D' && working === 'D')) {
		return `${RED}${status}${RESET}`;
	}

	// Deleted
	if (working === 'D' || index === 'D') {
		return `${RED}${status}${RESET}`;
	}

	// Added
	if (index === 'A') {
		return `${GREEN}${status}${RESET}`;
	}

	// Modified
	if (working === 'M' || index === 'M') {
		return `${YELLOW}${status}${RESET}`;
	}

	// Renamed / Copied
	if (index === 'R' || index === 'C') {
		return `${YELLOW}${status}${RESET}`;
	}

	return status;
}

/**
 * Show formatted changelist status in the output channel.
 */
export async function showFormattedStatus(
	outputChannel: vscode.OutputChannel,
	scmProvider: ChangelistTreeDataProvider,
	gitRoot: string
): Promise<void> {
	const store = scmProvider.getChangelistStore();
	store.load();
	const stashStore = scmProvider.getStashStore();
	stashStore.load();

	let gitStatusMap: Map<string, string>;
	try {
		gitStatusMap = await getGitStatus(gitRoot);
	} catch {
		vscode.window.showErrorMessage('git-cl: Failed to read git status.');
		return;
	}

	const changelists = store.getAll();
	const stashData = stashStore.getAll();
	const activeNames = Object.keys(changelists);
	const stashedNames = Object.keys(stashData);

	outputChannel.clear();
	outputChannel.appendLine(`${BOLD}=== git-cl status ===${RESET}`);
	outputChannel.appendLine('');

	// Active changelists section
	const assignedFiles = new Set<string>();

	if (activeNames.length > 0) {
		outputChannel.appendLine(`${BOLD}Active Changelists:${RESET}`);
		outputChannel.appendLine('');

		for (const name of activeNames) {
			const files = changelists[name];
			outputChannel.appendLine(`  ${BOLD}${CYAN}${name}${RESET} ${DIM}(${files.length} file${files.length !== 1 ? 's' : ''})${RESET}`);
			for (const filePath of files) {
				assignedFiles.add(filePath);
				const status = gitStatusMap.get(filePath);
				if (status) {
					outputChannel.appendLine(`    ${colorizeStatus(status)} ${filePath}`);
				} else {
					outputChannel.appendLine(`    ${DIM}  ${RESET} ${filePath} ${DIM}(clean)${RESET}`);
				}
			}
			outputChannel.appendLine('');
		}
	} else {
		outputChannel.appendLine(`${DIM}No active changelists.${RESET}`);
		outputChannel.appendLine('');
	}

	// Stashed changelists section
	if (stashedNames.length > 0) {
		outputChannel.appendLine(`${BOLD}Stashed Changelists:${RESET}`);
		outputChannel.appendLine('');

		for (const name of stashedNames) {
			const meta = stashData[name];
			const date = new Date(meta.timestamp).toLocaleString();
			outputChannel.appendLine(`  ${BOLD}${CYAN}${name}${RESET} ${DIM}(stashed from ${meta.source_branch}, ${date})${RESET}`);
			for (const filePath of meta.files) {
				assignedFiles.add(filePath);
				outputChannel.appendLine(`    ${DIM}  ${filePath}${RESET}`);
			}
			outputChannel.appendLine('');
		}
	}

	// Unassigned files section
	const stashedFiles = stashStore.getStashedFiles();
	const unassigned: [string, string][] = [];
	for (const [filePath, status] of gitStatusMap) {
		if (!assignedFiles.has(filePath) && !stashedFiles.has(filePath)) {
			unassigned.push([filePath, status]);
		}
	}

	if (unassigned.length > 0) {
		outputChannel.appendLine(`${BOLD}Unassigned Files:${RESET}`);
		outputChannel.appendLine('');
		for (const [filePath, status] of unassigned) {
			outputChannel.appendLine(`    ${colorizeStatus(status)} ${filePath}`);
		}
		outputChannel.appendLine('');
	}

	// Summary
	const totalActive = activeNames.reduce(
		(sum, name) => sum + changelists[name].length, 0
	);
	outputChannel.appendLine(
		`${DIM}${activeNames.length} changelist(s), ${totalActive} assigned file(s), ` +
		`${unassigned.length} unassigned, ${stashedNames.length} stashed${RESET}`
	);

	outputChannel.show(true);
}
