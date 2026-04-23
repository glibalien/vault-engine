// src/undo/types.ts
//
// Types shared between the undo module, pipeline integration, and MCP tools.

export interface UndoOperationRow {
  operation_id: string;
  timestamp: number;
  source_tool: string;
  description: string;
  node_count: number;
  schema_count: number;
  status: 'active' | 'undone' | 'expired';
}

export interface UndoSnapshotRow {
  operation_id: string;
  node_id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  types: string | null;                 // JSON array
  fields: string | null;                // JSON object
  relationships: string | null;         // JSON array
  was_deleted: 0 | 1;
  post_mutation_hash: string | null;
}

export type ConflictReason =
  | 'path_occupied'
  | 'modified_after_operation'
  | 'superseded_by_later_op';

export interface Conflict {
  operation_id: string;
  node_id: string;
  file_path: string;
  reason: ConflictReason;
  modified_by?: string[];             // e.g., ["update-node at 2026-04-19T14:30:00Z"]
  current_summary: Record<string, unknown>;
  would_restore_summary: Record<string, unknown>;
}

export interface RestoreResult {
  operations: Array<{
    operation_id: string;
    node_count: number;
    status: 'would_undo' | 'undone';
  }>;
  conflicts: Conflict[];
  total_undone: number;
  total_conflicts: number;
  total_skipped: number;
}
