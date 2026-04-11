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

export function registerAllTools(server: McpServer, db: Database.Database): void {
  registerVaultStats(server, db);
  registerListTypes(server, db);
  registerListSchemas(server, db);
  registerDescribeSchema(server, db);
  registerListGlobalFields(server, db);
  registerDescribeGlobalField(server, db);
  registerQueryNodes(server, db);
  registerGetNode(server, db);
}
