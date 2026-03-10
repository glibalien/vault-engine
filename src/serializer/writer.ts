import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { acquireWriteLock, releaseWriteLock } from '../sync/watcher.js';

export function writeNodeFile(
  vaultPath: string,
  relativePath: string,
  content: string,
): void {
  acquireWriteLock(relativePath);
  try {
    const absPath = join(vaultPath, relativePath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
  } finally {
    releaseWriteLock(relativePath);
  }
}
