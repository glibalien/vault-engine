// src/pipeline/safe-path.ts
//
// Path containment guard. Ensures resolved paths stay within the vault root.
// Prevents path traversal via ../ segments in user-supplied directory, title,
// file_path, and filename parameters.

import { resolve, sep } from 'node:path';

/**
 * Resolve a vault-relative path and verify it stays within the vault root.
 * Throws if the resolved path escapes the vault directory.
 */
export function safeVaultPath(vaultPath: string, relativePath: string): string {
  const root = resolve(vaultPath);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path traversal blocked: "${relativePath}" escapes vault root`);
  }
  return resolved;
}
