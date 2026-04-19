// src/pipeline/types.ts
//
// Types for the write pipeline (Section 5 of Phase 3 spec).

import type { ValidationResult, ValidationIssue } from '../validation/types.js';

export type { FileContext } from '../validation/resolve-default.js';

export interface ProposedMutation {
  source: 'tool' | 'watcher' | 'normalizer' | 'propagation' | 'undo';
  node_id: string | null;           // null for create-node
  file_path: string;                 // vault-relative path
  title: string;
  types: string[];
  fields: Record<string, unknown>;   // proposed field values
  body: string;
  raw_field_texts?: Record<string, string>;  // watcher path: pre-stripped text for wiki-link fields
  source_content_hash?: string;              // watcher path: SHA256 of file at parse time — stored as DB content_hash when file write is skipped
  db_only?: boolean;                         // when true, skip file write (watcher path)
}

/**
 * Caller-generated context signalling undo-snapshot capture.
 * Absent undoContext on an executeMutation/executeDeletion call
 * means no snapshot is written. Re-used across every pipeline call
 * a single user-intent tool issues.
 */
export interface UndoContext {
  operation_id: string;
}

export interface PipelineResult {
  node_id: string;
  file_path: string;
  validation: ValidationResult;
  rendered_hash: string;
  edits_logged: number;               // count of edits log entries created
  file_written: boolean;              // false if hash matched (no-op)
}

export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly validation?: ValidationResult,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}
