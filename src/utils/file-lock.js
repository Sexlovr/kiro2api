import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Atomic file write — writes to a temp file then renames.
 * Prevents corruption from concurrent writes or crashes mid-write.
 */
export async function atomicWriteFile(filePath, data, options = {}) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tmpSuffix = `.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const tmpPath = filePath + tmpSuffix;

    try {
        await fs.writeFile(tmpPath, data, options);
        await fs.rename(tmpPath, filePath);
    } catch (err) {
        try { await fs.unlink(tmpPath); } catch (_) { }
        throw err;
    }
}
