import type Database from 'better-sqlite3';

export function createSchema(db: Database.Database): void {
  // db.exec is the better-sqlite3 method for running multi-statement SQL,
  // not child_process.exec — this is safe, no shell involved.
  const runSql = db.exec.bind(db);
  runSql(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      title TEXT,
      body TEXT,
      content_hash TEXT,
      file_mtime INTEGER,
      indexed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS node_types (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      schema_type TEXT NOT NULL,
      PRIMARY KEY (node_id, schema_type)
    );
    CREATE INDEX IF NOT EXISTS idx_node_types_schema_type ON node_types(schema_type);

    CREATE TABLE IF NOT EXISTS global_fields (
      name TEXT PRIMARY KEY,
      field_type TEXT NOT NULL,
      enum_values TEXT,
      reference_target TEXT,
      description TEXT,
      default_value TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      per_type_overrides_allowed INTEGER NOT NULL DEFAULT 0,
      list_item_type TEXT
    );

    CREATE TABLE IF NOT EXISTS schemas (
      name TEXT PRIMARY KEY,
      display_name TEXT,
      icon TEXT,
      filename_template TEXT,
      field_claims TEXT NOT NULL DEFAULT '[]',
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_field_claims (
      schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      field TEXT NOT NULL REFERENCES global_fields(name),
      label TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 1000,
      required INTEGER,
      default_value TEXT,
      PRIMARY KEY (schema_name, field)
    );
    CREATE INDEX IF NOT EXISTS idx_sfc_field ON schema_field_claims(field);

    CREATE TABLE IF NOT EXISTS node_fields (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_date TEXT,
      value_json TEXT,
      value_raw_text TEXT,
      source TEXT NOT NULL DEFAULT 'frontmatter',
      PRIMARY KEY (node_id, field_name)
    );
    CREATE INDEX IF NOT EXISTS idx_node_fields_field_name ON node_fields(field_name);
    CREATE INDEX IF NOT EXISTS idx_node_fields_value_number ON node_fields(value_number);
    CREATE INDEX IF NOT EXISTS idx_node_fields_value_date ON node_fields(value_date);

    -- Relationships store raw target strings (model A: query-time resolution).
    -- No resolved_target_id column — resolution happens at query time via
    -- src/resolver/resolve.ts. See that file for rationale and upgrade path.
    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      context TEXT,
      UNIQUE(source_id, target, rel_type)
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_source_id ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target);
    CREATE INDEX IF NOT EXISTS idx_relationships_rel_type ON relationships(rel_type);

    CREATE TABLE IF NOT EXISTS edits_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      content_text TEXT,
      embedded_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS schema_file_hashes (
      file_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      rendered_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      title,
      body,
      content='',
      contentless_delete=1
    );
  `);
}
