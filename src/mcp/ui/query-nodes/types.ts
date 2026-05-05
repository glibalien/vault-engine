/**
 * Shared types for the query-nodes table UI.
 * Mirror of the relevant subset of MCP envelopes + describe-schema shapes.
 */

// Envelope (mirrors src/mcp/tools/errors.ts)
export type Envelope<T> =
  | { ok: true; data: T; warnings: Issue[] }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> }; warnings: Issue[] };

export interface Issue {
  code: string;
  message: string;
  severity: "error" | "warning";
  field?: string;
  details?: unknown;
}

// describe-schema shape we care about
export type FieldType = "string" | "enum" | "number" | "date" | "boolean" | "reference" | "list";
export type WidgetValue = "text" | "textarea" | "enum" | "date" | "number" | "bool" | "link" | "tags";

export interface UiHints {
  widget?: WidgetValue;
  label?: string;
  help?: string;
  order?: number;
}

export interface SchemaField {
  name: string;
  type: FieldType;
  required: boolean;
  default_value: unknown;
  enum_values?: string[];
  reference_target?: string;
  list_item_type?: FieldType;
  label?: string;
  description?: string;
  ui: UiHints | null;
}

export interface Schema {
  name: string;
  display_name: string | null;
  fields: SchemaField[];
}

// query-nodes shape we care about
export type QueryArgs = Record<string, unknown>;

export interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  types: string[];
  version: number;
  field_count: number;
  fields?: Record<string, unknown>;
  score?: number;
  match_sources?: string[];
  snippet?: string;
}

export interface QueryNodesData {
  nodes: NodeRow[];
  total: number;
}

// UI state owned by state.ts
export interface UiState {
  initialArgs: QueryArgs;
  currentArgs: QueryArgs;
  lockedType: string | null;
  schemaCache: Map<string, Schema>;
  envelope: Envelope<QueryNodesData> | null;
  visibleColumns: Set<string> | null;
  inflight: Set<string>;
}
