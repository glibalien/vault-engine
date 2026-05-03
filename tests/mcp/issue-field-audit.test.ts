import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';

/**
 * Audit test for the §2.5 Issue.field contract.
 *
 * The contract from the spec
 * (docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md):
 *
 *   - Per-field IssueCodes MUST set issue.field.
 *   - Non-per-field IssueCodes MUST leave issue.field unset.
 *
 * `ValidationIssue.field` is required by type, so the validation path is
 * covered by typecheck. This test focuses on direct Issue constructions
 * inside tool handlers — currently FIELD_OPERATOR_MISMATCH is the only
 * per-field direct-construction code.
 */

type EnvelopeWarning = { code: string; field?: string };

function captureHandler(db: ReturnType<typeof createTestDb>) {
  let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
      capturedHandler = h as typeof capturedHandler;
    },
    registerTool: (_name: string, _config: unknown, h: (...args: unknown[]) => unknown) => {
      capturedHandler = h as typeof capturedHandler;
    },
  } as unknown as McpServer;
  registerQueryNodes(fakeServer, db);
  return capturedHandler!;
}

function parseEnvelope(result: unknown): { ok: boolean; warnings: EnvelopeWarning[] } {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as { ok: boolean; warnings: EnvelopeWarning[] };
}

describe('Issue.field contract (audit)', () => {
  it('FIELD_OPERATOR_MISMATCH populates issue.field', async () => {
    const db = createTestDb();
    // Insert a list-typed field; using `eq` on a list is a mismatch.
    db.prepare(
      `INSERT INTO global_fields (name, field_type, list_item_type) VALUES (?, ?, ?)`
    ).run('status', 'list', 'string');

    const handler = captureHandler(db);
    const result = await handler({ fields: { status: { eq: 'open' } } });
    const env = parseEnvelope(result);

    const mismatch = env.warnings.find(w => w.code === 'FIELD_OPERATOR_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(mismatch!.field).toBe('status');
  });

  it('CROSS_NODE_FILTER_UNRESOLVED leaves issue.field unset (query-level, not per-field)', async () => {
    const db = createTestDb();
    // Insert a node with an unresolved relationship so the warning fires.
    db.prepare(
      'INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)'
    ).run('n1', 'a.md', 'A');
    db.prepare(
      `INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, NULL)`
    ).run('n1', 'unresolved-title', 'project');

    const handler = captureHandler(db);
    const result = await handler({
      join_filters: [{ rel_type: 'project', target: { types: ['project'] } }],
    });
    const env = parseEnvelope(result);

    const cross = env.warnings.find(w => w.code === 'CROSS_NODE_FILTER_UNRESOLVED');
    expect(cross).toBeDefined();
    expect(cross!.field).toBeUndefined();
  });
});
