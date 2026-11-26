import * as fs from 'fs';
import * as path from 'path';

export interface LineStats {
	additions: number;
	deletions: number;
}

/** Files larger than this are not read just to count lines. */
const MAX_BYTES = 4 * 1024 * 1024;
/** A NUL byte this early means binary; git uses the same idea for its own diff. */
const SNIFF_BYTES = 8000;

/**
 * Line count of a file's bytes, or undefined when the content looks binary.
 * A trailing fragment without a newline still counts as one line.
 */
export function countLines(bytes: Buffer): number | undefined {
	if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
		return undefined;
	}
	if (bytes.length === 0) {
		return 0;
	}
	let lines = 0;
	for (const byte of bytes) {
		if (byte === 0x0a) {
			lines++;
		}
	}
	return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

/** Bounds concurrent file reads so a large untracked tree cannot saturate libuv's threadpool. */
const READ_CONCURRENCY = 8;

/**
 * Line counts for untracked files, which `git diff --numstat` cannot report
 * because HEAD has no version of them. Read from disk; binaries and oversized
 * files are skipped so the board shows no number rather than a wrong one.
 */
export async function getUntrackedLineStats(
	gitRoot: string,
	files: readonly string[]
): Promise<Map<string, LineStats>> {
	const stats = new Map<string, LineStats>();
	if (files.length === 0) {
		return stats;
	}
	let cursor = 0;
	const workerCount = Math.min(READ_CONCURRENCY, files.length);
	await Promise.all(Array.from({ length: workerCount }, async () => {
		while (cursor < files.length) {
			const file = files[cursor++];
			try {
				const absolute = path.join(gitRoot, file);
				const info = await fs.promises.stat(absolute);
				if (!info.isFile() || info.size > MAX_BYTES) {
					continue;
				}
				const additions = countLines(await fs.promises.readFile(absolute));
				if (additions !== undefined) {
					stats.set(file, { additions, deletions: 0 });
				}
			} catch {
				// A file that vanished or cannot be read simply has no numbers.
			}
		}
	}));
	return stats;
}
