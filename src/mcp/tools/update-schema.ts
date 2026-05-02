import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { updateSchemaDefinition, type ClaimInput } from '../../schema/crud.js';
import { propagateSchemaChange } from '../../schema/propagate.js';
import { renderSchemaFile } from '../../schema/render.js';
import { previewSchemaChange } from '../../schema/preview.js';
import { readCurrentClaims } from '../../schema/claims.js';
import { SchemaValidationError } from '../../schema/errors.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureSchemaSnapshot } from '../../undo/schema-snapshot.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
  default_value_overridden: z.boolean().optional().describe('Set true when default_value key is present, even if null'),
  enum_values_override: z.array(z.string()).optional().describe('Per-type enum values (replaces global for this type)'),
});

const TOOL_DESC =
  'Updates an existing schema definition. If field_claims is provided, it replaces all existing claims. ' +
  'Alternatively, use add_field_claims, update_field_claims, and remove_field_claims for patch-style claim edits. ' +
  'When dry_run=true, returns a preview (claim diff, orphan counts, propagation numbers) without committing — ' +
  'a response with ok:false on a dry-run means the change WOULD BE REJECTED if committed, not that the dry-run itself failed; ' +
  'preview data is then in error.details alongside groups. ' +
  'When a non-dry-run commit would orphan any field value(s), the response is ok:false with error.code CONFIRMATION_REQUIRED; ' +
  're-call with confirm_large_change:true to proceed.';

export function registerUpdateSchema(
  server: McpServer,
  db: Database.Database,
  ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger },
): void {
  server.tool(
    'update-schema',
    TOOL_DESC,
    {
      name: z.string().describe('Schema name to update'),
      display_name: z.string().optional().describe('New display name'),
      icon: z.string().optional().describe('New icon identifier'),
      filename_template: z.string().optional().describe('New filename template (name only, e.g. "{date} - {title}.md")'),
      default_directory: z.string().optional().describe('New default directory for files of this type'),
      field_claims: z.array(fieldClaimSchema).optional().describe('New field claims (replaces existing)'),
      add_field_claims: z.array(fieldClaimSchema).optional().describe('Field claims to add without replacing existing claims'),
      update_field_claims: z.array(fieldClaimSchema).optional().describe('Existing field claims to patch by field name without changing other claims'),
      remove_field_claims: z.array(z.string()).optional().describe('Field names to remove from this schema without replacing other claims'),
      metadata: z.unknown().optional().describe('New metadata'),
      dry_run: z.boolean().optional().describe('Preview the effect without committing'),
      confirm_large_change: z.boolean().optional().describe('Acknowledge the change would orphan field values. Required when propagation would orphan any field.'),
    },
    async ({ name, dry_run, confirm_large_change, ...rest }) => {
      if (!ctx?.writeLock || !ctx?.vaultPath) {
        return fail('INTERNAL_ERROR', 'update-schema requires write context (writeLock + vaultPath).');
      }
      const writeLock = ctx.writeLock;
      const vaultPath = ctx.vaultPath;

      let normalizedRest;
      try {
        normalizedRest = normalizeSchemaUpdate(db, name, rest);
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }

      // Preview first — no operation created, no side effects.
      let preview;
      try {
        preview = previewSchemaChange(db, writeLock, vaultPath, name, normalizedRest);
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }

      if (!preview.ok) {
        return fail(
          'VALIDATION_FAILED',
          `Schema change rejected: ${preview.groups.length} validation group(s).`,
          { details: {
              groups: preview.groups,
              claims_added: preview.claims_added,
              claims_removed: preview.claims_removed,
              claims_modified: preview.claims_modified,
              orphaned_field_names: preview.orphaned_field_names,
              propagation: preview.propagation,
            } },
        );
      }

      if (dry_run) {
        return ok({
          would_commit: true,
          claims_added: preview.claims_added,
          claims_removed: preview.claims_removed,
          claims_modified: preview.claims_modified,
          orphaned_field_names: preview.orphaned_field_names,
          propagation: preview.propagation,
        });
      }

      // Confirm gate: once we're past the dry_run early-return, any orphan-producing
      // commit must set confirm_large_change:true. Dry-runs stay gate-free by design
      // (return above runs first on dry_run: true).
      if (preview.propagation.fields_orphaned > 0 && !confirm_large_change) {
        const fieldCount = preview.orphaned_field_names.length;
        return fail(
          'CONFIRMATION_REQUIRED',
          `This change would orphan ${preview.propagation.fields_orphaned} field value(s) across ${fieldCount} field(s). Set confirm_large_change: true to proceed, or run with dry_run: true to preview.`,
          { details: {
              orphaned_field_names: preview.orphaned_field_names,
              propagation: preview.propagation,
              claims_removed: preview.claims_removed,
            } },
        );
      }

      // Live-commit path.
      const operation_id = createOperation(db, {
        source_tool: 'update-schema',
        description: buildDescription(name, normalizedRest, preview),
      });

      let finalResult: ReturnType<typeof updateSchemaDefinition> | undefined;
      let propagation: ReturnType<typeof propagateSchemaChange> | undefined;
      try {
        const tx = db.transaction(() => {
          captureSchemaSnapshot(db, operation_id, name);
          finalResult = updateSchemaDefinition(db, name, normalizedRest);
          if (normalizedRest.field_claims) {
            const preDiff = {
              added: preview.claims_added,
              removed: preview.claims_removed,
              changed: preview.claims_modified,
            };
            propagation = propagateSchemaChange(
              db, writeLock, vaultPath, name, preDiff, ctx.syncLogger,
              { operation_id },
            );
          }
        });
        tx();

        db.prepare(
          'UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?',
        ).run(operation_id);

        renderSchemaFile(db, vaultPath, name);
        return ok({ ...finalResult!, propagation, operation_id });
      } catch (err) {
        if (err instanceof SchemaValidationError) {
          return fail('VALIDATION_FAILED', err.message, { details: { groups: err.groups } });
        }
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}

type RawUpdateRest = {
  display_name?: string;
  icon?: string;
  filename_template?: string;
  default_directory?: string;
  field_claims?: z.infer<typeof fieldClaimSchema>[];
  add_field_claims?: z.infer<typeof fieldClaimSchema>[];
  update_field_claims?: z.infer<typeof fieldClaimSchema>[];
  remove_field_claims?: string[];
  metadata?: unknown;
};

type NormalizedUpdateRest = {
  display_name?: string;
  icon?: string;
  filename_template?: string;
  default_directory?: string;
  field_claims?: z.infer<typeof fieldClaimSchema>[];
  metadata?: unknown;
};

function normalizeSchemaUpdate(
  db: Database.Database,
  name: string,
  rest: RawUpdateRest,
): NormalizedUpdateRest {
  const {
    add_field_claims,
    update_field_claims,
    remove_field_claims,
    ...base
  } = rest;

  const hasPatchOps =
    add_field_claims !== undefined ||
    update_field_claims !== undefined ||
    remove_field_claims !== undefined;

  if (base.field_claims !== undefined && hasPatchOps) {
    throw new Error('field_claims replaces all claims and cannot be combined with add_field_claims, update_field_claims, or remove_field_claims.');
  }

  if (!hasPatchOps) return base;

  const existing: ClaimInput[] = readCurrentClaims(db, name).map(claim => ({
    field: claim.field,
    sort_order: claim.sort_order,
    label: claim.label,
    description: claim.description,
    required: claim.required ?? undefined,
    default_value: claim.default_value,
    default_value_overridden: claim.default_value !== undefined,
    enum_values_override: claim.enum_values_override ?? undefined,
  }));

  const claimsByField = new Map(existing.map(claim => [claim.field, claim]));

  for (const claim of add_field_claims ?? []) {
    if (claimsByField.has(claim.field)) {
      throw new Error(`Cannot add claim '${claim.field}' because schema '${name}' already claims it. Use update_field_claims to modify it.`);
    }
    claimsByField.set(claim.field, claim);
  }

  for (const claim of update_field_claims ?? []) {
    const current = claimsByField.get(claim.field);
    if (!current) {
      throw new Error(`Cannot update claim '${claim.field}' because schema '${name}' does not claim it. Use add_field_claims to add it.`);
    }
    const merged: ClaimInput = {
      ...current,
      ...claim,
      default_value_overridden: claim.default_value !== undefined
        ? true
        : claim.default_value_overridden ?? current.default_value_overridden,
    };
    claimsByField.set(claim.field, merged);
  }

  for (const field of remove_field_claims ?? []) {
    if (!claimsByField.has(field)) {
      throw new Error(`Cannot remove claim '${field}' because schema '${name}' does not claim it.`);
    }
    claimsByField.delete(field);
  }

  return {
    ...base,
    field_claims: Array.from(claimsByField.values()),
  };
}

function buildDescription(
  name: string,
  rest: { field_claims?: unknown },
  preview: { claims_added: string[]; claims_removed: string[]; claims_modified: string[] },
): string {
  if (!rest.field_claims) return `update-schema: ${name}`;
  const a = preview.claims_added.length;
  const r = preview.claims_removed.length;
  const m = preview.claims_modified.length;
  return `update-schema: ${name} (+${a}/-${r}/~${m} claims)`;
}
