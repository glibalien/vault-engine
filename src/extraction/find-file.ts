import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export async function findFileInVault(vaultPath: string, filename: string): Promise<string | null> {
  const target = basename(filename);
  async function search(dir: string): Promise<string | null> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.warn(`[findFileInVault] readdir failed for ${dir}: ${(err as Error).message}`);
      }
      return null;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && entry.name === target) return fullPath;
      if (entry.isDirectory()) {
        const found = await search(fullPath);
        if (found) return found;
      }
    }
    return null;
  }
  return search(vaultPath);
}
