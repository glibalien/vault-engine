import type Database from 'better-sqlite3';
import { getSchema } from './loader.js';
import type { MergedField, MergeConflict, MergeResult, FieldDefinition } from './types.js';

function fieldToMerged(field: FieldDefinition, source: string): MergedField {
  const merged: MergedField = { type: field.type, sources: [source] };
  if (field.required) merged.required = true;
  if (field.default !== undefined) merged.default = field.default;
  if (field.values) merged.values = [...field.values];
  if (field.target_schema) merged.target_schema = field.target_schema;
  return merged;
}

export function mergeSchemaFields(db: Database.Database, types: string[]): MergeResult {
  if (types.length === 0) return { fields: {}, conflicts: [] };

  const conflicts: MergeConflict[] = [];
  const fields: Record<string, MergedField> = {};

  // Sort type names alphabetically for deterministic default resolution
  const sortedTypes = [...types].sort();

  for (const typeName of sortedTypes) {
    const schema = getSchema(db, typeName);
    if (!schema) {
      conflicts.push({
        field: '',
        definitions: [{ schema: typeName, type: 'string' }],
        message: `Unknown schema type '${typeName}'`,
      });
      continue;
    }

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      const existing = fields[fieldName];
      if (!existing) {
        fields[fieldName] = fieldToMerged(fieldDef, typeName);
        continue;
      }

      // Field exists — check compatibility
      const typesMatch = existing.type === fieldDef.type;
      const targetSchemaConflict =
        typesMatch &&
        (existing.type === 'reference' || existing.type === 'list<reference>') &&
        existing.target_schema !== undefined &&
        fieldDef.target_schema !== undefined &&
        existing.target_schema !== fieldDef.target_schema;

      if (!typesMatch || targetSchemaConflict) {
        // Incompatible — remove from fields, add conflict
        const existingDefs = existing.sources.map(s => ({
          schema: s,
          type: existing.type,
        }));
        conflicts.push({
          field: fieldName,
          definitions: [
            ...existingDefs,
            { schema: typeName, type: fieldDef.type },
          ],
          message: targetSchemaConflict
            ? `Field '${fieldName}' has conflicting target_schema: '${existing.target_schema}' vs '${fieldDef.target_schema}'`
            : `Field '${fieldName}' has incompatible types: '${existing.type}' (from ${existing.sources.join(', ')}) vs '${fieldDef.type}' (from ${typeName})`,
        });
        delete fields[fieldName];
        continue;
      }

      // Compatible — merge
      existing.sources.push(typeName);
      if (fieldDef.required) existing.required = true;
      // Default: first schema wins (alphabetical order). Deliberate choice —
      // alphabetical is arbitrary but deterministic. In inheritance, the child
      // already overrides via resolveInheritance. In multi-type merging there's
      // no inherent priority, so alphabetical is defensible.
      if (fieldDef.values) {
        const merged = new Set(existing.values ?? []);
        for (const v of fieldDef.values) merged.add(v);
        existing.values = [...merged];
      }
      if (existing.target_schema === undefined && fieldDef.target_schema) {
        existing.target_schema = fieldDef.target_schema;
      }
    }
  }

  return { fields, conflicts };
}
