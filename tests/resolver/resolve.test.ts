import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { resolveTarget } from '../../src/resolver/resolve.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  const insert = db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insert.run('n1', 'Notes/Alice Smith.md', 'Alice Smith', '', 'h1', 1000, 1000);
  insert.run('n2', 'Notes/Bob Jones.md', 'Bob Jones', '', 'h2', 1000, 1000);
  insert.run('n3', 'Projects/Vault Engine.md', 'Vault Engine', '', 'h3', 1000, 1000);
  insert.run('n4', 'Notes/café.md', 'Café Notes', '', 'h4', 1000, 1000);
  // Ambiguous: two files with same basename
  insert.run('n5', 'Archive/Old/Meeting.md', 'Meeting', '', 'h5', 1000, 1000);
  insert.run('n6', 'Notes/Meeting.md', 'Meeting', '', 'h6', 1000, 1000);
});

describe('resolveTarget', () => {
  it('resolves exact file_path match', () => {
    const result = resolveTarget(db, 'Notes/Alice Smith.md');
    expect(result).toEqual({ id: 'n1', title: 'Alice Smith' });
  });

  it('resolves basename match (without .md)', () => {
    const result = resolveTarget(db, 'Alice Smith');
    expect(result).toEqual({ id: 'n1', title: 'Alice Smith' });
  });

  it('resolves case-insensitive basename match', () => {
    const result = resolveTarget(db, 'alice smith');
    expect(result).toEqual({ id: 'n1', title: 'Alice Smith' });
  });

  it('resolves Unicode NFC-normalized match', () => {
    // cafe\u0301 (e + combining accent) should match café (precomposed)
    const result = resolveTarget(db, 'cafe\u0301');
    expect(result).toEqual({ id: 'n4', title: 'Café Notes' });
  });

  it('resolves ambiguous basename to shortest path', () => {
    const result = resolveTarget(db, 'Meeting');
    // Notes/Meeting.md is shorter than Archive/Old/Meeting.md
    expect(result).toEqual({ id: 'n6', title: 'Meeting' });
  });

  it('resolves by title when basename differs', () => {
    // n4 has file_path 'Notes/café.md' but title 'Café Notes'
    // 'Café Notes' doesn't match any basename, but matches the title
    const result = resolveTarget(db, 'Café Notes');
    expect(result).toEqual({ id: 'n4', title: 'Café Notes' });
  });

  it('returns null for unresolvable target', () => {
    const result = resolveTarget(db, 'Nonexistent Note');
    expect(result).toBeNull();
  });
});
