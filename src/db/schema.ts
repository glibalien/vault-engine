import type Database from 'better-sqlite3';

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id              TEXT PRIMARY KEY,
      file_path       TEXT NOT NULL,
      node_type       TEXT NOT NULL,
      parent_id       TEXT,
      position_start  INTEGER,
      position_end    INTEGER,
      depth           INTEGER DEFAULT 0,
      content_text    TEXT,
      content_md      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS node_types (
      node_id         TEXT NOT NULL,
      schema_type     TEXT NOT NULL,
      PRIMARY KEY (node_id, schema_type),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      content_text,
      content='nodes',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS fields (
      node_id         TEXT NOT NULL,
      key             TEXT NOT NULL,
      value_text      TEXT,
      value_type      TEXT NOT NULL,
      value_number    REAL,
      value_date      TEXT,
      PRIMARY KEY (node_id, key),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id       TEXT NOT NULL,
      target_id       TEXT NOT NULL,
      rel_type        TEXT NOT NULL,
      context         TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schemas (
      name            TEXT PRIMARY KEY,
      definition      TEXT NOT NULL,
      file_path       TEXT,
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS files (
      path            TEXT PRIMARY KEY,
      mtime           TEXT NOT NULL,
      hash            TEXT NOT NULL,
      indexed_at      TEXT DEFAULT (datetime('now'))
    );

    -- Indices
    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_node_types_schema ON node_types(schema_type);
    CREATE INDEX IF NOT EXISTS idx_fields_key_value ON fields(key, value_text);
    CREATE INDEX IF NOT EXISTS idx_fields_key_number ON fields(key, value_number);
    CREATE INDEX IF NOT EXISTS idx_fields_key_date ON fields(key, value_date);
    CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);
    CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(rel_type);

    -- FTS5 sync triggers
    CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
      INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
    END;
  `);
}
