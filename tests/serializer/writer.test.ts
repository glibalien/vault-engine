import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeNodeFile } from '../../src/serializer/writer.js';
import { isWriteLocked } from '../../src/sync/watcher.js';

describe('writeNodeFile', () => {
  let tmpVault: string;

  afterEach(() => {
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('creates a file with the given content', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Hello\n');
    expect(readFileSync(join(tmpVault, 'test.md'), 'utf-8')).toBe('# Hello\n');
  });

  it('creates parent directories recursively', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'tasks/work/review.md', '# Review\n');
    expect(readFileSync(join(tmpVault, 'tasks/work/review.md'), 'utf-8')).toBe('# Review\n');
  });

  it('overwrites an existing file', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Original\n');
    writeNodeFile(tmpVault, 'test.md', '# Updated\n');
    expect(readFileSync(join(tmpVault, 'test.md'), 'utf-8')).toBe('# Updated\n');
  });

  it('releases write lock after successful write', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Hello\n');
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('releases write lock on filesystem error', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    // Write to a path where the parent is a file, not a directory — mkdirSync throws ENOTDIR
    writeNodeFile(tmpVault, 'blocker', '# Blocker\n');
    expect(() => writeNodeFile(tmpVault, 'blocker/nested.md', '# Fail\n')).toThrow();
    expect(isWriteLocked('blocker/nested.md')).toBe(false);
  });
});
