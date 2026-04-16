import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { getGlobalField } from '../../global-fields/crud.js';
import { validateProposedState } from '../../validation/validate.js';
import type { FieldClaim, GlobalFieldDefinition } from '../../validation/types.js';

export function registerValidateNode(server: McpServer, db: Database.Database): void {
  server.tool(
    'validate-node',
    'Validates a node against its schemas. Provide node_id to validate an existing node, or proposed to validate hypothetical state.',
    {
      node_id: z.string().optional().describe('Existing node ID to validate'),
      proposed: z.object({
        types: z.array(z.string()),
        fields: z.record(z.string(), z.unknown()),
      }).optional().describe('Hypothetical state: types and fields to validate'),
    },
    async (params) => {
      try {
        const { node_id, proposed } = params;

        // Exactly one of node_id or proposed required
        if (!node_id && !proposed) {
          return toolErrorResult('INVALID_PARAMS', 'Exactly one of node_id or proposed is required');
        }
        if (node_id && proposed) {
          return toolErrorResult('INVALID_PARAMS', 'Exactly one of node_id or proposed is required');
        }

        let types: string[];
        let fields: Record<string, unknown>;

        if (node_id) {
          // Load node types
          const typeRows = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
            .all(node_id) as Array<{ schema_type: string }>;
          types = typeRows.map(r => r.schema_type);

          // Load node fields
          interface FieldRow {
            field_name: string;
            value_text: string | null;
            value_number: number | null;
            value_date: string | null;
            value_json: string | null;
          }
          const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
            .all(node_id) as FieldRow[];

          fields = {};
          for (const row of fieldRows) {
            if (row.value_json !== null) {
              fields[row.field_name] = JSON.parse(row.value_json);
            } else if (row.value_number !== null) {
              fields[row.field_name] = row.value_number;
            } else if (row.value_date !== null) {
              fields[row.field_name] = row.value_date;
            } else {
              fields[row.field_name] = row.value_text;
            }
          }
        } else {
          types = proposed!.types;
          fields = proposed!.fields;
        }

        // Load claims by type
        const claimsByType = new Map<string, FieldClaim[]>();
        for (const typeName of types) {
          const rows = db.prepare('SELECT * FROM schema_field_claims WHERE schema_name = ?').all(typeName) as Array<{
            schema_name: string;
            field: string;
            label: string | null;
            description: string | null;
            sort_order: number | null;
            required_override: number | null;
            default_value_override: string | null;
            default_value_overridden: number;
            enum_values_override: string | null;
          }>;
          if (rows.length > 0) {
            claimsByType.set(typeName, rows.map(r => ({
              schema_name: r.schema_name,
              field: r.field,
              label: r.label,
              description: r.description,
              sort_order: r.sort_order ?? 1000,
              required_override: r.required_override !== null ? r.required_override === 1 : null,
              default_value_override: r.default_value_overridden === 1
                ? { kind: 'override' as const, value: r.default_value_override !== null ? JSON.parse(r.default_value_override) : null }
                : { kind: 'inherit' as const },
              enum_values_override: r.enum_values_override !== null ? JSON.parse(r.enum_values_override) : null,
            })));
          }
        }

        // Load all referenced global fields
        const globalFields = new Map<string, GlobalFieldDefinition>();
        const allFieldNames = new Set<string>();
        for (const claims of claimsByType.values()) {
          for (const c of claims) allFieldNames.add(c.field);
        }
        for (const name of allFieldNames) {
          const gf = getGlobalField(db, name);
          if (gf) globalFields.set(name, gf);
        }

        // Run validation
        const result = validateProposedState(fields, types, claimsByType, globalFields);

        // Check which types have no schema row
        const typesWithoutSchemas: string[] = [];
        for (const typeName of types) {
          const schemaRow = db.prepare('SELECT name FROM schemas WHERE name = ?').get(typeName);
          if (!schemaRow) {
            typesWithoutSchemas.push(typeName);
          }
        }

        // Convert EffectiveFieldSet (Map) to plain object
        const effectiveFieldsObj: Record<string, unknown> = {};
        for (const [key, ef] of result.effective_fields) {
          effectiveFieldsObj[key] = {
            field: ef.field,
            global_field: ef.global_field,
            resolved_label: ef.resolved_label,
            resolved_description: ef.resolved_description,
            resolved_order: ef.resolved_order,
            resolved_required: ef.resolved_required,
            resolved_default_value: ef.resolved_default_value,
            claiming_types: ef.claiming_types,
          };
        }

        return toolResult({
          valid: result.valid,
          effective_fields: effectiveFieldsObj,
          coerced_state: result.coerced_state,
          issues: result.issues,
          orphan_fields: result.orphan_fields,
          types_without_schemas: typesWithoutSchemas,
        });
      } catch (err) {
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
