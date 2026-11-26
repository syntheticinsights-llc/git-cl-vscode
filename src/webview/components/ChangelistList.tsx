import { AnimatePresence, motion } from 'motion/react';
import type { BoardGroup, BoardSnapshot } from '../../board/protocol';
import { ListIcon } from '../icons';
import { StatsBadge } from './StatsBadge';

export const UNASSIGNED_KEY = 'unassigned';
export const HIDDEN_PREFIX = 'hidden:';

interface ChangelistListProps {
	snapshot: BoardSnapshot | undefined;
	selectedKey: string | undefined;
	onSelect: (key: string) => void;
}

export function ChangelistList({ snapshot, selectedKey, onSelect }: ChangelistListProps) {
	if (!snapshot) {
		return <nav id="dir" />;
	}

	const isEmpty =
		snapshot.changelists.length === 0 &&
		snapshot.unassigned.files.length === 0 &&
		snapshot.hiddenChangelists.length === 0;

	return (
		<nav id="dir">
			<AnimatePresence initial={false}>
				{snapshot.changelists.map(group => (
					<GroupRow
						key={`cl:${group.name}`}
						group={group}
						groupKey={group.name}
						selected={group.name === selectedKey}
						onSelect={onSelect}
					/>
				))}
				{snapshot.unassigned.files.length > 0 && (
					<GroupRow
						key="unassigned"
						group={snapshot.unassigned}
						groupKey={UNASSIGNED_KEY}
						selected={selectedKey === UNASSIGNED_KEY}
						onSelect={onSelect}
					/>
				)}
			</AnimatePresence>

			{isEmpty && <div className="empty">No changes in this repository.</div>}

			{snapshot.hiddenChangelists.length > 0 && (
				<>
					<div className="section-label">Hidden</div>
					<AnimatePresence initial={false}>
						{snapshot.hiddenChangelists.map(group => {
							const key = HIDDEN_PREFIX + group.name;
							return (
								<GroupRow
									key={key}
									group={group}
									groupKey={key}
									hidden
									selected={key === selectedKey}
									onSelect={onSelect}
								/>
							);
						})}
					</AnimatePresence>
				</>
			)}
		</nav>
	);
}

interface GroupRowProps {
	group: BoardGroup;
	groupKey: string;
	selected: boolean;
	hidden?: boolean;
	onSelect: (key: string) => void;
}

function GroupRow({ group, groupKey, selected, hidden = false, onSelect }: GroupRowProps) {
	const classes = ['group', selected && 'selected', hidden && 'hidden-group'].filter(Boolean).join(' ');
	return (
		<motion.div
			layout="position"
			className="group-motion"
			initial={{ opacity: 0, height: 0 }}
			animate={{ opacity: 1, height: 'auto' }}
			exit={{ opacity: 0, height: 0, x: 14 }}
			transition={{
				opacity: { duration: 0.16 },
				height: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
				x: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
				layout: { type: 'spring', stiffness: 520, damping: 38 },
			}}
		>
			<div className={classes} onClick={() => onSelect(groupKey)}>
				<span className="ico">
					<ListIcon />
				</span>
				<span className="name">{group.name}</span>
				<span className="count">{group.files.length}</span>
				<StatsBadge additions={group.additions} deletions={group.deletions} />
			</div>
		</motion.div>
	);
}
