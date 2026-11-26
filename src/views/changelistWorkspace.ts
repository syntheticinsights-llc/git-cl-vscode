import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChangelistStore } from '../core/changelistStore';
import { ViewMode } from '../core/fileTree';
import { getGitStatusSnapshot, getHeadCommit, getWorkingTreeLineStats, GitStatusMap } from '../core/gitUtils';
import { groupedRenames, visibleFiles } from '../core/renames';
import { StashMetadata, StashStore } from '../core/stashStore';
import { unassignedFiles } from '../core/unassigned';
import { getUntrackedLineStats, LineStats } from '../core/untrackedStats';
import { HEAD_SCHEME, HeadContentProvider } from '../host/headContentProvider';
import { WorkingTreeFileState } from '../host/workingTreeDiff';
import { ChangelistGroupNode, GroupRef, groupRefKey, groupRefOf, sameGroupRef } from './treeNodes';

const VIEW_MODE_CONTEXT_KEY = 'git-cl:viewMode';
const SELECTED_GROUP_KEY_PREFIX = 'git-cl.selectedGroup:';

/**
 * Shared state and repository coordinator behind the two native views:
 * the Changelists list and the Files tree for the selected changelist.
 */
export class ChangelistWorkspace implements vscode.Disposable {
	private readonly _onDidChangeData = new vscode.EventEmitter<void>();
	readonly onDidChangeData = this._onDidChangeData.event;

	private readonly _onDidChangeSelection = new vscode.EventEmitter<GroupRef | undefined>();
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private changelistStore: ChangelistStore;
	private stashStore: StashStore;
	private readonly disposables: vscode.Disposable[] = [];
	private repoWatchers: vscode.Disposable[] = [];

	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	private lastWarnedMissingFiles = new Set<string>();
	private refreshToken = 0;

	// Cached data from the last refresh
	private cachedChangelists: Record<string, string[]> = {};
	private cachedStashData: Record<string, StashMetadata> = {};
	private cachedGitStatus: GitStatusMap = new Map();
	private cachedRenames = new Map<string, string>();
	private cachedUnassigned: string[] = [];
	private cachedLineStats = new Map<string, LineStats>();

	private gitRoot: string;
	private gitCommonDir: string;
	private readonly headContentProvider: HeadContentProvider;
	private lastHeadCommit: string | null | undefined;
	private selectedGroup: GroupRef | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		gitRoot: string,
		private readonly outputChannel?: vscode.OutputChannel,
		gitCommonDir?: string
	) {
		this.gitRoot = gitRoot;
		this.gitCommonDir = gitCommonDir ?? path.join(gitRoot, '.git');
		this.changelistStore = new ChangelistStore(this.gitRoot, this.gitCommonDir);
		this.stashStore = new StashStore(this.gitRoot, this.gitCommonDir);
		this.selectedGroup = this.loadRememberedGroup(this.gitRoot);

		this.headContentProvider = new HeadContentProvider(this.gitRoot, this.outputChannel);
		this.disposables.push(
			this._onDidChangeData,
			this._onDidChangeSelection,
			vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, this.headContentProvider)
		);

		this.setupGlobalListeners();
		this.setupRepoWatchers();
		this.refresh().catch(err => {
			const msg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Initial refresh error: ${msg}`);
		});
	}

	/** Switches both views to another repository and reloads its changelists and watchers. */
	async setRepository(gitRoot: string, gitCommonDir?: string): Promise<void> {
		const nextCommonDir = gitCommonDir ?? path.join(gitRoot, '.git');
		if (this.gitRoot === gitRoot && this.gitCommonDir === nextCommonDir) {
			return;
		}
		this.gitRoot = gitRoot;
		this.gitCommonDir = nextCommonDir;
		this.changelistStore = new ChangelistStore(this.gitRoot, this.gitCommonDir);
		this.stashStore = new StashStore(this.gitRoot, this.gitCommonDir);
		this.headContentProvider.setDefaultGitRoot(this.gitRoot);
		this.lastHeadCommit = undefined;
		this.lastWarnedMissingFiles = new Set();
		this.cachedChangelists = {};
		this.cachedStashData = {};
		this.cachedGitStatus = new Map();
		this.cachedRenames = new Map();
		this.cachedUnassigned = [];
		this.cachedLineStats = new Map();
		this.selectedGroup = this.loadRememberedGroup(this.gitRoot);
		this.setupRepoWatchers();
		await this.refresh();
	}

	getViewMode(): ViewMode {
		return vscode.workspace.getConfiguration('git-cl').get<ViewMode>('viewMode', 'tree');
	}

	getCompactFolders(): boolean {
		return vscode.workspace.getConfiguration('scm').get<boolean>('compactFolders', true);
	}

	getChangelistStore(): ChangelistStore {
		return this.changelistStore;
	}

	getStashStore(): StashStore {
		return this.stashStore;
	}

	getGitRoot(): string {
		return this.gitRoot;
	}

	/** Clears cached HEAD contents and notifies open `git-cl-head` diff editors to reload. */
	reloadHeadDocuments(): void {
		this.headContentProvider.reloadOpenDocuments();
	}

	getGroupNodes(): ChangelistGroupNode[] {
		const nodes: ChangelistGroupNode[] = [];
		for (const name of Object.keys(this.cachedChangelists)) {
			nodes.push({ type: 'changelist', name });
		}
		for (const [name, metadata] of Object.entries(this.cachedStashData)) {
			nodes.push({ type: 'stashedChangelist', name, metadata });
		}
		if (this.cachedUnassigned.length > 0) {
			nodes.push({ type: 'unassignedSection' });
		}
		return nodes;
	}

	getSelectedGroup(): GroupRef | undefined {
		return this.selectedGroup;
	}

	getSelectedGroupNode(): ChangelistGroupNode | undefined {
		if (!this.selectedGroup) {
			return undefined;
		}
		return this.getGroupNodes().find(node => sameGroupRef(groupRefOf(node), this.selectedGroup));
	}

	selectGroup(group: GroupRef | undefined): void {
		if (sameGroupRef(this.selectedGroup, group)) {
			return;
		}
		this.selectedGroup = group;
		this.rememberGroup(this.gitRoot, group);
		this._onDidChangeSelection.fire(group);
	}

	getGroupFiles(group: GroupRef): readonly string[] {
		switch (group.type) {
			case 'changelist': return this.cachedChangelists[group.name] ?? [];
			case 'stash': return this.cachedStashData[group.name]?.files ?? [];
			case 'unassigned': return this.cachedUnassigned;
		}
	}

	/** Hidden changelists have no files on disk, so renames never apply to them. */
	getGroupRenames(group: GroupRef): Map<string, string> {
		if (group.type === 'stash') {
			return new Map();
		}
		return groupedRenames(this.cachedRenames, this.getGroupFiles(group));
	}

	getVisibleFiles(group: GroupRef): string[] {
		return visibleFiles(this.getGroupFiles(group), this.getGroupRenames(group));
	}

	getGroupLineStats(group: GroupRef): LineStats | undefined {
		if (group.type === 'stash') {
			return undefined;
		}
		let additions = 0;
		let deletions = 0;
		for (const filePath of this.getVisibleFiles(group)) {
			const stats = this.cachedLineStats.get(filePath);
			if (stats) {
				additions += stats.additions;
				deletions += stats.deletions;
			}
		}
		return additions > 0 || deletions > 0 ? { additions, deletions } : undefined;
	}

	getFileLineStats(filePath: string): LineStats | undefined {
		return this.cachedLineStats.get(filePath);
	}

	getFileStatus(filePath: string): string | undefined {
		return this.cachedGitStatus.get(filePath);
	}

	isFileMissing(filePath: string): boolean {
		const status = this.cachedGitStatus.get(filePath) ?? '  ';
		const isDeleted = status[1] === 'D' || (status[0] === 'D' && status[1] === ' ');
		return !isDeleted && !fs.existsSync(path.join(this.gitRoot, filePath));
	}

	/**
	 * Classifies a file from the cached snapshot so clicking through files opens
	 * diffs immediately without an extra `git status` per click.
	 */
	getFileDiffState(filePath: string, renamedFrom?: string): WorkingTreeFileState {
		const status = this.cachedGitStatus.get(filePath) ?? '  ';
		const isDeleted = status[1] === 'D' || (status[0] === 'D' && status[1] === ' ');
		if (isDeleted) {
			return 'deleted';
		}
		if (status === '??' || !fs.existsSync(path.join(this.gitRoot, filePath))) {
			return 'untracked';
		}
		const isAdded = status[0] === 'A' && !renamedFrom;
		if (isAdded) {
			// Newly added binary files have no line stats and cannot be text-diffed against empty HEAD.
			return this.cachedLineStats.has(filePath) ? 'added' : 'untracked';
		}
		return 'changed';
	}

	async assignFiles(targetChangelist: string, filePaths: string[]): Promise<void> {
		if (filePaths.length === 0) {
			return;
		}
		try {
			await this.changelistStore.addFilesLocked(targetChangelist, filePaths, this.stashStore);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`git-cl: ${msg}`);
			return;
		}
		await this.refresh();
	}

	async removeFiles(filePaths: string[]): Promise<void> {
		if (filePaths.length === 0) {
			return;
		}
		await this.changelistStore.update(store => {
			for (const filePath of filePaths) {
				const clName = store.findChangelist(filePath);
				if (clName) {
					store.removeFiles(clName, [filePath]);
				}
			}
		});
		await this.refresh();
	}

	async refresh(): Promise<void> {
		const token = ++this.refreshToken;
		const gitRoot = this.gitRoot;
		const changelistStore = this.changelistStore;
		const stashStore = this.stashStore;

		changelistStore.load();
		stashStore.load();

		let gitStatus: GitStatusMap;
		let renames = new Map<string, string>();
		try {
			({ status: gitStatus, renames } = await getGitStatusSnapshot(gitRoot));
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.outputChannel?.appendLine(`git-cl: Failed to read git status: ${errMsg}`);
			gitStatus = new Map();
		}

		const changelists = changelistStore.getAll();
		const stashData = stashStore.getAll();
		const assignedFiles = new Set<string>();
		for (const files of Object.values(changelists)) {
			for (const f of files) {
				assignedFiles.add(f);
			}
		}
		const unassigned = unassignedFiles(gitStatus.keys(), assignedFiles, stashStore.getStashedFiles());

		const allActiveFiles = [...assignedFiles, ...unassigned];
		const untracked = allActiveFiles.filter(file => gitStatus.get(file) === '??');

		const [headCommit, trackedStats, untrackedStats] = await Promise.all([
			getHeadCommit(gitRoot),
			// Fails cleanly on repos with an unborn HEAD; line stats are best-effort.
			getWorkingTreeLineStats(gitRoot).catch(() => new Map<string, LineStats>()),
			getUntrackedLineStats(gitRoot, untracked).catch(() => new Map<string, LineStats>()),
		]);

		if (token !== this.refreshToken || gitRoot !== this.gitRoot) {
			return;
		}

		this.cachedChangelists = changelists;
		this.cachedStashData = stashData;
		this.cachedGitStatus = gitStatus;
		this.cachedRenames = renames;
		this.cachedUnassigned = unassigned;
		this.cachedLineStats = new Map([...trackedStats, ...untrackedStats]);

		if (this.lastHeadCommit !== undefined && headCommit !== this.lastHeadCommit) {
			this.headContentProvider.reloadOpenDocuments();
		}
		this.lastHeadCommit = headCommit;

		this.warnMissingFiles(changelists, gitStatus);

		const previousSelection = this.selectedGroup;
		const resolvedSelection = this.resolveSelection(this.selectedGroup);
		const selectionChanged = !sameGroupRef(previousSelection, resolvedSelection);
		if (selectionChanged) {
			this.selectedGroup = resolvedSelection;
			this.rememberGroup(this.gitRoot, resolvedSelection);
		}

		this._onDidChangeData.fire();
		if (selectionChanged) {
			this._onDidChangeSelection.fire(resolvedSelection);
		}
	}

	dispose(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		for (const watcher of this.repoWatchers) {
			watcher.dispose();
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private resolveSelection(current: GroupRef | undefined): GroupRef | undefined {
		const nodes = this.getGroupNodes();
		if (nodes.length === 0) {
			return undefined;
		}
		if (current && nodes.some(node => sameGroupRef(groupRefOf(node), current))) {
			return current;
		}
		return groupRefOf(nodes[0]);
	}

	private warnMissingFiles(changelists: Record<string, string[]>, gitStatus: GitStatusMap): void {
		const currentMissingFiles = new Set<string>();
		for (const files of Object.values(changelists)) {
			for (const filePath of files) {
				const status = gitStatus.get(filePath);
				const isGitDeleted = status !== undefined &&
					(status[1] === 'D' || (status[0] === 'D' && status[1] === ' '));
				if (!isGitDeleted && !fs.existsSync(path.join(this.gitRoot, filePath))) {
					currentMissingFiles.add(filePath);
				}
			}
		}

		const newlyMissing = [...currentMissingFiles].filter(f => !this.lastWarnedMissingFiles.has(f));
		if (newlyMissing.length > 0) {
			const fileList = newlyMissing.slice(0, 3).join(', ');
			const suffix = newlyMissing.length > 3 ? ` and ${newlyMissing.length - 3} more` : '';
			vscode.window.showWarningMessage(
				`git-cl: ${newlyMissing.length} file(s) in changelists no longer exist on disk: ${fileList}${suffix}`
			);
		}
		this.lastWarnedMissingFiles = currentMissingFiles;
	}

	private setupGlobalListeners(): void {
		this.updateViewModeContext();
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('git-cl.viewMode') || e.affectsConfiguration('scm.compactFolders')) {
					this.updateViewModeContext();
					this._onDidChangeData.fire();
				}
			}),
			vscode.workspace.onDidSaveTextDocument(() => this.debouncedRefresh())
		);
	}

	private setupRepoWatchers(): void {
		for (const watcher of this.repoWatchers) {
			watcher.dispose();
		}
		this.repoWatchers = [];
		const gitDir = this.gitCommonDir;

		const patterns = ['cl.json', 'cl-stashes.json', 'index', 'HEAD', 'logs/HEAD'];
		for (const file of patterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(gitDir), file)
			);
			watcher.onDidChange(() => this.debouncedRefresh());
			watcher.onDidCreate(() => this.debouncedRefresh());
			watcher.onDidDelete(() => this.debouncedRefresh());
			this.repoWatchers.push(watcher);
		}
	}

	private updateViewModeContext(): void {
		vscode.commands.executeCommand('setContext', VIEW_MODE_CONTEXT_KEY, this.getViewMode());
	}

	private debouncedRefresh(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			this.refresh().catch(err => {
				const msg = err instanceof Error ? err.message : String(err);
				this.outputChannel?.appendLine(`git-cl: Refresh error: ${msg}`);
			});
		}, 300);
	}

	private loadRememberedGroup(gitRoot: string): GroupRef | undefined {
		const raw = this.context.workspaceState.get<string>(SELECTED_GROUP_KEY_PREFIX + gitRoot);
		if (!raw) {
			return undefined;
		}
		if (raw === 'unassigned') {
			return { type: 'unassigned' };
		}
		if (raw.startsWith('cl:')) {
			return { type: 'changelist', name: raw.slice(3) };
		}
		if (raw.startsWith('stash:')) {
			return { type: 'stash', name: raw.slice(6) };
		}
		return undefined;
	}

	private rememberGroup(gitRoot: string, group: GroupRef | undefined): void {
		void this.context.workspaceState.update(
			SELECTED_GROUP_KEY_PREFIX + gitRoot,
			group ? groupRefKey(group) : undefined
		);
	}
}
