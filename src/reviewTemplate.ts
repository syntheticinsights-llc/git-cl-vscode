import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_REVIEW_TEMPLATE } from './reviewPrompt';

function templatePath(gitRoot: string): string {
	const relative = vscode.workspace.getConfiguration('git-cl').get<string>('review.templateFile', '.vscode/git-cl-review-prompt.md');
	return path.resolve(gitRoot, relative);
}

/** Reads the repository's review template, falling back to the built-in default when it does not exist. */
export function readReviewTemplate(gitRoot: string): string {
	try {
		return fs.readFileSync(templatePath(gitRoot), 'utf-8');
	} catch {
		return DEFAULT_REVIEW_TEMPLATE;
	}
}

/** Opens the review template for editing, creating it from the built-in default first if needed. */
export async function editReviewTemplate(gitRoot: string): Promise<void> {
	const filePath = templatePath(gitRoot);
	if (!fs.existsSync(filePath)) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, DEFAULT_REVIEW_TEMPLATE, 'utf-8');
	}
	await vscode.window.showTextDocument(vscode.Uri.file(filePath));
}
