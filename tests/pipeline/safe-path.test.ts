import { describe, it, expect } from 'vitest';
import { safeVaultPath } from '../../src/pipeline/safe-path.js';

describe('safeVaultPath', () => {
  const vault = '/home/user/vault';

  it('allows simple relative paths', () => {
    expect(safeVaultPath(vault, 'notes/file.md')).toBe('/home/user/vault/notes/file.md');
  });

  it('allows nested directories', () => {
    expect(safeVaultPath(vault, 'a/b/c/file.md')).toBe('/home/user/vault/a/b/c/file.md');
  });

  it('allows bare filenames', () => {
    expect(safeVaultPath(vault, 'file.md')).toBe('/home/user/vault/file.md');
  });

  it('blocks ../ traversal', () => {
    expect(() => safeVaultPath(vault, '../etc/passwd')).toThrow('Path traversal blocked');
  });

  it('blocks ../../ traversal', () => {
    expect(() => safeVaultPath(vault, '../../etc/shadow')).toThrow('Path traversal blocked');
  });

  it('blocks mid-path traversal', () => {
    expect(() => safeVaultPath(vault, 'notes/../../etc/passwd')).toThrow('Path traversal blocked');
  });

  it('blocks directory param traversal', () => {
    expect(() => safeVaultPath(vault, '../../.ssh/authorized_keys')).toThrow('Path traversal blocked');
  });

  it('allows paths that contain .. in names but stay inside vault', () => {
    // A file literally named "foo..bar.md" is fine
    expect(safeVaultPath(vault, 'foo..bar.md')).toBe('/home/user/vault/foo..bar.md');
  });

  it('blocks absolute paths that escape vault', () => {
    expect(() => safeVaultPath(vault, '/etc/passwd')).toThrow('Path traversal blocked');
  });

  it('allows the vault root itself', () => {
    expect(safeVaultPath(vault, '')).toBe('/home/user/vault');
    expect(safeVaultPath(vault, '.')).toBe('/home/user/vault');
  });
});
