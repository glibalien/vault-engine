import type Database from 'better-sqlite3';

/**
 * Upgrade an existing Phase 1 database to Phase 2.
 *
 * Safe to run on a database that already has the Phase 2 schema — all
 * operations are guarded by existence checks so the function is idempotent.
 */
/**
 * Upgrade an existing Phase 2 database to Phase 3.
 *
 * Adds: node_fields.value_raw_text column, schema_file_hashes table.
 * Idempotent — safe to run on a database that already has the Phase 3 schema.
 */
export function upgradeToPhase3(db: Database.Database): void {
  const run = db.transaction(() => {
    // --- node_fields: add value_raw_text column if missing ---
    const nfColumns = (
      db.prepare('PRAGMA table_info(node_fields)').all() as { name: string }[]
    ).map(c => c.name);

    if (!nfColumns.includes('value_raw_text')) {
      db.prepare(
        'ALTER TABLE node_fields ADD COLUMN value_raw_text TEXT'
      ).run();
    }

    // --- schema_file_hashes table ---
    db.prepare(`
      CREATE TABLE IF NOT EXISTS schema_file_hashes (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        rendered_at INTEGER NOT NULL
      )
    `).run();
  });

  run();
}

export function upgradeToPhase2(db: Database.Database): void {
  const run = db.transaction(() => {
    // --- global_fields: add three new columns if missing ---
    const gfColumns = (
      db.prepare('PRAGMA table_info(global_fields)').all() as { name: string }[]
    ).map(c => c.name);

    if (!gfColumns.includes('required')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN required INTEGER NOT NULL DEFAULT 0'
      ).run();
    }
    if (!gfColumns.includes('per_type_overrides_allowed')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN per_type_overrides_allowed INTEGER NOT NULL DEFAULT 0'
      ).run();
    }
    if (!gfColumns.includes('list_item_type')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN list_item_type TEXT'
      ).run();
    }

    // --- schema_field_claims table ---
    const tables = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_field_claims'"
      ).all() as { name: string }[]
    ).map(t => t.name);

    if (!tables.includes('schema_field_claims')) {
      db.prepare(`
        CREATE TABLE schema_field_claims (
          schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
          field TEXT NOT NULL REFERENCES global_fields(name),
          label TEXT,
          description TEXT,
          sort_order INTEGER DEFAULT 1000,
          required INTEGER,
          default_value TEXT,
          PRIMARY KEY (schema_name, field)
        )
      `).run();
    }

    // --- idx_sfc_field index ---
    const indexes = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sfc_field'"
      ).all() as { name: string }[]
    ).map(i => i.name);

    if (!indexes.includes('idx_sfc_field')) {
      db.prepare(
        'CREATE INDEX idx_sfc_field ON schema_field_claims(field)'
      ).run();
    }
  });

  run();
}
