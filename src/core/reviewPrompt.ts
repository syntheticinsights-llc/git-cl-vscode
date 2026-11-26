export const DEFAULT_REVIEW_TEMPLATE = `Review the changes in changelist \`{{changelist}}\`.

- List its files with \`git cl status {{changelist}} --all\` and read the changes with \`git cl diff {{changelist}} --both\`; read new untracked files separately.
- Files:
{{files}}
- Report only real bugs users will hit, each with concrete reproduction steps, file:line, consequence and a suggested fix.
- Do not modify code.
`;

export interface ReviewPromptContext {
	changelist: string;
	files: readonly string[];
}

/** Fills `{{changelist}}` and `{{files}}` (one "  - path" line per file) in the template. */
export function renderReviewPrompt(template: string, context: ReviewPromptContext): string {
	const files = context.files.map(file => `  - ${file}`).join('\n');
	return template
		.replace(/\{\{\s*changelist\s*\}\}/g, () => context.changelist)
		.replace(/\{\{\s*files\s*\}\}/g, () => files);
}
