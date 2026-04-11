import { mkdirSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_VAULT = join(__dirname, '..', 'fixtures', 'vault');

export function createTempVault(): { vaultPath: string; cleanup: () => void } {
  const vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
  cpSync(FIXTURE_VAULT, vaultPath, { recursive: true });
  return {
    vaultPath,
    cleanup: () => rmSync(vaultPath, { recursive: true, force: true }),
  };
}

export function addFileToVault(vaultPath: string, relativePath: string, content: string): void {
  const fullPath = join(vaultPath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

export { FIXTURE_VAULT };
