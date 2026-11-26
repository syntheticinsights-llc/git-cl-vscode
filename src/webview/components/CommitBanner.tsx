import { AnimatePresence, motion } from 'motion/react';
import { AnimatedCheckIcon } from '../icons';

export interface CommitFeedback {
	id: number;
	name: string;
}

interface CommitBannerProps {
	feedback: CommitFeedback | undefined;
}

export function CommitBanner({ feedback }: CommitBannerProps) {
	return (
		<AnimatePresence initial={false}>
			{feedback && (
				<motion.div
					key={feedback.id}
					className="feedback-wrap"
					initial={{ opacity: 0, height: 0 }}
					animate={{ opacity: 1, height: 'auto' }}
					exit={{ opacity: 0, height: 0 }}
					transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
				>
					<div className="feedback-banner" role="status" aria-live="polite">
						<motion.span
							className="check-badge"
							initial={{ scale: 0.6 }}
							animate={{ scale: 1 }}
							transition={{ type: 'spring', stiffness: 420, damping: 24 }}
						>
							<AnimatedCheckIcon size={11} />
						</motion.span>
						<span className="feedback-text">
							Committed <span className="feedback-name">{feedback.name}</span>
						</span>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
