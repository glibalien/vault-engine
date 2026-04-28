export { executeMutation } from './execute.js';
export { hasBlockingErrors } from './errors.js';
export { classifyValue, reconstructValue } from './classify-value.js';
export { loadSchemaContext } from './schema-context.js';
export { atomicWriteFile, backupFile, restoreFile, cleanupBackups, readFileOrNull } from './file-writer.js';
export { deriveRelationships } from './relationships.js';
export { buildDeviationEntries, writeEditsLogEntries } from './edits-log.js';
export type { ProposedMutation, PipelineResult, PipelineError } from './types.js';
export type { SchemaContext } from './schema-context.js';
