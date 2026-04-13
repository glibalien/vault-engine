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
import { registerReadEmbedded } from './read-embedded.js';
import { registerQuerySyncLog } from './query-sync-log.js';

export function registerAllTools(server: McpServer, db: Database.Database, ctx?: { writeLock?: import('../../sync/write-lock.js').WriteLockManager; writeGate?: import('../../sync/write-gate.js').WriteGate; syncLogger?: import('../../sync/sync-logger.js').SyncLogger; vaultPath?: string; extractionCache?: import('../../extraction/cache.js').ExtractionCache; extractorRegistry?: import('../../extraction/registry.js').ExtractorRegistry; embeddingIndexer?: import('../../search/indexer.js').EmbeddingIndexer; embedder?: import('../../search/embedder.js').Embedder }): void {
  registerVaultStats(server, db, ctx?.extractorRegistry, ctx?.embeddingIndexer);
  registerListTypes(server, db);
  registerListSchemas(server, db);
  registerDescribeSchema(server, db);
  registerListGlobalFields(server, db);
  registerDescribeGlobalField(server, db);
  registerQueryNodes(server, db, ctx?.embeddingIndexer, ctx?.embedder);
  registerQuerySyncLog(server, db);
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

  // Phase 6 extraction tools (require extractionCache and vaultPath)
  if (ctx?.extractionCache && ctx?.vaultPath) {
    registerReadEmbedded(server, db, ctx.extractionCache, ctx.vaultPath);
  }

  // Phase 3 mutation tools (require writeLock and vaultPath)
  if (ctx?.writeLock && ctx?.vaultPath) {
    registerCreateNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerUpdateNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerDeleteNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerAddTypeToNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerRemoveTypeFromNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerRenameNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerBatchMutate(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
  }
}
