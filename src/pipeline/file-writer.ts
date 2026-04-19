// src/pipeline/file-writer.ts
//
// Atomic file writes via write-to-temp-then-rename.
// Used by the pipeline (Stage 6) and batch-mutate's multi-op rollback.

import { writeFileSync, renameSync, mkdirSync, existsSync, readFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { nanoid } from 'nanoid';

/**
 * Write content to a file atomically via temp-file-and-rename.
 * Creates parent directories if needed.
 */
export function atomicWriteFile(targetPath: string, content: string, tmpDir: string): void {
  // Ensure target directory exists
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Ensure tmp directory exists
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  const tmpFile = join(tmpDir, `${nanoid()}.tmp`);
  writeFileSync(tmpFile, content, 'utf-8');
  renameSync(tmpFile, targetPath);
}

/**
 * Back up a file for potential rollback during batch-mutate.
 * Returns the backup path, or null if the file doesn't exist.
 */
export function backupFile(filePath: string, tmpDir: string): string | null {
  if (!existsSync(filePath)) return null;

  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  const backupPath = join(tmpDir, `backup-${nanoid()}.md`);
  copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Restore a file from its backup location.
 */
export function restoreFile(backupPath: string, targetPath: string): void {
  renameSync(backupPath, targetPath);
}

/**
 * Clean up backup files after a successful batch-mutate.
 */
export function cleanupBackups(backupPaths: string[]): void {
  for (const bp of backupPaths) {
    try {
      unlinkSync(bp);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Read file content, returning null if the file doesn't exist.
 */
export function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
