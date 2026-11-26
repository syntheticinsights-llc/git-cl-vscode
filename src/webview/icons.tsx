import { motion } from 'motion/react';

export function ChevronRightIcon() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.1" />
		</svg>
	);
}

export function PickerChevronIcon() {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<path d="M4 6.5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.1" />
		</svg>
	);
}

export function FolderIcon() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<path d="M1.8 4.3h4l1.4 1.6h7v6.6H1.8z" fill="none" stroke="currentColor" strokeWidth="1" />
		</svg>
	);
}

export function ListIcon() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<circle cx="3" cy="4" r="1" fill="currentColor" />
			<circle cx="3" cy="8" r="1" fill="currentColor" />
			<circle cx="3" cy="12" r="1" fill="currentColor" />
			<path d="M6 4h7M6 8h7M6 12h7" fill="none" stroke="currentColor" strokeWidth="1" />
		</svg>
	);
}

export function FileIcon() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<path d="M4.2 2h4.6L12 5.2v8.8H4.2z" fill="none" stroke="currentColor" strokeWidth="1" />
			<path d="M8.8 2v3.2H12" fill="none" stroke="currentColor" strokeWidth="1" />
		</svg>
	);
}

export function AnimatedCheckIcon({ size = 12 }: { size?: number }) {
	return (
		<svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
			<motion.path
				d="M3.2 8.4l3.1 3.1 6.5-6.8"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
				initial={{ pathLength: 0, opacity: 0.4 }}
				animate={{ pathLength: 1, opacity: 1 }}
				transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
			/>
		</svg>
	);
}
