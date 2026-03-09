import type { ParsedFile } from '../parser/types.js';
import type { MergeResult, ValidationResult, ValidationWarning } from './types.js';

const TYPE_COMPAT: Record<string, Set<string>> = {
  string: new Set(['string']),
  number: new Set(['number']),
  date: new Set(['date']),
  boolean: new Set(['boolean']),
  enum: new Set(['string']),
  reference: new Set(['reference']),
  'list<string>': new Set(['list']),
  'list<reference>': new Set(['list']),
};

export function validateNode(parsed: ParsedFile, mergeResult: MergeResult): ValidationResult {
  const warnings: ValidationWarning[] = [];
  const presentKeys = new Set(parsed.fields.map(f => f.key));

  // Check required fields
  for (const [name, field] of Object.entries(mergeResult.fields)) {
    if (field.required && !presentKeys.has(name)) {
      warnings.push({
        field: name,
        rule: 'required',
        message: `Required field '${name}' is missing`,
      });
    }
  }

  // Check type compatibility
  const fieldsByKey = new Map(parsed.fields.map(f => [f.key, f]));
  for (const [name, schemaDef] of Object.entries(mergeResult.fields)) {
    const parsedField = fieldsByKey.get(name);
    if (!parsedField) continue;

    const allowed = TYPE_COMPAT[schemaDef.type];
    if (allowed && !allowed.has(parsedField.valueType)) {
      warnings.push({
        field: name,
        rule: 'type_mismatch',
        message: `Field '${name}' expected type '${schemaDef.type}' but got '${parsedField.valueType}'`,
      });
    }
  }

  return { valid: warnings.length === 0, warnings };
}
