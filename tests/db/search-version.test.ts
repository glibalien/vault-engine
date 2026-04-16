import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import {
  CURRENT_SEARCH_VERSION,
  getSearchVersion,
  setSearchVersion,
} from '../../src/db/search-version.js';

describe('search-version', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns 1 when no version is stored (implicit baseline)', () => {
    expect(getSearchVersion(db)).toBe(1);
  });

  it('persists a version and reads it back', () => {
    setSearchVersion(db, 2);
    expect(getSearchVersion(db)).toBe(2);
  });

  it('overwrites on repeat set', () => {
    setSearchVersion(db, 2);
    setSearchVersion(db, 5);
    expect(getSearchVersion(db)).toBe(5);
  });

  it('exposes CURRENT_SEARCH_VERSION >= 2', () => {
    expect(CURRENT_SEARCH_VERSION).toBeGreaterThanOrEqual(2);
  });
});
