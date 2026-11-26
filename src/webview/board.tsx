import { MotionConfig } from 'motion/react';
import { createRoot } from 'react-dom/client';
import { BoardApp } from './BoardApp';

const root = document.getElementById('root');
if (!root) {
	throw new Error('Board markup is missing #root');
}

createRoot(root).render(
	<MotionConfig reducedMotion="user">
		<BoardApp />
	</MotionConfig>
);
