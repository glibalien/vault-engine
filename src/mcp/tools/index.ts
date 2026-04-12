import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { registerVaultStats } from './vault-stats.js';
import { registerListTypes } from './list-types.js';
import { registerListSchemas } from './list-schemas.js';
import { registerDescribeSchema } from './describe-schema.js';
import { registerListGlobalFields } from './list-global-fields.js';
import { registerDescribeGlobalField } from './describe-global-field.js';
import { registerQueryNodes } from './query-nodes.js';
import { registerGetNode } from './get-node.js';
import { registerCreateGlobalField } from './create-global-field.js';
import { registerUpdateGlobalField } from './update-global-field.js';
import { registerRenameGlobalField } from './rename-global-field.js';
import { registerDeleteGlobalField } from './delete-global-field.js';
import { registerCreateSchema } from './create-schema.js';
import { registerUpdateSchema } from './update-schema.js';
import { registerDeleteSchema } from './delete-schema.js';
import { registerValidateNode } from './validate-node.js';
import { registerInferFieldType } from './infer-field-type.js';
import { registerListFieldValues } from './list-field-values.js';
import { registerCreateNode } from './create-node.js';
import { registerUpdateNode } from './update-node.js';
import { registerDeleteNode } from './delete-node.js';
import { registerAddTypeToNode } from './add-type-to-node.js';
import { registerRemoveTypeFromNode } from './remove-type-from-node.js';
import { registerRenameNode } from './rename-node.js';
import { registerBatchMutate } from './batch-mutate.js';

export function registerAllTools(server: McpServer, db: Database.Database, ctx?: { writeLock?: import('../../sync/write-lock.js').WriteLockManager; writeGate?: import('../../sync/write-gate.js').WriteGate; vaultPath?: string; extractionCache?: import('../../extraction/cache.js').ExtractionCache }): void {
  registerVaultStats(server, db);
  registerListTypes(server, db);
  registerListSchemas(server, db);
  registerDescribeSchema(server, db);
  registerListGlobalFields(server, db);
  registerDescribeGlobalField(server, db);
  registerQueryNodes(server, db);
  registerGetNode(server, db, ctx?.extractionCache, ctx?.vaultPath);
  registerCreateGlobalField(server, db, ctx);
  registerUpdateGlobalField(server, db, ctx);
  registerRenameGlobalField(server, db, ctx);
  registerDeleteGlobalField(server, db, ctx);
  registerCreateSchema(server, db, ctx);
  registerUpdateSchema(server, db, ctx);
  registerDeleteSchema(server, db, ctx);
  registerValidateNode(server, db);
  registerInferFieldType(server, db);
  registerListFieldValues(server, db);

  // Phase 3 mutation tools (require writeLock and vaultPath)
  if (ctx?.writeLock && ctx?.vaultPath) {
    registerCreateNode(server, db, ctx.writeLock, ctx.vaultPath);
    registerUpdateNode(server, db, ctx.writeLock, ctx.vaultPath);
    registerDeleteNode(server, db, ctx.writeLock, ctx.vaultPath);
    registerAddTypeToNode(server, db, ctx.writeLock, ctx.vaultPath);
    registerRemoveTypeFromNode(server, db, ctx.writeLock, ctx.vaultPath);
    registerRenameNode(server, db, ctx.writeLock, ctx.vaultPath);
    registerBatchMutate(server, db, ctx.writeLock, ctx.vaultPath);
  }
}
