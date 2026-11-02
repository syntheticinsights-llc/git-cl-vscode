import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { ChangelistStore } from './changelistStore';
import { withLock } from './lock';

const execFileAsync = promisify(execFile);

const WORKER_SOURCE = `
import { ChangelistStore } from './changelistStore';

async function main(): Promise<void> {
	const [gitRoot, workerId, count] = process.argv.slice(2);
	const store = new ChangelistStore(gitRoot);
	for (let i = 0; i < Number(count); i++) {
		await store.update(s => s.addFiles('shared', [\`worker-\${workerId}/file-\${i}.ts\`]));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
`;

function deadPid(): number {
	const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' }));
	expect(() => process.kill(pid, 0)).toThrow();
	return pid;
}

describe('withLock', () => {
	let tmpDir: string;
	let gitDir: string;
	let lockPath: string;
	let workerPath: string;

	beforeAll(() => {
		const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-worker-'));
		workerPath = path.join(bundleDir, 'worker.js');
		esbuild.buildSync({
			stdin: { contents: WORKER_SOURCE, resolveDir: __dirname, loader: 'ts' },
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outfile: workerPath,
		});
		return () => fs.rmSync(bundleDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
		gitDir = path.join(tmpDir, '.git');
		fs.mkdirSync(gitDir);
		lockPath = path.join(gitDir, 'git-cl.lock');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function runWorkers(workerCount: number, updatesPerWorker: number): Promise<void> {
		await Promise.all(Array.from({ length: workerCount }, (_, id) =>
			execFileAsync(process.execPath, [workerPath, tmpDir, String(id), String(updatesPerWorker)])
		));
	}

	function expectAllWorkerFiles(workerCount: number, updatesPerWorker: number): void {
		const store = new ChangelistStore(tmpDir);
		store.load();
		const expected = Array.from({ length: workerCount }, (_, id) =>
			Array.from({ length: updatesPerWorker }, (_, i) => `worker-${id}/file-${i}.ts`)
		).flat();
		expect([...store.getFiles('shared')].sort()).toEqual(expected.sort());
	}

	it('loses no updates from concurrent processes', async () => {
		await runWorkers(8, 10);
		expectAllWorkerFiles(8, 10);
		expect(fs.existsSync(lockPath)).toBe(false);
	}, 30_000);

	it('lets exactly one of many processes take over a stale lock', async () => {
		fs.writeFileSync(lockPath, String(deadPid()));
		await runWorkers(8, 3);
		expectAllWorkerFiles(8, 3);
		expect(fs.existsSync(lockPath)).toBe(false);
	}, 30_000);

	it('takes over a lock whose holder is no longer running', async () => {
		fs.writeFileSync(lockPath, String(deadPid()));
		await expect(withLock(gitDir, () => fs.readFileSync(lockPath, 'utf-8'))).resolves.toBe(String(process.pid));
	});

	it('takes over an old lock that names no holder', async () => {
		fs.writeFileSync(lockPath, '');
		const sixSecondsAgo = new Date(Date.now() - 6_000);
		fs.utimesSync(lockPath, sixSecondsAgo, sixSecondsAgo);
		await expect(withLock(gitDir, () => fs.readFileSync(lockPath, 'utf-8'), 200)).resolves.toBe(String(process.pid));
	});

	it('times out naming the holder when a live process keeps the lock', async () => {
		fs.writeFileSync(lockPath, String(process.pid));
		await expect(withLock(gitDir, () => 'ran', 200)).rejects.toThrow(String(process.pid));
		expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
	});

	it('serializes concurrent holders within one process', async () => {
		let active = 0;
		let maxActive = 0;
		await Promise.all(Array.from({ length: 5 }, () => withLock(gitDir, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise(resolve => setTimeout(resolve, 10));
			active--;
		})));
		expect(maxActive).toBe(1);
	});

	it('releases the lock when fn throws', async () => {
		await expect(withLock(gitDir, () => {
			throw new Error('boom');
		})).rejects.toThrow('boom');
		expect(fs.existsSync(lockPath)).toBe(false);
		await expect(withLock(gitDir, () => 'next', 200)).resolves.toBe('next');
	});
});
