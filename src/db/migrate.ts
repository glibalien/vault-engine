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

export function upgradeToPhase6(db: Database.Database): void {
  const run = db.transaction(() => {
    const tables = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
      ).all() as { name: string }[]
    ).map(t => t.name);

    if (!tables.includes('extraction_cache')) {
      db.prepare(`
        CREATE TABLE extraction_cache (
          content_hash TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          media_type TEXT NOT NULL,
          extractor_id TEXT NOT NULL,
          extracted_text TEXT NOT NULL,
          metadata_json TEXT,
          extracted_at TEXT NOT NULL
        )
      `).run();
    }
  });
  run();
}

/**
 * Upgrade an existing database to Phase 4.
 *
 * Drops the old `embeddings` placeholder table, creates `embedding_meta` and
 * the `embedding_vec` virtual table. Idempotent — safe to run multiple times.
 *
 * NOTE: sqlite-vec must be loaded on `db` before calling this function.
 */
export function upgradeToPhase4(db: Database.Database): void {
  const run = db.transaction(() => {
    // Drop old placeholder table if it exists
    db.prepare('DROP TABLE IF EXISTS embeddings').run();

    // Create embedding_meta
    db.prepare(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        extraction_ref TEXT,
        embedded_at TEXT NOT NULL,
        UNIQUE(node_id, source_type, extraction_ref, chunk_index)
      )
    `).run();

    // Create index for embedding_meta
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_embedding_meta_node_id ON embedding_meta(node_id)'
    ).run();

    // Create embedding_vec virtual table (requires sqlite-vec loaded)
    const vecExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_vec'")
      .get();
    if (!vecExists) {
      db.prepare(`
        CREATE VIRTUAL TABLE embedding_vec USING vec0(
          id INTEGER PRIMARY KEY,
          vector float[256]
        )
      `).run();
    }
  });

  run();
}

export function addCreatedAt(db: Database.Database): void {
  const run = db.transaction(() => {
    const columns = (
      db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]
    ).map(c => c.name);

    if (!columns.includes('created_at')) {
      db.prepare('ALTER TABLE nodes ADD COLUMN created_at INTEGER').run();
      // Backfill: use indexed_at as best available proxy for creation time
      db.prepare('UPDATE nodes SET created_at = indexed_at WHERE created_at IS NULL AND indexed_at IS NOT NULL').run();
    }
  });

  run();
}

/**
 * Upgrade an existing database for per-type field overrides.
 *
 * global_fields: replaces single `per_type_overrides_allowed` with three
 * granular `overrides_allowed_*` columns.
 *
 * schema_field_claims: renames `required` → `required_override`,
 * `default_value` → `default_value_override`, adds `default_value_overridden`
 * and `enum_values_override`.
 *
 * Idempotent — safe to run on a database that already has the new schema.
 */
export function upgradeForOverrides(db: Database.Database): void {
  const run = db.transaction(() => {
    // --- global_fields: add granular override columns ---
    const gfColumns = (
      db.prepare('PRAGMA table_info(global_fields)').all() as { name: string }[]
    ).map(c => c.name);

    if (!gfColumns.includes('overrides_allowed_required')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN overrides_allowed_required INTEGER NOT NULL DEFAULT 0'
      ).run();
    }
    if (!gfColumns.includes('overrides_allowed_default_value')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN overrides_allowed_default_value INTEGER NOT NULL DEFAULT 0'
      ).run();
    }
    if (!gfColumns.includes('overrides_allowed_enum_values')) {
      db.prepare(
        'ALTER TABLE global_fields ADD COLUMN overrides_allowed_enum_values INTEGER NOT NULL DEFAULT 0'
      ).run();
    }

    // Migrate data from old per_type_overrides_allowed → new columns
    if (gfColumns.includes('per_type_overrides_allowed')) {
      db.prepare(`
        UPDATE global_fields
        SET overrides_allowed_required = per_type_overrides_allowed,
            overrides_allowed_default_value = per_type_overrides_allowed
        WHERE 1=1
      `).run();
      // Drop old column (SQLite 3.35.0+)
      db.prepare('ALTER TABLE global_fields DROP COLUMN per_type_overrides_allowed').run();
    }

    // --- schema_field_claims: rename + add columns ---
    const sfcColumns = (
      db.prepare('PRAGMA table_info(schema_field_claims)').all() as { name: string }[]
    ).map(c => c.name);

    // Rename required → required_override
    if (sfcColumns.includes('required') && !sfcColumns.includes('required_override')) {
      db.prepare(
        'ALTER TABLE schema_field_claims RENAME COLUMN required TO required_override'
      ).run();
    }

    // Rename default_value → default_value_override
    if (sfcColumns.includes('default_value') && !sfcColumns.includes('default_value_override')) {
      db.prepare(
        'ALTER TABLE schema_field_claims RENAME COLUMN default_value TO default_value_override'
      ).run();
    }

    // Add default_value_overridden
    // Re-read columns after renames
    const sfcColumnsAfter = (
      db.prepare('PRAGMA table_info(schema_field_claims)').all() as { name: string }[]
    ).map(c => c.name);

    if (!sfcColumnsAfter.includes('default_value_overridden')) {
      db.prepare(
        'ALTER TABLE schema_field_claims ADD COLUMN default_value_overridden INTEGER NOT NULL DEFAULT 0'
      ).run();
    }

    // Add enum_values_override
    if (!sfcColumnsAfter.includes('enum_values_override')) {
      db.prepare(
        'ALTER TABLE schema_field_claims ADD COLUMN enum_values_override TEXT'
      ).run();
    }

    // Backfill: mark default_value_overridden = 1 where default_value_override IS NOT NULL
    db.prepare(`
      UPDATE schema_field_claims
      SET default_value_overridden = 1
      WHERE default_value_override IS NOT NULL AND default_value_overridden = 0
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

/**
 * Migration: ensure `meta` table exists (added 2026-04-16 for search_version).
 *
 * Idempotent — safe to run on a database that already has the meta table.
 */
export function ensureMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Migration: add `resolved_target_id` column + supporting indexes to
 * `relationships` (added 2026-04-18 for cross-node query filtering).
 *
 * The column is populated at insert (indexer + pipeline) and maintained via
 * src/resolver/refresh.ts on node create/rename/delete. A separate one-shot
 * backfill walks all existing rows on first boot after upgrade.
 *
 * Idempotent — safe to run on a database that already has the new column.
 */
export function upgradeForResolvedTargetId(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    const hasCol = cols.some(c => c.name === 'resolved_target_id');
    if (!hasCol) {
      db.prepare(
        'ALTER TABLE relationships ADD COLUMN resolved_target_id TEXT REFERENCES nodes(id) ON DELETE SET NULL'
      ).run();
    }
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_relationships_resolved_target_id ON relationships(resolved_target_id)'
    ).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_relationships_source_resolved ON relationships(source_id, resolved_target_id)'
    ).run();
  });
  run();
}
