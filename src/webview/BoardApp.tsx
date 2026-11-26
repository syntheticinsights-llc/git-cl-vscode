import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardGroup, BoardSnapshot, HostMessage, RepoOption } from '../board/protocol';
import { BoardHeader } from './components/BoardHeader';
import { ChangelistList, HIDDEN_PREFIX, UNASSIGNED_KEY } from './components/ChangelistList';
import { CommitBanner, type CommitFeedback } from './components/CommitBanner';
import { FileTree } from './components/FileTree';
import { StatsBadge } from './components/StatsBadge';
import { AnimatedCheckIcon } from './icons';
import { vscodeApi } from './vscodeApi';

type PendingAction = { type: 'stage' | 'commit'; name: string } | undefined;

export function BoardApp() {
	const initialState = useMemo(() => vscodeApi.getState() ?? {}, []);
	const [snapshot, setSnapshot] = useState<BoardSnapshot | undefined>();
	const [repos, setRepos] = useState<RepoOption[]>([]);
	const [activeRepo, setActiveRepo] = useState<string>('');
	const [selectedKey, setSelectedKey] = useState<string | undefined>(initialState.selected);
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initialState.collapsed ?? []));
	const [activeFilePath, setActiveFilePath] = useState<string | undefined>();
	const [message, setMessage] = useState<string>('');
	const [pendingAction, setPendingAction] = useState<PendingAction>();
	const [stageConfirmedFor, setStageConfirmedFor] = useState<string | undefined>();
	const [commitFeedback, setCommitFeedback] = useState<CommitFeedback | undefined>();

	const feedbackCounter = useRef(0);
	const commitBannerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const stageConfirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const effectiveKey = useMemo(() => resolveSelectedKey(snapshot, selectedKey), [snapshot, selectedKey]);
	const selected = useMemo(() => findGroup(snapshot, effectiveKey), [snapshot, effectiveKey]);
	const canAct = selected !== undefined && !selected.hidden && effectiveKey !== UNASSIGNED_KEY;
	const activeChangelist = canAct ? selected.group : undefined;

	// Persist selection & collapsed folders so VS Code restores them after reload.
	useEffect(() => {
		vscodeApi.setState({ selected: effectiveKey, collapsed: [...collapsed] });
	}, [effectiveKey, collapsed]);

	// Keep local state aligned when the previously selected changelist disappears (e.g. after commit).
	useEffect(() => {
		if (snapshot && effectiveKey !== selectedKey) {
			setSelectedKey(effectiveKey);
			setMessage('');
		}
	}, [snapshot, effectiveKey, selectedKey]);

	useEffect(() => {
		const onMessage = (event: MessageEvent<HostMessage>) => {
			const incoming = event.data;
			if (incoming.type === 'snapshot') {
				setRepos(incoming.repos);
				setActiveRepo(incoming.activeRepo);
				setSnapshot(incoming.snapshot);
				return;
			}
			if (incoming.type === 'actionResult') {
				setPendingAction(undefined);
				if (incoming.ok && incoming.action === 'commit') {
					setMessage('');
					const id = ++feedbackCounter.current;
					setCommitFeedback({ id, name: incoming.name });
					if (commitBannerTimer.current) {
						clearTimeout(commitBannerTimer.current);
					}
					commitBannerTimer.current = setTimeout(() => {
						setCommitFeedback(current => (current?.id === id ? undefined : current));
					}, 2600);
				} else if (incoming.ok && incoming.action === 'stage') {
					setStageConfirmedFor(incoming.name);
					if (stageConfirmTimer.current) {
						clearTimeout(stageConfirmTimer.current);
					}
					stageConfirmTimer.current = setTimeout(() => {
						setStageConfirmedFor(current => (current === incoming.name ? undefined : current));
					}, 1800);
				}
			}
		};

		window.addEventListener('message', onMessage);
		vscodeApi.postMessage({ type: 'ready' });
		return () => {
			window.removeEventListener('message', onMessage);
			if (commitBannerTimer.current) {
				clearTimeout(commitBannerTimer.current);
			}
			if (stageConfirmTimer.current) {
				clearTimeout(stageConfirmTimer.current);
			}
		};
	}, []);

	const handleSelectGroup = useCallback((key: string) => {
		setSelectedKey(prev => {
			if (prev !== key) {
				setMessage('');
			}
			return key;
		});
	}, []);

	const handleToggleFolder = useCallback((folderKey: string) => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(folderKey)) {
				next.delete(folderKey);
			} else {
				next.add(folderKey);
			}
			return next;
		});
	}, []);

	const handleOpenFile = useCallback((filePath: string) => {
		setActiveFilePath(filePath);
		vscodeApi.postMessage({ type: 'openFile', path: filePath });
	}, []);

	const handleStage = useCallback(() => {
		if (!activeChangelist || pendingAction) {
			return;
		}
		setPendingAction({ type: 'stage', name: activeChangelist.name });
		vscodeApi.postMessage({ type: 'stage', name: activeChangelist.name });
	}, [activeChangelist, pendingAction]);

	const handleCommit = useCallback(() => {
		if (!activeChangelist || pendingAction || !message.trim()) {
			return;
		}
		setPendingAction({ type: 'commit', name: activeChangelist.name });
		vscodeApi.postMessage({ type: 'commit', name: activeChangelist.name, message });
	}, [activeChangelist, pendingAction, message]);

	const isStaging = pendingAction?.type === 'stage';
	const isCommitting = pendingAction?.type === 'commit';
	const isStageConfirmed = activeChangelist !== undefined && stageConfirmedFor === activeChangelist.name && !isStaging;
	const commitReady = activeChangelist !== undefined && message.trim() !== '' && !pendingAction;

	return (
		<div id="board">
			<BoardHeader
				repos={repos}
				activeRepo={activeRepo}
				snapshot={snapshot}
				onSwitchRepo={root => vscodeApi.postMessage({ type: 'switchRepo', root })}
				onRefresh={() => vscodeApi.postMessage({ type: 'refresh' })}
			/>
			<CommitBanner feedback={commitFeedback} />
			<main id="main">
				<ChangelistList snapshot={snapshot} selectedKey={effectiveKey} onSelect={handleSelectGroup} />
				<section id="files">
					<div id="files-header">
						<span className="name">{selected?.group.name ?? ''}</span>
						<span className="count muted">
							{selected ? `${selected.group.files.length} files` : ''}
						</span>
						<StatsBadge
							additions={selected?.group.additions}
							deletions={selected?.group.deletions}
						/>
					</div>

					{canAct && (
						<div id="commit-box">
							<textarea
								id="message"
								spellCheck={false}
								placeholder="Commit message"
								aria-label="Commit message"
								value={message}
								disabled={isCommitting}
								onChange={event => setMessage(event.target.value)}
								onKeyDown={event => {
									if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										handleCommit();
									}
								}}
							/>
							<div className="actions">
								<button
									id="stage"
									type="button"
									className={isStageConfirmed ? 'confirmed' : undefined}
									disabled={!canAct || pendingAction !== undefined}
									onClick={handleStage}
								>
									{isStaging && <span className="spinner" aria-hidden="true" />}
									{isStageConfirmed && <AnimatedCheckIcon size={12} />}
									{isStaging ? 'Staging…' : isStageConfirmed ? 'Staged' : 'Stage'}
								</button>
								<button
									id="commit-submit"
									type="button"
									className="primary"
									disabled={!commitReady}
									title={commitReady ? 'Commit this changelist' : 'Type a commit message first'}
									onClick={handleCommit}
								>
									{isCommitting && <span className="spinner" aria-hidden="true" />}
									{isCommitting ? 'Committing…' : 'Commit'}
								</button>
							</div>
						</div>
					)}

					<div id="files-list">
						{selected && selected.group.files.length === 0 && (
							<div className="empty">This changelist has no files.</div>
						)}
						{selected && selected.group.files.length > 0 && (
							<FileTree
								folder={selected.group.tree}
								groupKey={effectiveKey ?? selected.group.name}
								collapsed={collapsed}
								activeFilePath={activeFilePath}
								onToggleFolder={handleToggleFolder}
								onOpenFile={handleOpenFile}
							/>
						)}
					</div>
				</section>
			</main>
		</div>
	);
}

function findGroup(
	snapshot: BoardSnapshot | undefined,
	key: string | undefined
): { group: BoardGroup; hidden: boolean } | undefined {
	if (!snapshot || key === undefined) {
		return undefined;
	}
	if (key === UNASSIGNED_KEY) {
		return snapshot.unassigned.files.length > 0 ? { group: snapshot.unassigned, hidden: false } : undefined;
	}
	if (key.startsWith(HIDDEN_PREFIX)) {
		const name = key.slice(HIDDEN_PREFIX.length);
		const group = snapshot.hiddenChangelists.find(candidate => candidate.name === name);
		return group ? { group, hidden: true } : undefined;
	}
	const group = snapshot.changelists.find(candidate => candidate.name === key);
	return group ? { group, hidden: false } : undefined;
}

function resolveSelectedKey(snapshot: BoardSnapshot | undefined, key: string | undefined): string | undefined {
	if (!snapshot) {
		return key;
	}
	if (key !== undefined && findGroup(snapshot, key) !== undefined) {
		return key;
	}
	return snapshot.changelists[0]?.name ?? (snapshot.unassigned.files.length > 0 ? UNASSIGNED_KEY : undefined);
}
