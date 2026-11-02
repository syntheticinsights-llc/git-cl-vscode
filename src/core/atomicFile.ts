import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Write content so readers see either the old file or the complete new one, never a partial write. */
export function writeFileAtomic(filePath: string, content: string): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tempPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
	try {
		fs.writeFileSync(tempPath, content, 'utf-8');
		fs.renameSync(tempPath, filePath);
	} catch (e: unknown) {
		fs.rmSync(tempPath, { force: true });
		throw e;
	}
}
