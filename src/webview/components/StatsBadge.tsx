interface StatsBadgeProps {
	additions?: number;
	deletions?: number;
}

export function StatsBadge({ additions = 0, deletions = 0 }: StatsBadgeProps) {
	if (additions <= 0 && deletions <= 0) {
		return <span className="stats" />;
	}
	return (
		<span className="stats">
			{additions > 0 && <span className="add">+{additions}</span>}
			{additions > 0 && deletions > 0 && ' '}
			{deletions > 0 && <span className="del">−{deletions}</span>}
		</span>
	);
}
