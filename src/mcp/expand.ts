import type Database from 'better-sqlite3';

export interface ExpandOptions {
  types: string[];
  direction: 'outgoing' | 'incoming' | 'both';
  max_nodes: number;
}

export interface ExpandedNode {
  id: string;
  title: string | null;
  types: string[];
  fields: Record<string, { value: unknown; type: string; source: string }>;
  body: string | null;
}

export interface ExpandStats {
  returned: number;
  considered: number;
  truncated: boolean;
}

export interface ExpandResult {
  expanded: Record<string, ExpandedNode>;
  stats: ExpandStats;
}

export function performExpansion(
  _db: Database.Database,
  _rootId: string,
  _options: ExpandOptions,
): ExpandResult {
  return {
    expanded: {},
    stats: { returned: 0, considered: 0, truncated: false },
  };
}
