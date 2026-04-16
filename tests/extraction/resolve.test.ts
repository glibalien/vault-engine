import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { resolveEmbedRef } from '../../src/extraction/resolve.js';

describe('resolveEmbedRef', () => {
  let db: Database.Database;
  let vaultDir: string;

  beforeEach(() => {
    db = createTestDb();
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-resolve-'));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('resolves a non-markdown file at vault root', async () => {
    writeFileSync(join(vaultDir, 'audio.m4a'), 'fake');
    const r = await resolveEmbedRef(db, vaultDir, 'audio.m4a');
    expect(r).not.toBeNull();
    expect(r!.isMarkdown).toBe(false);
    expect(r!.filePath).toBe(join(vaultDir, 'audio.m4a'));
    expect(r!.nodeId).toBeNull();
  });

  it('resolves a non-markdown file via basename search', async () => {
    mkdirSync(join(vaultDir, 'sub'));
    writeFileSync(join(vaultDir, 'sub', 'image.png'), 'fake');
    const r = await resolveEmbedRef(db, vaultDir, 'image.png');
    expect(r).not.toBeNull();
    expect(r!.isMarkdown).toBe(false);
    expect(r!.filePath).toBe(join(vaultDir, 'sub', 'image.png'));
  });

  it('resolves a markdown ref to a known node', async () => {
    db.prepare("INSERT INTO nodes (id, file_path, title, body) VALUES ('n1', 'Notes/Thing.md', 'Thing', '')").run();
    const r = await resolveEmbedRef(db, vaultDir, 'Thing');
    expect(r).not.toBeNull();
    expect(r!.isMarkdown).toBe(true);
    expect(r!.nodeId).toBe('n1');
    expect(r!.filePath).toBe(join(vaultDir, 'Notes/Thing.md'));
  });

  it('returns null for an unknown ref', async () => {
    const r = await resolveEmbedRef(db, vaultDir, 'nope.xyz');
    expect(r).toBeNull();
  });
});
