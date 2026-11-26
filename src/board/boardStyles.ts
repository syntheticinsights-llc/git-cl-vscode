/**
 * Board styling. Metrics and colors follow VS Code's own workbench so the
 * panel does not feel like a web page pasted into the editor: 22px list rows,
 * the theme's UI font, list selection/hover colors, 24px buttons, theme
 * scrollbars. Fallbacks keep the layout readable outside VS Code.
 */
export const BOARD_STYLES = `
	:root { --row-height: 22px; --list-row-height: 24px; }
	* { box-sizing: border-box; }
	body {
		margin: 0;
		color: var(--vscode-foreground, #ccc);
		background: var(--vscode-editor-background, #1e1e1e);
		font-family: var(--vscode-font-family, -apple-system, system-ui, sans-serif);
		font-size: var(--vscode-font-size, 13px);
		height: 100vh;
		overflow: hidden;
	}
	::-webkit-scrollbar { width: 10px; height: 10px; }
	::-webkit-scrollbar-track { background: transparent; }
	::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, #79797966); }
	::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, #646464b3); }
	::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground, #bfbfbf66); }

	#board { display: flex; flex-direction: column; height: 100vh; }

	#header {
		display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
		height: 28px; padding: 0 8px; font-size: 12px;
		border-bottom: 1px solid var(--vscode-panel-border, #333);
	}
	#branch { font-weight: 600; }
	.picker { position: relative; display: inline-flex; align-items: center; flex: 0 1 auto; min-width: 0; max-width: min(220px, 45%); }
	#repo {
		font-family: inherit; font-size: 12px; height: 22px; width: 100%;
		padding: 0 18px 0 6px; cursor: pointer; appearance: none;
		color: var(--vscode-dropdown-foreground, inherit);
		background-color: var(--vscode-dropdown-background, transparent);
		border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, transparent));
		border-radius: 2px; text-overflow: ellipsis;
	}
	#repo:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
	.picker-chevron { position: absolute; right: 3px; display: flex; pointer-events: none; opacity: .8; }
	@media (max-width: 520px) {
		#summary { display: none; }
	}
	#summary { color: var(--vscode-descriptionForeground, #999); }
	#refresh { margin-left: auto; }

	button {
		display: inline-flex; align-items: center; justify-content: center; gap: 5px;
		font-family: inherit; font-size: 12px; line-height: 1; cursor: pointer;
		height: 24px; padding: 0 8px; border: none; border-radius: 2px;
		color: var(--vscode-button-secondaryForeground, #ccc);
		background: var(--vscode-button-secondaryBackground, #3a3d41);
		transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
	}
	button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
	button.primary {
		color: var(--vscode-button-foreground, #fff);
		background: var(--vscode-button-background, #0e639c);
	}
	button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
	button.confirmed {
		color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
	}
	button:disabled { opacity: .45; cursor: default; }
	button:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }

	.feedback-wrap { overflow: hidden; flex: 0 0 auto; }
	.feedback-banner {
		display: flex; align-items: center; gap: 8px;
		padding: 7px 12px; font-size: 12px;
		color: var(--vscode-foreground, #ccc);
		background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #81b88b) 14%, var(--vscode-editor-background, #1e1e1e));
		border-bottom: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #81b88b) 40%, transparent);
	}
	.feedback-banner .check-badge {
		display: inline-flex; align-items: center; justify-content: center;
		width: 16px; height: 16px; border-radius: 50%; flex: 0 0 auto;
		color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
		background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #81b88b) 18%, transparent);
	}
	.feedback-banner .feedback-text {
		flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.feedback-banner .feedback-name { font-weight: 600; }

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
	.spinner {
		width: 12px; height: 12px; border-radius: 50%;
		border: 1.5px solid currentColor; border-right-color: transparent;
		animation: spin 650ms linear infinite;
	}

	.group-motion { overflow: hidden; }
	.trow .chev svg { transition: transform 140ms cubic-bezier(0.2, 0, 0, 1); }
	.trow .chev.open svg { transform: rotate(90deg); }

	/* One column on purpose: a dragged-out window is tall, so the list of
	   changelists sits on top and the selected one fills everything below it. */
	#main { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }

	#dir {
		flex: 0 0 auto; min-height: 72px; max-height: min(45%, calc(100% - 200px)); overflow: auto; padding: 6px 0 10px;
		border-bottom: 1px solid var(--vscode-panel-border, #333);
	}

	.group {
		display: flex; align-items: center; gap: 8px; height: var(--list-row-height);
		padding: 0 12px; cursor: pointer; font-size: 13px;
	}
	.group .ico { flex: 0 0 16px; display: flex; align-items: center; justify-content: center; color: var(--vscode-icon-foreground, inherit); opacity: .9; }
	.group:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
	.group.selected {
		background: var(--vscode-list-activeSelectionBackground, #094771);
		color: var(--vscode-list-activeSelectionForeground, #fff);
	}
	#board:not(:focus-within) .group.selected {
		background: var(--vscode-list-inactiveSelectionBackground, #37373d);
		color: var(--vscode-list-inactiveSelectionForeground, inherit);
	}
	.group.selected .ico,
	.group.selected .add,
	.group.selected .del { color: inherit; }
	.group .name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.group .count { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
	.group.selected .count { color: inherit; }
	.group .stats { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.group.hidden-group .name { opacity: .8; font-style: italic; }

	.section-label {
		height: var(--row-height); line-height: var(--row-height); padding: 4px 12px 0;
		font-size: 11px; color: var(--vscode-descriptionForeground, #999);
	}

	.add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
	.del { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
	.muted { color: var(--vscode-descriptionForeground, #999); }

	.trow {
		display: flex; align-items: center; gap: 6px; height: var(--row-height);
		padding-right: 12px; cursor: pointer; font-size: 13px;
	}
	.trow:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
	.trow.file.selected {
		background: var(--vscode-list-inactiveSelectionBackground, #37373d);
		color: var(--vscode-list-inactiveSelectionForeground, inherit);
	}
	.trow .chev, .trow .ico { flex: 0 0 16px; display: flex; align-items: center; justify-content: center; }
	.trow .ico { color: var(--vscode-icon-foreground, inherit); opacity: .9; }
	.trow.folder .name { font-weight: 400; }
	.trow .name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.trow .status { flex: 0 0 10px; text-align: center; font-size: 11px; font-weight: 600; }
	.trow .stats { flex: 0 0 auto; font-size: 11px; font-variant-numeric: tabular-nums; }
	.trow .status[data-code="M"] { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
	.trow .status[data-code="A"] { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
	.trow .status[data-code="D"] { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
	.trow .status[data-code="R"] { color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }
	.trow .status[data-code="U"] { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
	.trow .status[data-code="!"] { color: var(--vscode-gitDecoration-conflictingResourceForeground, #e4676b); }
	.trow .status[data-code="none"] { color: var(--vscode-descriptionForeground, #999); }

	#files { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
	#files-header {
		display: flex; align-items: center; gap: 10px; flex: 0 0 auto; flex-wrap: wrap;
		height: 32px; padding: 0 12px;
		border-bottom: 1px solid var(--vscode-panel-border, #333);
	}
	#files-header .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	#files-header .count { font-size: 11px; }
	#files-header .stats { font-size: 11px; font-variant-numeric: tabular-nums; }

	#commit-box {
		display: flex; flex-direction: column; gap: 10px; flex: 0 1 auto; min-height: 0;
		padding: 12px; border-bottom: 1px solid var(--vscode-panel-border, #333);
	}
	#commit-box[hidden] { display: none; }
	#message {
		min-height: clamp(34px, 8vh, 84px); max-height: 30vh; padding: 6px 8px; resize: none;
		font-family: var(--vscode-font-family, inherit); font-size: 12px;
		color: var(--vscode-input-foreground, #ccc);
		background: var(--vscode-input-background, #3c3c3c);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 2px;
	}
	#message:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
	#commit-box .actions { display: flex; gap: 8px; }

	#files-list { overflow: auto; min-height: 60px; flex: 1 1 auto; padding: 8px 0 12px; }
	.empty { padding: 8px 12px; font-size: 12px; color: var(--vscode-descriptionForeground, #999); }
`;
