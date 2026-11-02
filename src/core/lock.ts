import * as fs from 'fs';
import * as path from 'path';

const LOCK_FILE_NAME = 'git-cl.lock';
const TAKEOVER_FILE_NAME = 'git-cl.lock.takeover';
const DEFAULT_TIMEOUT_MS = 10_000;
const ABANDONED_FILE_MS = 5_000;
const MIN_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 100;

/**
 * Run fn while holding the git-cl write lock in the git common dir, shared
 * by the extension and the CLI. Not reentrant: calling it again from fn
 * waits for itself and times out.
 */
export async function withLock<T>(
	gitCommonDir: string,
	fn: () => T | Promise<T>,
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
	const lockPath = path.join(gitCommonDir, LOCK_FILE_NAME);
	await acquireLock(lockPath, timeoutMs);
	try {
		return await fn();
	} finally {
		fs.rmSync(lockPath, { force: true });
	}
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let backoffMs = MIN_BACKOFF_MS;
	for (;;) {
		if (tryCreateOwnedFile(lockPath)) {
			return;
		}
		if (isLockStale(lockPath) && tryRemoveStaleLock(lockPath)) {
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for the git-cl lock held by process ${readHolderPid(lockPath) ?? 'unknown'} (${lockPath}).`);
		}
		await sleep(backoffMs * (0.5 + Math.random()));
		backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
	}
}

function tryCreateOwnedFile(filePath: string): boolean {
	try {
		fs.writeFileSync(filePath, String(process.pid), { flag: 'wx' });
		return true;
	} catch (e: unknown) {
		if (isErrorCode(e, 'EEXIST')) {
			return false;
		}
		throw e;
	}
}

/**
 * A lock is stale when its holder is no longer running, or when it names no
 * holder and is too old to be one still being written.
 */
function isLockStale(lockPath: string): boolean {
	const holder = readHolderPid(lockPath);
	return holder === undefined ? isAbandoned(lockPath) : !isProcessAlive(holder);
}

/**
 * Only the process holding the takeover file may remove a stale lock, and it
 * removes it only if the lock is still stale, so a lock that another process
 * has meanwhile taken over is never removed.
 */
function tryRemoveStaleLock(lockPath: string): boolean {
	const takeoverPath = path.join(path.dirname(lockPath), TAKEOVER_FILE_NAME);
	if (!tryCreateOwnedFile(takeoverPath)) {
		removeAbandonedTakeover(takeoverPath);
		return false;
	}
	try {
		if (!isLockStale(lockPath)) {
			return false;
		}
		fs.rmSync(lockPath, { force: true });
		return true;
	} finally {
		fs.rmSync(takeoverPath, { force: true });
	}
}

function removeAbandonedTakeover(takeoverPath: string): void {
	if (isAbandoned(takeoverPath)) {
		fs.rmSync(takeoverPath, { force: true });
	}
}

function isAbandoned(filePath: string): boolean {
	try {
		return Date.now() - fs.statSync(filePath).mtimeMs > ABANDONED_FILE_MS;
	} catch {
		return false;
	}
}

function readHolderPid(lockPath: string): number | undefined {
	try {
		const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: unknown) {
		return !isErrorCode(e, 'ESRCH');
	}
}

function isErrorCode(e: unknown, code: string): boolean {
	return (e as NodeJS.ErrnoException | undefined)?.code === code;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
