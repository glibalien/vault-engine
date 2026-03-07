// src/schema/loader.ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type Database from 'better-sqlite3';
import type { SchemaDefinition, ResolvedSchema } from './types.js';

function readSchemaFiles(schemasDir: string): SchemaDefinition[] {
  if (!existsSync(schemasDir)) return [];

  const files = readdirSync(schemasDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const schemas: SchemaDefinition[] = [];

  for (const file of files) {
    const absPath = join(schemasDir, file);
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseYaml(raw);

    if (!parsed || typeof parsed.name !== 'string') {
      throw new Error(`Schema file '${absPath}' is missing required 'name' field`);
    }

    schemas.push({
      name: parsed.name,
      display_name: parsed.display_name,
      icon: parsed.icon,
      extends: parsed.extends,
      fields: parsed.fields ?? {},
      serialization: parsed.serialization,
      computed: parsed.computed,
    });
  }

  return schemas;
}

function resolveInheritance(schemas: SchemaDefinition[]): ResolvedSchema[] {
  const byName = new Map<string, SchemaDefinition>();
  for (const s of schemas) {
    byName.set(s.name, s);
  }

  // Topological sort with cycle detection
  const resolved = new Map<string, ResolvedSchema>();
  const visiting = new Set<string>();

  function resolve(name: string, chain: string[]): ResolvedSchema {
    const existing = resolved.get(name);
    if (existing) return existing;

    if (visiting.has(name)) {
      throw new Error(`Schema inheritance cycle: ${[...chain, name].join(' -> ')}`);
    }

    const def = byName.get(name);
    if (!def) {
      throw new Error(`Schema '${chain[chain.length - 1]}' extends unknown schema '${name}'`);
    }

    visiting.add(name);

    let ancestors: string[] = [];
    let inheritedFields: Record<string, typeof def.fields[string]> = {};

    if (def.extends) {
      const parent = resolve(def.extends, [...chain, name]);
      ancestors = [...parent.ancestors, parent.name];
      inheritedFields = { ...parent.fields };
    }

    const result: ResolvedSchema = {
      name: def.name,
      display_name: def.display_name,
      icon: def.icon,
      extends: def.extends,
      ancestors,
      fields: { ...inheritedFields, ...def.fields },
      serialization: def.serialization,
      computed: def.computed,
    };

    visiting.delete(name);
    resolved.set(name, result);
    return result;
  }

  for (const name of byName.keys()) {
    resolve(name, []);
  }

  return [...resolved.values()];
}

export function loadSchemas(db: Database.Database, vaultPath: string): void {
  const schemasDir = join(vaultPath, '.schemas');
  const definitions = readSchemaFiles(schemasDir);
  const resolvedSchemas = resolveInheritance(definitions);

  const run = db.transaction(() => {
    db.prepare('DELETE FROM schemas').run();

    const insert = db.prepare(
      'INSERT INTO schemas (name, definition, file_path) VALUES (?, ?, ?)'
    );
    for (const schema of resolvedSchemas) {
      insert.run(
        schema.name,
        JSON.stringify(schema),
        join('.schemas', `${schema.name}.yaml`),
      );
    }
  });

  run();
}

export function getSchema(db: Database.Database, name: string): ResolvedSchema | null {
  const row = db.prepare('SELECT definition FROM schemas WHERE name = ?').get(name) as
    | { definition: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.definition) as ResolvedSchema;
}

export function getAllSchemas(db: Database.Database): ResolvedSchema[] {
  const rows = db.prepare('SELECT definition FROM schemas ORDER BY name').all() as
    Array<{ definition: string }>;
  return rows.map(r => JSON.parse(r.definition) as ResolvedSchema);
}
