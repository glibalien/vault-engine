import type { ParsedFile } from '../parser/types.js';
import type { MergeResult, ValidationResult, ValidationWarning } from './types.js';

const WIKI_LINK_RE = /^\[\[[^\]]+\]\]$/;

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

  // Check enum values
  for (const [name, schemaDef] of Object.entries(mergeResult.fields)) {
    if (schemaDef.type !== 'enum' || !schemaDef.values) continue;
    const parsedField = fieldsByKey.get(name);
    if (!parsedField) continue;
    if (parsedField.valueType !== 'string') continue;

    if (!schemaDef.values.includes(String(parsedField.value))) {
      warnings.push({
        field: name,
        rule: 'invalid_enum',
        message: `Field '${name}' has value '${parsedField.value}' which is not in [${schemaDef.values.join(', ')}]`,
      });
    }
  }

  // Check reference syntax
  for (const [name, schemaDef] of Object.entries(mergeResult.fields)) {
    const parsedField = fieldsByKey.get(name);
    if (!parsedField) continue;

    if (schemaDef.type === 'reference') {
      if (typeof parsedField.value === 'string' && !WIKI_LINK_RE.test(parsedField.value)) {
        warnings.push({
          field: name,
          rule: 'invalid_reference',
          message: `Field '${name}' should be a wiki-link ([[target]]) but got '${parsedField.value}'`,
        });
      }
    } else if (schemaDef.type === 'list<reference>' && Array.isArray(parsedField.value)) {
      const invalid = parsedField.value.filter(
        (item): item is string => typeof item === 'string' && !WIKI_LINK_RE.test(item),
      );
      if (invalid.length > 0) {
        warnings.push({
          field: name,
          rule: 'invalid_reference',
          message: `Field '${name}' contains non-wiki-link values: ${invalid.join(', ')}`,
        });
      }
    }
  }

  return { valid: warnings.length === 0, warnings };
}
