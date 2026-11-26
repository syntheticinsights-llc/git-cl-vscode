import type { BoardSnapshot, RepoOption } from '../../board/protocol';
import { PickerChevronIcon } from '../icons';

interface BoardHeaderProps {
	repos: readonly RepoOption[];
	activeRepo: string;
	snapshot: BoardSnapshot | undefined;
	onSwitchRepo: (root: string) => void;
	onRefresh: () => void;
}

export function BoardHeader({ repos, activeRepo, snapshot, onSwitchRepo, onRefresh }: BoardHeaderProps) {
	const fileCount = snapshot
		? snapshot.changelists.reduce((total, group) => total + group.files.length, 0)
		: 0;
	const summary = snapshot
		? `${snapshot.changelists.length} changelists · ${fileCount} files · ${snapshot.unassigned.files.length} unassigned`
		: '';

	return (
		<header id="header">
			<span className="picker">
				<select
					id="repo"
					title="Repository"
					value={activeRepo}
					onChange={event => onSwitchRepo(event.target.value)}
				>
					{repos.map(repo => (
						<option key={repo.root} value={repo.root} title={repo.root}>
							{repo.label}
						</option>
					))}
				</select>
				<span className="picker-chevron">
					<PickerChevronIcon />
				</span>
			</span>
			<span id="branch">{snapshot ? (snapshot.branch ?? 'detached') : ''}</span>
			<span id="summary">{summary}</span>
			<button id="refresh" type="button" title="Refresh" onClick={onRefresh}>
				Refresh
			</button>
		</header>
	);
}
