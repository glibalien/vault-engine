import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult } from './errors.js';

const paramsShape = {
  file_path: z.string().optional().describe('Filter to a single file path'),
  since: z.string().optional().describe('ISO timestamp or relative duration (e.g. "1h", "30m")'),
  events: z.array(z.string()).optional().describe('Filter to specific event types'),
  source: z.string().optional().describe('Filter by source (watcher, tool, propagation, reconciler)'),
  limit: z.number().default(100).describe('Max rows to return (max 1000)'),
  sort_order: z.enum(['asc', 'desc']).default('asc').describe('Sort by timestamp'),
};

function parseRelativeTime(since: string): number | null {
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000;
  return Date.now() - ms;
}

export function registerQuerySyncLog(server: McpServer, db: Database.Database): void {
  server.tool(
    'query-sync-log',
    'Query the sync event timeline for debugging file synchronization issues. Returns per-file events showing watcher triggers, deferred writes, cancellations, and file writes.',
    paramsShape,
    async (params) => {
      const conditions: string[] = [];
      const bindings: unknown[] = [];

      if (params.file_path) {
        conditions.push('file_path = ?');
        bindings.push(params.file_path);
      }

      if (params.since) {
        let sinceMs = parseRelativeTime(params.since);
        if (sinceMs === null) {
          const parsed = Date.parse(params.since);
          if (!isNaN(parsed)) sinceMs = parsed;
        }
        if (sinceMs !== null) {
          conditions.push('timestamp >= ?');
          bindings.push(sinceMs);
        }
      }

      if (params.events && params.events.length > 0) {
        const placeholders = params.events.map(() => '?').join(',');
        conditions.push(`event IN (${placeholders})`);
        bindings.push(...params.events);
      }

      if (params.source) {
        conditions.push('source = ?');
        bindings.push(params.source);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const order = params.sort_order === 'desc' ? 'DESC' : 'ASC';
      const limit = Math.min(params.limit ?? 100, 1000);

      const sql = `SELECT timestamp, file_path, event, source, details FROM sync_log ${where} ORDER BY timestamp ${order}, id ${order} LIMIT ?`;
      bindings.push(limit);

      const rows = db.prepare(sql).all(...bindings) as Array<{
        timestamp: number;
        file_path: string;
        event: string;
        source: string;
        details: string | null;
      }>;

      const parsed = rows.map(row => ({
        timestamp: row.timestamp,
        time: new Date(row.timestamp).toISOString(),
        file_path: row.file_path,
        event: row.event,
        source: row.source,
        details: row.details ? JSON.parse(row.details) : {},
      }));

      return toolResult({
        rows: parsed,
        count: parsed.length,
        truncated: parsed.length === limit,
      });
    },
  );
}
