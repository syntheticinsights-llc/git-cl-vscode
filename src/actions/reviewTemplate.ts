import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_REVIEW_TEMPLATE, DEFAULT_REVIEW_TEMPLATE_FILE, readReviewTemplateFile } from '../core/reviewPrompt';

function configuredTemplateRelativePath(): string {
	return vscode.workspace.getConfiguration('git-cl').get<string>('review.templateFile', DEFAULT_REVIEW_TEMPLATE_FILE);
}

/** Reads the repository's review template, falling back to the built-in default when it does not exist. */
export function readReviewTemplate(gitRoot: string): string {
	return readReviewTemplateFile(gitRoot, configuredTemplateRelativePath());
}

/** Opens the review template for editing, creating it from the built-in default first if needed. */
export async function editReviewTemplate(gitRoot: string): Promise<void> {
	const filePath = path.resolve(gitRoot, configuredTemplateRelativePath());
	if (!fs.existsSync(filePath)) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, DEFAULT_REVIEW_TEMPLATE, 'utf-8');
	}
	await vscode.window.showTextDocument(vscode.Uri.file(filePath));
}
