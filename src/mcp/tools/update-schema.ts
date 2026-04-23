import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { updateSchemaDefinition } from '../../schema/crud.js';
import { propagateSchemaChange } from '../../schema/propagate.js';
import { renderSchemaFile } from '../../schema/render.js';
import { previewSchemaChange } from '../../schema/preview.js';
import { SchemaValidationError } from '../../schema/errors.js';
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

      // Preview first — no operation created, no side effects.
      let preview;
      try {
        preview = previewSchemaChange(db, writeLock, vaultPath, name, rest);
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

      // Live-commit path. (B3 undo threading lands here in Task 8.)
      try {
        const result = updateSchemaDefinition(db, name, rest);

        let propagation;
        if (rest.field_claims) {
          // Reuse the diff computed by the preview — preview ran against the
          // same pre-update state as our commit path.
          const preDiff = {
            added: preview.claims_added,
            removed: preview.claims_removed,
            changed: preview.claims_modified,
          };
          propagation = propagateSchemaChange(db, writeLock, vaultPath, name, preDiff, ctx.syncLogger);
        }

        renderSchemaFile(db, vaultPath, name);
        return ok({ ...result, propagation });
      } catch (err) {
        if (err instanceof SchemaValidationError) {
          return fail('VALIDATION_FAILED', err.message, { details: { groups: err.groups } });
        }
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
