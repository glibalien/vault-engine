# M1 — Read-only Schema-driven query-nodes Table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pilot's read-only flat list with a schema-driven, single-type-locked, fresh-on-mount, widget-aware-column table inside the existing `query-nodes` MCP App bundle. Edit/filter/expand are explicit non-goals here — they ship in M2/M3/M4.

**Architecture:** All work is client-side, inside `src/mcp/ui/query-nodes/`. Vite bundles ~14 small TypeScript modules into one self-contained HTML. Pure-logic modules (`schema`, `state`, `client`, `errors`) get vitest unit tests; render layers are manually verified via the demo gate. Engine code is unchanged. Pilot's `register.ts` and `vite.ui.config.ts` are unchanged.

**Tech Stack:** TypeScript (ESM, `.js` extensions in imports), Vite + `vite-plugin-singlefile` for bundling, `@modelcontextprotocol/ext-apps` for the iframe SDK, vitest for pure-logic unit tests.

**Spec:** `docs/superpowers/specs/2026-05-03-query-nodes-interactive-table-v1-design.md`

---

## File map

**New files (under `src/mcp/ui/query-nodes/`):**

| File                       | Responsibility                                                                    | Tested?           |
| -------------------------- | --------------------------------------------------------------------------------- | ----------------- |
| `types.ts`                 | Shared interfaces (`Envelope`, `Issue`, `QueryArgs`, `NodeRow`, `Schema`, `Field`, `UiHints`, `UiState`) | no (pure types)   |
| `state.ts`                 | `UiState` factory + `resolveTypeLock` rules                                       | yes (state.test.ts) |
| `client.ts`                | Typed wrappers around `app.callServerTool` + envelope unwrap                      | yes (client.test.ts) |
| `schema.ts`                | Widget inference table + `widgetForField` / `filterableFields` / `claimedFields` | yes (schema.test.ts) |
| `errors.ts`                | Issue → user-facing message; per-cell error attachment by `Issue.field`           | yes (errors.test.ts) |
| `render/header.ts`         | Title bar + Refresh button + ⚙ Columns toggle                                     | manual            |
| `render/filter-strip.ts`   | Slimmed generic strip (`title_contains`, `query`, `sort`, `limit`)                | manual            |
| `render/chip-strip.ts`     | Type-lock chip (M1 stub; field chips land in M2)                                  | manual            |
| `render/table.ts`          | Header columns from schema + visibility, body rows orchestrator                   | manual            |
| `render/cell-read.ts`      | Per-widget read renderer (8 widget values)                                        | manual            |
| `render/preview-pill.ts`   | Empty stub (M3 will populate)                                                     | n/a               |
| `flows/refresh.ts`         | Re-fetch `query-nodes(currentArgs)`; swap envelope; re-render                     | manual            |
| `flows/edit.ts`            | Empty stub (M3)                                                                   | n/a               |
| `flows/expand.ts`          | Empty stub (M4)                                                                   | n/a               |

**Modified files:**

| File                                       | Why                                                              |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `src/mcp/ui/query-nodes/app.ts`            | Rewrite: new mount sequence (always-fresh, schema cache, type-lock resolution); event delegation now routes through `flows/refresh.ts` and the render layer's interactive handlers |
| `src/mcp/ui/query-nodes/index.html`        | Rewrite: new mount points (`#header-host`, `#filter-strip-host`, `#chip-strip-host`, `#warnings-host`, `#table-host`, `#banner-host`); preserves the `<!-- vault-engine query-nodes ui -->` sentinel that `tests/mcp/query-nodes-ui.test.ts` checks |

**Untouched:** `register.ts`, `vite.ui.config.ts`, `package.json` (no new deps), `tests/mcp/query-nodes-ui.test.ts` (passes unmodified — see Task 11 Step 5), every engine file, every other test file.

**New tests directory:** `tests/mcp/ui/query-nodes/` (4 files).

---

## Task 1: Bootstrap scaffolding + shared types

**Files:**
- Modify: `src/mcp/ui/query-nodes/app.ts` (clear out body; minimal stub that builds)
- Create: `src/mcp/ui/query-nodes/types.ts`
- Create: `src/mcp/ui/query-nodes/render/.gitkeep`, `src/mcp/ui/query-nodes/flows/.gitkeep`

- [ ] **Step 1: Replace pilot `app.ts` content with a minimal compile-only stub**

Write `src/mcp/ui/query-nodes/app.ts`:

```typescript
/**
 * Iframe-side entry for the query-nodes MCP App UI (v1 — schema-driven table).
 *
 * Bootstrapping stub. Subsequent tasks add modules in this directory:
 * types/state/client/schema/errors, render/*, flows/*.
 */
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "vault-engine query-nodes UI", version: "1.0.0" });

app.connect();
```

- [ ] **Step 2: Create `types.ts` with the shared interfaces**

Write `src/mcp/ui/query-nodes/types.ts`:

```typescript
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
```

- [ ] **Step 3: Create empty `render/` and `flows/` directories**

Run:

```bash
mkdir -p src/mcp/ui/query-nodes/render src/mcp/ui/query-nodes/flows
touch src/mcp/ui/query-nodes/render/.gitkeep src/mcp/ui/query-nodes/flows/.gitkeep
```

- [ ] **Step 4: Verify the bundle still builds**

Run:

```bash
npm run build:ui
```

Expected: completes without error; `dist/mcp/ui/query-nodes/index.html` exists.

- [ ] **Step 5: Verify typecheck still passes**

Run:

```bash
npm run typecheck
```

Expected: completes without error.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/ui/query-nodes/
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): bootstrap scaffolding + shared types

Replace pilot app.ts body with a compile-only stub and introduce types.ts
with the shared interfaces (Envelope, Issue, Schema, NodeRow, UiState,
WidgetValue) used across the M1 table modules. Empty render/ and flows/
directories ready for subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: schema.ts — widget inference + helpers

**Files:**
- Create: `src/mcp/ui/query-nodes/schema.ts`
- Create: `tests/mcp/ui/query-nodes/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/mcp/ui/query-nodes/schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  inferWidget,
  widgetForField,
  filterableFields,
  claimedFields,
} from "../../../../src/mcp/ui/query-nodes/schema.js";
import type { SchemaField, Schema } from "../../../../src/mcp/ui/query-nodes/types.js";

function field(name: string, partial: Partial<SchemaField> & { type: SchemaField["type"] }): SchemaField {
  return {
    name,
    required: false,
    default_value: null,
    ui: null,
    ...partial,
  };
}

describe("inferWidget", () => {
  it("maps every (field_type, list_item_type) combination per the foundation table", () => {
    expect(inferWidget("string")).toBe("text");
    expect(inferWidget("enum")).toBe("enum");
    expect(inferWidget("number")).toBe("number");
    expect(inferWidget("date")).toBe("date");
    expect(inferWidget("boolean")).toBe("bool");
    expect(inferWidget("reference")).toBe("link");
    expect(inferWidget("list", "string")).toBe("tags");
    expect(inferWidget("list", "enum")).toBe("tags");
    expect(inferWidget("list", "reference")).toBe("link");
    expect(inferWidget("list", "number")).toBe("tags");
    expect(inferWidget("list", "date")).toBe("tags");
    expect(inferWidget("list", "boolean")).toBe("tags");
  });
});

describe("widgetForField", () => {
  it("respects an explicit widget override", () => {
    const f = field("notes", { type: "string", ui: { widget: "textarea" } });
    expect(widgetForField(f)).toBe("textarea");
  });

  it("falls back to inferred widget when ui or widget is missing", () => {
    expect(widgetForField(field("status", { type: "enum" }))).toBe("enum");
    expect(widgetForField(field("tags", { type: "list", list_item_type: "string", ui: {} }))).toBe("tags");
  });
});

describe("filterableFields", () => {
  it("excludes textarea fields", () => {
    const schema: Schema = {
      name: "task",
      display_name: null,
      fields: [
        field("status", { type: "enum" }),
        field("notes", { type: "string", ui: { widget: "textarea" } }),
        field("due", { type: "date" }),
      ],
    };
    expect(filterableFields(schema).map(f => f.name)).toEqual(["status", "due"]);
  });
});

describe("claimedFields", () => {
  it("returns the schema's fields in declaration order", () => {
    const schema: Schema = {
      name: "task",
      display_name: null,
      fields: [field("status", { type: "enum" }), field("due", { type: "date" })],
    };
    expect(claimedFields(schema).map(f => f.name)).toEqual(["status", "due"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/mcp/ui/query-nodes/schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `schema.ts`**

Write `src/mcp/ui/query-nodes/schema.ts`:

```typescript
/**
 * Widget inference + helpers over describe-schema responses.
 *
 * The inference table is canonical — bundles MUST agree. See spec
 * docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md.
 */
import type { FieldType, Schema, SchemaField, WidgetValue } from "./types.js";

export function inferWidget(fieldType: FieldType, listItemType?: FieldType): WidgetValue {
  switch (fieldType) {
    case "string": return "text";
    case "enum": return "enum";
    case "number": return "number";
    case "date": return "date";
    case "boolean": return "bool";
    case "reference": return "link";
    case "list":
      if (listItemType === "reference") return "link";
      // string / enum / number / date / boolean → tags
      return "tags";
  }
}

export function widgetForField(field: SchemaField): WidgetValue {
  return field.ui?.widget ?? inferWidget(field.type, field.list_item_type);
}

export function claimedFields(schema: Schema): SchemaField[] {
  return schema.fields;
}

export function filterableFields(schema: Schema): SchemaField[] {
  return schema.fields.filter(f => widgetForField(f) !== "textarea");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run tests/mcp/ui/query-nodes/schema.test.ts
```

Expected: PASS — 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/query-nodes/schema.ts tests/mcp/ui/query-nodes/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): widget inference + schema helpers

inferWidget pins the canonical (field_type, list_item_type) → widget
table from the foundations spec. widgetForField respects an explicit
ui.widget override before falling back to inference. filterableFields
excludes textarea per the M2 chip rules.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: state.ts — state factory + type-lock resolver

**Files:**
- Create: `src/mcp/ui/query-nodes/state.ts`
- Create: `tests/mcp/ui/query-nodes/state.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/mcp/ui/query-nodes/state.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createState, resolveTypeLock } from "../../../../src/mcp/ui/query-nodes/state.js";
import type { NodeRow } from "../../../../src/mcp/ui/query-nodes/types.js";

function row(types: string[]): NodeRow {
  return {
    id: `id-${types.join("-")}`,
    file_path: "x.md",
    title: "x",
    types,
    version: 1,
    field_count: 0,
  };
}

describe("createState", () => {
  it("returns a fresh state with empty caches and the provided args", () => {
    const args = { types: ["task"] };
    const s = createState(args);
    expect(s.initialArgs).toEqual(args);
    expect(s.currentArgs).toEqual(args);
    expect(s.initialArgs).not.toBe(args);  // deep clone
    expect(s.lockedType).toBeNull();
    expect(s.schemaCache.size).toBe(0);
    expect(s.envelope).toBeNull();
    expect(s.visibleColumns).toBeNull();
    expect(s.inflight.size).toBe(0);
  });
});

describe("resolveTypeLock", () => {
  it("locks to args.types when exactly one is given", () => {
    expect(resolveTypeLock({ types: ["task"] })).toEqual({ kind: "locked", type: "task" });
  });

  it("locks to result-row consensus when args.types is empty and all rows share a type", () => {
    const rows = [row(["task"]), row(["task"]), row(["task"])];
    expect(resolveTypeLock({}, rows)).toEqual({ kind: "locked", type: "task" });
  });

  it("locks to result-row consensus when args.types is empty and rows share types[0]", () => {
    const rows = [row(["task", "archived"]), row(["task"])];
    expect(resolveTypeLock({}, rows)).toEqual({ kind: "locked", type: "task" });
  });

  it("returns unlocked + candidate list when rows span multiple types", () => {
    const rows = [row(["task"]), row(["project"]), row(["task"])];
    expect(resolveTypeLock({}, rows)).toEqual({
      kind: "unlocked",
      candidates: ["project", "task"],
    });
  });

  it("returns unlocked when args.types has multiple entries", () => {
    const rows = [row(["task"]), row(["project"])];
    expect(resolveTypeLock({ types: ["task", "project"] }, rows)).toEqual({
      kind: "unlocked",
      candidates: ["project", "task"],
    });
  });

  it("returns unlocked with no candidates when no rows are available", () => {
    expect(resolveTypeLock({})).toEqual({ kind: "unlocked", candidates: [] });
  });

  it("returns unlocked with no candidates for an empty result set", () => {
    expect(resolveTypeLock({}, [])).toEqual({ kind: "unlocked", candidates: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/mcp/ui/query-nodes/state.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `state.ts`**

Write `src/mcp/ui/query-nodes/state.ts`:

```typescript
/**
 * UI state factory and type-lock resolution rules.
 *
 * Type-lock resolution (per spec):
 *   1. args.types has exactly one value → lock to it.
 *   2. else: result rows all share types[0] → lock to it.
 *   3. else: unlocked, surface candidate list (sorted, de-duped).
 */
import type { NodeRow, QueryArgs, UiState } from "./types.js";

export function createState(args: QueryArgs): UiState {
  return {
    initialArgs: structuredClone(args),
    currentArgs: structuredClone(args),
    lockedType: null,
    schemaCache: new Map(),
    envelope: null,
    visibleColumns: null,
    inflight: new Set(),
  };
}

export type TypeLock =
  | { kind: "locked"; type: string }
  | { kind: "unlocked"; candidates: string[] };

export function resolveTypeLock(args: QueryArgs, rows?: NodeRow[]): TypeLock {
  const argTypes = Array.isArray(args.types) ? (args.types as string[]) : [];
  if (argTypes.length === 1) {
    return { kind: "locked", type: argTypes[0]! };
  }

  if (rows && rows.length > 0) {
    const firstTypes = rows.map(r => r.types[0]).filter((t): t is string => typeof t === "string");
    if (firstTypes.length > 0 && firstTypes.every(t => t === firstTypes[0])) {
      return { kind: "locked", type: firstTypes[0]! };
    }
    const candidates = Array.from(new Set(firstTypes)).sort();
    return { kind: "unlocked", candidates };
  }

  return { kind: "unlocked", candidates: [] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run tests/mcp/ui/query-nodes/state.test.ts
```

Expected: PASS — 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/query-nodes/state.ts tests/mcp/ui/query-nodes/state.test.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): UI state factory + type-lock resolver

createState builds a fresh UiState with deep-cloned args and empty
caches. resolveTypeLock implements the three-rule resolution from the
spec: args.types exact-one lock, then row-types[0] consensus, then
unlocked-with-candidates fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: client.ts — typed MCP tool wrappers

**Files:**
- Create: `src/mcp/ui/query-nodes/client.ts`
- Create: `tests/mcp/ui/query-nodes/client.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/mcp/ui/query-nodes/client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { unwrapEnvelope, makeClient } from "../../../../src/mcp/ui/query-nodes/client.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function tr(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

describe("unwrapEnvelope", () => {
  it("parses an ok envelope", () => {
    const env = unwrapEnvelope(tr({ ok: true, data: { nodes: [], total: 0 }, warnings: [] }));
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data).toEqual({ nodes: [], total: 0 });
      expect(env.warnings).toEqual([]);
    }
  });

  it("parses a fail envelope", () => {
    const env = unwrapEnvelope(tr({
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
      warnings: [],
    }));
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("NOT_FOUND");
    }
  });

  it("throws when content[0] is not text", () => {
    expect(() => unwrapEnvelope({ content: [] } as CallToolResult)).toThrow(/missing text content/);
  });

  it("throws on invalid JSON", () => {
    expect(() => unwrapEnvelope({ content: [{ type: "text", text: "not json" }] } as CallToolResult))
      .toThrow();
  });
});

describe("makeClient", () => {
  it("dispatches each tool by name with the given args", async () => {
    const callServerTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === "query-nodes") return tr({ ok: true, data: { nodes: [], total: 0 }, warnings: [] });
      if (name === "describe-schema") return tr({ ok: true, data: { name: "task", display_name: null, fields: [] }, warnings: [] });
      throw new Error(`unexpected ${name}`);
    });

    const client = makeClient(callServerTool);

    const q = await client.queryNodes({ types: ["task"] });
    expect(q.ok).toBe(true);
    expect(callServerTool).toHaveBeenCalledWith({ name: "query-nodes", arguments: { types: ["task"] } });

    const s = await client.describeSchema("task");
    expect(s.ok).toBe(true);
    expect(callServerTool).toHaveBeenLastCalledWith({ name: "describe-schema", arguments: { name: "task" } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/mcp/ui/query-nodes/client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `client.ts`**

Write `src/mcp/ui/query-nodes/client.ts`:

```typescript
/**
 * Typed wrappers around app.callServerTool with envelope unwrap.
 * Single chokepoint for tool calls — render/flows never call the SDK directly.
 *
 * In M1 only queryNodes / describeSchema / describeGlobalField / listFieldValues
 * are wired. updateNode / renameNode / getNode arrive in M3 and M4.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Envelope, QueryArgs, QueryNodesData, Schema } from "./types.js";

export function unwrapEnvelope<T = unknown>(result: CallToolResult): Envelope<T> {
  const text = (result.content?.[0] as { type: string; text?: string } | undefined)?.text;
  if (typeof text !== "string") {
    throw new Error("Tool result missing text content");
  }
  return JSON.parse(text) as Envelope<T>;
}

type CallFn = App["callServerTool"];

export interface Client {
  queryNodes(args: QueryArgs): Promise<Envelope<QueryNodesData>>;
  describeSchema(name: string): Promise<Envelope<Schema>>;
  describeGlobalField(name: string): Promise<Envelope<Record<string, unknown>>>;
  listFieldValues(field: string): Promise<Envelope<{ values: string[] }>>;
}

export function makeClient(callServerTool: CallFn): Client {
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<Envelope<T>> => {
    const result = await callServerTool({ name, arguments: args });
    return unwrapEnvelope<T>(result);
  };

  return {
    queryNodes: (args) => call<QueryNodesData>("query-nodes", args as Record<string, unknown>),
    describeSchema: (name) => call<Schema>("describe-schema", { name }),
    describeGlobalField: (name) => call<Record<string, unknown>>("describe-global-field", { name }),
    listFieldValues: (field) => call<{ values: string[] }>("list-field-values", { field }),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run tests/mcp/ui/query-nodes/client.test.ts
```

Expected: PASS — 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/query-nodes/client.ts tests/mcp/ui/query-nodes/client.test.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): typed MCP tool wrappers

makeClient builds a typed facade around app.callServerTool with one
chokepoint for envelope unwrap. M1 wires the read tools; updateNode /
renameNode / getNode are stubbed to land with M3 and M4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: errors.ts — Issue → user message + per-cell attachment

**Files:**
- Create: `src/mcp/ui/query-nodes/errors.ts`
- Create: `tests/mcp/ui/query-nodes/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/mcp/ui/query-nodes/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { topLevelError, cellWarningsFor } from "../../../../src/mcp/ui/query-nodes/errors.js";
import type { Envelope, Issue } from "../../../../src/mcp/ui/query-nodes/types.js";

const okEnv: Envelope<{ x: number }> = { ok: true, data: { x: 1 }, warnings: [] };
const failEnv: Envelope<unknown> = {
  ok: false,
  error: { code: "VALIDATION_FAILED", message: "Validation failed with 1 error(s)" },
  warnings: [],
};

describe("topLevelError", () => {
  it("returns null for ok envelopes", () => {
    expect(topLevelError(okEnv)).toBeNull();
  });

  it("returns code · message for fail envelopes", () => {
    expect(topLevelError(failEnv)).toBe("VALIDATION_FAILED · Validation failed with 1 error(s)");
  });
});

describe("cellWarningsFor", () => {
  const w1: Issue = { code: "FIELD_OPERATOR_MISMATCH", message: "wrong op", severity: "warning", field: "status" };
  const w2: Issue = { code: "RESULT_TRUNCATED", message: "many rows", severity: "warning" };
  const w3: Issue = { code: "REQUIRED_MISSING", message: "missing", severity: "error", field: "due" };

  it("returns issues whose .field matches the requested field name", () => {
    expect(cellWarningsFor([w1, w2, w3], "status")).toEqual([w1]);
    expect(cellWarningsFor([w1, w2, w3], "due")).toEqual([w3]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(cellWarningsFor([w1, w2, w3], "priority")).toEqual([]);
  });

  it("excludes issues with no .field", () => {
    expect(cellWarningsFor([w2], "status")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/mcp/ui/query-nodes/errors.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `errors.ts`**

Write `src/mcp/ui/query-nodes/errors.ts`:

```typescript
/**
 * Envelope/Issue → user-surface adapters.
 *
 * topLevelError formats a fail envelope as a banner-ready string.
 * cellWarningsFor partitions the .warnings array by Issue.field for
 * per-cell error chip rendering (relies on the Foundation #2.5 audit
 * that pinned Issue.field population at every per-field site).
 */
import type { Envelope, Issue } from "./types.js";

export function topLevelError(envelope: Envelope<unknown>): string | null {
  if (envelope.ok) return null;
  return `${envelope.error.code} · ${envelope.error.message}`;
}

export function cellWarningsFor(warnings: Issue[], fieldName: string): Issue[] {
  return warnings.filter(w => w.field === fieldName);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run tests/mcp/ui/query-nodes/errors.test.ts
```

Expected: PASS — 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/query-nodes/errors.ts tests/mcp/ui/query-nodes/errors.test.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): envelope/Issue → user-surface adapters

topLevelError formats a fail envelope as a banner string; cellWarningsFor
partitions warnings by Issue.field for per-cell chip rendering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: render/cell-read.ts — per-widget read renderer

**Files:**
- Create: `src/mcp/ui/query-nodes/render/cell-read.ts`

This task has no automated tests (DOM-touching render). Visual verification happens at the Task 12 demo gate.

- [ ] **Step 1: Write `cell-read.ts`**

Write `src/mcp/ui/query-nodes/render/cell-read.ts`:

```typescript
/**
 * Per-widget read-only cell renderer.
 *
 * Each function takes a value (possibly null/undefined) and returns an
 * HTMLElement. Edit-mode editors land in cell-edit.ts (M3); the dispatch
 * key here is identical so the M3 swap is mechanical.
 */
import type { WidgetValue } from "../types.js";

type Child = string | Node | null | undefined | Child[];

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") node.className = v;
      else node.setAttribute(k, v);
    }
  }
  const append = (c: Child): void => {
    if (c == null) return;
    if (Array.isArray(c)) c.forEach(append);
    else if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  };
  children.forEach(append);
  return node;
}

function emptyCell(): HTMLElement {
  return el("span", { className: "cell-empty" }, "—");
}

function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function renderText(value: unknown): HTMLElement {
  const s = asString(value);
  return s ? el("span", { className: "cell-text" }, s) : emptyCell();
}

function renderTextarea(value: unknown): HTMLElement {
  const s = asString(value);
  if (!s) return emptyCell();
  const truncated = s.length > 120 ? s.slice(0, 117) + "…" : s;
  return el("span", { className: "cell-textarea", title: s }, truncated);
}

function renderEnum(value: unknown): HTMLElement {
  const s = asString(value);
  return s ? el("span", { className: "cell-enum" }, s) : emptyCell();
}

function renderDate(value: unknown): HTMLElement {
  const s = asString(value);
  return s ? el("span", { className: "cell-date" }, s) : emptyCell();
}

function renderNumber(value: unknown): HTMLElement {
  if (value == null || value === "") return emptyCell();
  return el("span", { className: "cell-number" }, asString(value));
}

function renderBool(value: unknown): HTMLElement {
  if (value == null) return emptyCell();
  return el("span", { className: "cell-bool" }, value ? "✓" : "✗");
}

function renderLink(value: unknown): HTMLElement {
  if (value == null || value === "") return emptyCell();
  if (Array.isArray(value)) {
    if (value.length === 0) return emptyCell();
    const wrap = el("span", { className: "cell-link-multi" });
    value.forEach((v, i) => {
      if (i > 0) wrap.appendChild(document.createTextNode(", "));
      wrap.appendChild(el("span", { className: "cell-link-chip" }, asString(v)));
    });
    return wrap;
  }
  return el("span", { className: "cell-link" }, asString(value));
}

function renderTags(value: unknown): HTMLElement {
  if (!Array.isArray(value) || value.length === 0) return emptyCell();
  const wrap = el("span", { className: "cell-tags" });
  value.forEach((v, i) => {
    if (i > 0) wrap.appendChild(document.createTextNode(" "));
    wrap.appendChild(el("span", { className: "cell-tag-chip" }, asString(v)));
  });
  return wrap;
}

const renderers: Record<WidgetValue, (value: unknown) => HTMLElement> = {
  text: renderText,
  textarea: renderTextarea,
  enum: renderEnum,
  date: renderDate,
  number: renderNumber,
  bool: renderBool,
  link: renderLink,
  tags: renderTags,
};

export function renderCell(widget: WidgetValue, value: unknown): HTMLElement {
  return renderers[widget](value);
}
```

- [ ] **Step 2: Verify typecheck passes**

Run:

```bash
npm run typecheck
```

Expected: completes without error.

- [ ] **Step 3: Verify the bundle still builds**

Run:

```bash
npm run build:ui
```

Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/ui/query-nodes/render/cell-read.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): per-widget read-mode cell renderer

renderCell dispatches by widget value to one of eight small renderers
(text/textarea/enum/date/number/bool/link/tags). Textarea truncates at
120 chars with the full value in title. Tags / multi-link render as
chip lists. The el helper mirrors the pilot's pattern (no innerHTML,
no string concat).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: render/header.ts + render/filter-strip.ts

**Files:**
- Create: `src/mcp/ui/query-nodes/render/header.ts`
- Create: `src/mcp/ui/query-nodes/render/filter-strip.ts`

- [ ] **Step 1: Write `header.ts`**

Write `src/mcp/ui/query-nodes/render/header.ts`:

```typescript
/**
 * Top header row: title (locked-type display name), result count, refresh
 * button, ⚙ Columns toggle. Click handlers are attached at the app event
 * delegation root, not here.
 */
import type { Schema, UiState } from "../types.js";
import { el } from "./cell-read.js";

export function renderHeader(state: UiState, schema: Schema | null): HTMLElement {
  const title = schema?.display_name ?? schema?.name ?? "(no type lock)";
  const total = state.envelope?.ok ? state.envelope.data.total : 0;

  return el("div", { className: "header-bar" },
    el("div", { className: "header-title" },
      el("strong", null, title),
      el("span", { className: "header-count" }, ` ${total} result${total === 1 ? "" : "s"}`),
    ),
    el("div", { className: "header-actions" },
      el("button", { id: "btn-refresh", className: "header-button" }, "↻ Refresh"),
      el("button", { id: "btn-columns", className: "header-button header-button-secondary" }, "⚙ Columns"),
    ),
  );
}
```

- [ ] **Step 2: Write `filter-strip.ts`**

Write `src/mcp/ui/query-nodes/render/filter-strip.ts`:

```typescript
/**
 * Slimmed generic filter strip — query-shape primitives only.
 * The pilot's `types` input is gone (it's the type-lock chip in M2).
 *
 * Inputs: title_contains, query, sort_by, sort_order, limit.
 * Click "Apply" to refilter. The flow is wired in app.ts.
 */
import type { QueryArgs } from "../types.js";
import { el } from "./cell-read.js";

export function renderFilterStrip(args: QueryArgs): HTMLElement {
  const titleInput = el("input", { id: "ff-title", placeholder: "title contains…" });
  (titleInput as HTMLInputElement).value = (args.title_contains as string) ?? "";

  const queryInput = el("input", { id: "ff-query", placeholder: "hybrid search…" });
  (queryInput as HTMLInputElement).value = (args.query as string) ?? "";

  const sortBy = el("select", { id: "ff-sort-by" },
    el("option", { value: "title" }, "title"),
    el("option", { value: "file_mtime" }, "file_mtime"),
    el("option", { value: "indexed_at" }, "indexed_at"),
  ) as HTMLSelectElement;
  sortBy.value = (args.sort_by as string) ?? "title";

  const sortOrder = el("select", { id: "ff-sort-order" },
    el("option", { value: "asc" }, "asc"),
    el("option", { value: "desc" }, "desc"),
  ) as HTMLSelectElement;
  sortOrder.value = (args.sort_order as string) ?? "asc";

  const limitInput = el("input", { id: "ff-limit", type: "number", min: "1", max: "200" });
  (limitInput as HTMLInputElement).value = String((args.limit as number) ?? 50);

  return el("div", { className: "filter-strip" },
    el("label", null, "title ", titleInput),
    el("label", null, "query ", queryInput),
    el("label", null, "sort ", sortBy, sortOrder),
    el("label", null, "limit ", limitInput),
    el("button", { id: "ff-apply", className: "header-button" }, "Apply"),
    el("button", { id: "ff-reset", className: "header-button header-button-secondary" }, "Reset"),
  );
}

export function readFilterStrip(): QueryArgs {
  const title_contains = (document.getElementById("ff-title") as HTMLInputElement | null)?.value.trim() ?? "";
  const query = (document.getElementById("ff-query") as HTMLInputElement | null)?.value.trim() ?? "";
  const sort_by = (document.getElementById("ff-sort-by") as HTMLSelectElement | null)?.value ?? "title";
  const sort_order = (document.getElementById("ff-sort-order") as HTMLSelectElement | null)?.value ?? "asc";
  const limit = parseInt((document.getElementById("ff-limit") as HTMLInputElement | null)?.value ?? "50", 10) || 50;
  const args: QueryArgs = { sort_by, sort_order, limit };
  if (title_contains) args.title_contains = title_contains;
  if (query) args.query = query;
  return args;
}
```

- [ ] **Step 3: Verify typecheck passes**

Run:

```bash
npm run typecheck
```

Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/ui/query-nodes/render/header.ts src/mcp/ui/query-nodes/render/filter-strip.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): header bar + slimmed generic filter strip

renderHeader shows the locked-type name + count + refresh / columns
buttons. renderFilterStrip + readFilterStrip cover the four query-shape
primitives (title_contains, query, sort, limit); the pilot's types
input is dropped — the type lock lives in chip-strip.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: render/chip-strip.ts — type-lock chip (M1 stub)

**Files:**
- Create: `src/mcp/ui/query-nodes/render/chip-strip.ts`

- [ ] **Step 1: Write `chip-strip.ts`**

Write `src/mcp/ui/query-nodes/render/chip-strip.ts`:

```typescript
/**
 * Schema-driven filter chip strip.
 *
 * M1: renders only the type-lock chip (or a "pick a type" banner when
 * the lock is unresolved). Field chips arrive in M2.
 */
import type { UiState } from "../types.js";
import type { TypeLock } from "../state.js";
import { el } from "./cell-read.js";

export function renderChipStrip(_state: UiState, lock: TypeLock): HTMLElement {
  const wrap = el("div", { className: "chip-strip" });

  if (lock.kind === "locked") {
    wrap.appendChild(
      el("span", {
        className: "chip chip-type-lock",
        "data-chip": "type-lock",
        "data-type": lock.type,
      }, `type: ${lock.type} ▾`),
    );
    return wrap;
  }

  // Unlocked — render type picker as inline buttons + a banner.
  wrap.appendChild(
    el("div", { className: "chip-banner" },
      el("strong", null, "Pick a type to enable the table."),
      lock.candidates.length > 0
        ? el("span", { className: "chip-banner-hint" }, " Result spans multiple types.")
        : el("span", { className: "chip-banner-hint" }, " No results to derive a type from."),
    ),
  );
  for (const t of lock.candidates) {
    wrap.appendChild(
      el("button", {
        className: "chip chip-type-candidate",
        "data-chip": "type-pick",
        "data-type": t,
      }, t),
    );
  }
  return wrap;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run:

```bash
npm run typecheck
```

Expected: completes without error.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/query-nodes/render/chip-strip.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): chip strip — type-lock chip + pick-a-type banner

renderChipStrip emits the type-lock chip when a type is locked, or a
"pick a type" banner with one button per candidate when unlocked. M2
will populate field chips alongside; M1 leaves that empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: render/table.ts — header + body orchestrator

**Files:**
- Create: `src/mcp/ui/query-nodes/render/table.ts`

- [ ] **Step 1: Write `table.ts`**

Write `src/mcp/ui/query-nodes/render/table.ts`:

```typescript
/**
 * Table orchestrator. Computes header columns from the cached schema +
 * visibility rules, and body rows from the query envelope's data.nodes.
 *
 * Column visibility (M1 default; user can override via "⚙ Columns"):
 *   - title (synthetic): always shown
 *   - text / enum / date / number / bool / link (single ref): shown
 *   - textarea / tags / list-of-reference: hidden
 *   - body: never shown
 */
import type { NodeRow, Schema, SchemaField, UiState, WidgetValue } from "../types.js";
import { widgetForField, claimedFields } from "../schema.js";
import { renderCell, el } from "./cell-read.js";

const HIDDEN_BY_DEFAULT_WIDGETS: ReadonlySet<WidgetValue> = new Set(["textarea", "tags"]);

export function defaultVisibleColumns(schema: Schema): Set<string> {
  const visible = new Set<string>(["__title__"]);
  for (const f of claimedFields(schema)) {
    const w = widgetForField(f);
    if (HIDDEN_BY_DEFAULT_WIDGETS.has(w)) continue;
    if (f.type === "list" && f.list_item_type === "reference") continue;
    visible.add(f.name);
  }
  return visible;
}

function effectiveVisible(state: UiState, schema: Schema): Set<string> {
  return state.visibleColumns ?? defaultVisibleColumns(schema);
}

export function renderTable(state: UiState, schema: Schema): HTMLElement {
  const visible = effectiveVisible(state, schema);
  const fieldsToRender: SchemaField[] = claimedFields(schema).filter(f => visible.has(f.name));

  const headerCells: Node[] = [el("th", { className: "th th-title" }, "title")];
  for (const f of fieldsToRender) {
    headerCells.push(el("th", { className: "th" }, f.label ?? f.name));
  }

  const headerRow = el("tr", null, ...headerCells);

  const rows = state.envelope?.ok ? state.envelope.data.nodes : [];
  const bodyRows: Node[] = rows.length === 0
    ? [el("tr", null, el("td", { className: "td-empty", colspan: String(headerCells.length) }, "No results."))]
    : rows.map(row => renderBodyRow(row, fieldsToRender));

  return el("table", { className: "results-table" },
    el("thead", null, headerRow),
    el("tbody", null, ...bodyRows),
  );
}

function renderBodyRow(row: NodeRow, fields: SchemaField[]): HTMLElement {
  const titleCell = el("td", { className: "td td-title", "data-id": row.id, "data-field": "__title__" },
    el("strong", null, row.title ?? "(untitled)"),
  );
  const fieldCells = fields.map(f => {
    const widget = widgetForField(f);
    const cell = renderCell(widget, row.fields?.[f.name]);
    return el("td", { className: "td", "data-id": row.id, "data-field": f.name }, cell);
  });
  return el("tr", { className: "tr-row", "data-id": row.id }, titleCell, ...fieldCells);
}

export function renderColumnsPicker(schema: Schema, state: UiState): HTMLElement {
  const visible = effectiveVisible(state, schema);
  const items = claimedFields(schema).map(f => {
    const checked = visible.has(f.name) ? { checked: "checked" } : {};
    const checkbox = el("input", {
      type: "checkbox",
      "data-cols-toggle": f.name,
      ...checked,
    });
    return el("label", { className: "cols-picker-row" }, checkbox, " ", f.label ?? f.name);
  });
  return el("div", { className: "cols-picker" }, ...items);
}
```

- [ ] **Step 2: Verify typecheck passes**

Run:

```bash
npm run typecheck
```

Expected: completes without error.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/query-nodes/render/table.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): table orchestrator with column visibility

renderTable emits header columns from the cached schema (filtered by
visibility) and body rows from the query envelope. defaultVisibleColumns
hides textarea / tags / list-of-reference by default; user overrides
flow through state.visibleColumns. renderColumnsPicker drives the
⚙ Columns affordance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: flows/refresh.ts + M3/M4 stubs

**Files:**
- Create: `src/mcp/ui/query-nodes/flows/refresh.ts`
- Create: `src/mcp/ui/query-nodes/flows/edit.ts` (stub)
- Create: `src/mcp/ui/query-nodes/flows/expand.ts` (stub)
- Create: `src/mcp/ui/query-nodes/render/preview-pill.ts` (stub)

- [ ] **Step 1: Write `flows/refresh.ts`**

Write `src/mcp/ui/query-nodes/flows/refresh.ts`:

```typescript
/**
 * Refresh flow — re-fetch query-nodes with the current args, update the
 * state envelope, return success/failure for the caller (app.ts) to
 * decide whether to re-render.
 */
import type { Client } from "../client.js";
import type { UiState } from "../types.js";

export async function refresh(state: UiState, client: Client): Promise<void> {
  const env = await client.queryNodes(state.currentArgs);
  state.envelope = env;
}
```

- [ ] **Step 2: Write the M3/M4 stubs**

Write `src/mcp/ui/query-nodes/flows/edit.ts`:

```typescript
/**
 * M3 — inline cell edit + smart-confirm flow. Stub in M1.
 */
export function editStub(): void {
  // populated in M3
}
```

Write `src/mcp/ui/query-nodes/flows/expand.ts`:

```typescript
/**
 * M4 — parent → child expansion via get-node expand. Stub in M1.
 */
export function expandStub(): void {
  // populated in M4
}
```

Write `src/mcp/ui/query-nodes/render/preview-pill.ts`:

```typescript
/**
 * M3 — preview pill rendered inside an edited cell when smart-confirm
 * promotes. Stub in M1.
 */
export function previewPillStub(): void {
  // populated in M3
}
```

- [ ] **Step 3: Verify typecheck passes**

Run:

```bash
npm run typecheck
```

Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/ui/query-nodes/flows/ src/mcp/ui/query-nodes/render/preview-pill.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): refresh flow + M3/M4 module stubs

refresh re-fetches query-nodes with current args and updates the state
envelope. edit / expand / preview-pill modules are present as stubs so
the file structure matches the spec; M3 and M4 populate them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: app.ts mount sequence + index.html mount points

**Files:**
- Modify: `src/mcp/ui/query-nodes/index.html`
- Modify: `src/mcp/ui/query-nodes/app.ts`

- [ ] **Step 1: Rewrite `index.html` with the new mount points**

Write `src/mcp/ui/query-nodes/index.html`:

```html
<!DOCTYPE html>
<!-- vault-engine query-nodes ui -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Vault Engine — Query Nodes</title>
    <style>
      :root { color-scheme: light dark; font-family: var(--mcp-font-family, system-ui, sans-serif); }
      body { margin: 0; padding: 0; background: var(--mcp-color-background, white); color: var(--mcp-color-text, black); }

      .header-bar { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #e0e0e0; background: #fafafa; }
      .header-title strong { margin-right: 8px; }
      .header-count { color: #666; font-size: 12px; }
      .header-button { padding: 4px 10px; font-size: 12px; margin-left: 4px; cursor: pointer; }
      .header-button-secondary { background: #eee; color: #333; }

      .filter-strip { padding: 8px 14px; background: #f5f5f5; border-bottom: 1px solid #e0e0e0; font-size: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .filter-strip input, .filter-strip select { font-size: 12px; }

      .chip-strip { padding: 8px 14px; display: flex; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid #e0e0e0; background: white; }
      .chip { padding: 4px 10px; border-radius: 14px; font-size: 12px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; }
      .chip-type-lock { background: #e3f2fd; border-color: #1976d2; color: #0d47a1; }
      .chip-banner { padding: 6px 0; color: #333; }
      .chip-banner-hint { color: #666; font-size: 12px; margin-left: 6px; }

      .warnings { padding: 8px 14px; background: #fff7d6; border-bottom: 1px solid #d4a800; font-size: 12px; color: #5d4d00; }

      .banner { padding: 10px 14px; background: #ffebee; border-bottom: 1px solid #c62828; color: #b71c1c; font-size: 13px; }

      .results-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .results-table thead { background: #fafafa; border-bottom: 2px solid #e0e0e0; }
      .results-table th { text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; color: #666; letter-spacing: 0.5px; font-weight: 500; }
      .results-table td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
      .td-empty { color: #999; font-style: italic; padding: 16px; text-align: center; }
      .cell-empty { color: #ccc; }
      .cell-tag-chip, .cell-link-chip { display: inline-block; padding: 1px 6px; background: #e3f2fd; color: #0d47a1; border-radius: 8px; font-size: 11px; margin-right: 4px; }

      .cols-picker { padding: 12px 14px; background: white; border-bottom: 1px solid #e0e0e0; display: none; }
      .cols-picker.open { display: block; }
      .cols-picker-row { display: block; padding: 2px 0; font-size: 13px; }
    </style>
  </head>
  <body>
    <div id="banner-host"></div>
    <div id="header-host"></div>
    <div id="filter-strip-host"></div>
    <div id="chip-strip-host"></div>
    <div id="cols-picker-host" class="cols-picker"></div>
    <div id="warnings-host"></div>
    <div id="table-host"></div>
    <script type="module" src="/app.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Rewrite `app.ts` with mount sequence + event delegation**

Write `src/mcp/ui/query-nodes/app.ts`:

```typescript
/**
 * Iframe-side entry for the query-nodes MCP App UI (v1, M1).
 *
 * Mount sequence:
 *   1. App.connect → wait for ontoolinput (host pushes args).
 *   2. Ignore ontoolresult; bundle calls query-nodes itself (always-fresh).
 *   3. Resolve type lock from args; if locked, fetch describe-schema + query-nodes.
 *      Else fetch query-nodes first, derive lock from rows, fetch schema.
 *   4. Render header / filter-strip / chip-strip / table.
 *
 * Event delegation routes through a single document.body click listener.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

import type { UiState, QueryArgs } from "./types.js";
import { createState, resolveTypeLock, type TypeLock } from "./state.js";
import { makeClient, type Client } from "./client.js";
import { topLevelError } from "./errors.js";

import { renderHeader } from "./render/header.js";
import { renderFilterStrip, readFilterStrip } from "./render/filter-strip.js";
import { renderChipStrip } from "./render/chip-strip.js";
import { renderTable, renderColumnsPicker, defaultVisibleColumns } from "./render/table.js";
import { refresh } from "./flows/refresh.js";

type HostContext = Parameters<NonNullable<App["onhostcontextchanged"]>>[0];

const app = new App({ name: "vault-engine query-nodes UI", version: "1.0.0" });
const client: Client = makeClient(app.callServerTool.bind(app));

let state: UiState | null = null;
let currentLock: TypeLock = { kind: "unlocked", candidates: [] };

function setBanner(text: string | null): void {
  const host = document.getElementById("banner-host");
  if (!host) return;
  host.replaceChildren();
  if (text) {
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent = text;
    host.appendChild(banner);
  }
}

function setWarnings(warnings: { code: string; message: string }[]): void {
  const host = document.getElementById("warnings-host");
  if (!host) return;
  host.replaceChildren();
  if (!warnings.length) return;
  const lines = warnings.map(w => `${w.code}: ${w.message}`).join("\n");
  const div = document.createElement("div");
  div.className = "warnings";
  div.textContent = lines;
  host.appendChild(div);
}

async function ensureSchema(typeName: string): Promise<void> {
  if (!state) return;
  if (state.schemaCache.has(typeName)) return;
  const env = await client.describeSchema(typeName);
  if (!env.ok) {
    setBanner(`describe-schema failed for "${typeName}": ${env.error.code} · ${env.error.message}`);
    return;
  }
  state.schemaCache.set(typeName, env.data);
}

async function recomputeLockAndRender(): Promise<void> {
  if (!state) return;

  const rows = state.envelope?.ok ? state.envelope.data.nodes : undefined;
  currentLock = resolveTypeLock(state.currentArgs, rows);
  if (currentLock.kind === "locked") {
    state.lockedType = currentLock.type;
    await ensureSchema(currentLock.type);
  } else {
    state.lockedType = null;
  }

  render();
}

function render(): void {
  if (!state) return;

  const lockedSchema = state.lockedType ? state.schemaCache.get(state.lockedType) ?? null : null;

  const headerHost = document.getElementById("header-host")!;
  const filterStripHost = document.getElementById("filter-strip-host")!;
  const chipStripHost = document.getElementById("chip-strip-host")!;
  const tableHost = document.getElementById("table-host")!;

  headerHost.replaceChildren(renderHeader(state, lockedSchema));
  filterStripHost.replaceChildren(renderFilterStrip(state.currentArgs));
  chipStripHost.replaceChildren(renderChipStrip(state, currentLock));

  if (state.envelope && !state.envelope.ok) {
    setBanner(topLevelError(state.envelope));
    tableHost.replaceChildren();
    setWarnings(state.envelope.warnings);
    return;
  }
  setBanner(null);
  setWarnings(state.envelope?.warnings ?? []);

  if (lockedSchema) {
    tableHost.replaceChildren(renderTable(state, lockedSchema));
  } else {
    tableHost.replaceChildren();  // chip strip's "pick a type" banner is sufficient
  }
}

async function applyFilterStrip(): Promise<void> {
  if (!state) return;
  const next: QueryArgs = { ...readFilterStrip() };
  if (Array.isArray(state.currentArgs.types)) next.types = state.currentArgs.types;
  state.currentArgs = next;
  await refresh(state, client);
  await recomputeLockAndRender();
}

async function resetFilterStrip(): Promise<void> {
  if (!state) return;
  state.currentArgs = structuredClone(state.initialArgs);
  await refresh(state, client);
  await recomputeLockAndRender();
}

async function pickType(typeName: string): Promise<void> {
  if (!state) return;
  state.currentArgs = { ...state.currentArgs, types: [typeName] };
  await refresh(state, client);
  await recomputeLockAndRender();
}

function toggleColumnsPicker(): void {
  if (!state || !state.lockedType) return;
  const schema = state.schemaCache.get(state.lockedType);
  if (!schema) return;
  const host = document.getElementById("cols-picker-host")!;
  if (host.classList.contains("open")) {
    host.classList.remove("open");
    host.replaceChildren();
    return;
  }
  host.replaceChildren(renderColumnsPicker(schema, state));
  host.classList.add("open");
}

function onColumnsToggle(field: string): void {
  if (!state || !state.lockedType) return;
  const schema = state.schemaCache.get(state.lockedType);
  if (!schema) return;
  // Materialize defaults on first toggle so the user's diff is well-defined.
  const visible = state.visibleColumns ?? defaultVisibleColumns(schema);
  if (visible.has(field)) visible.delete(field);
  else visible.add(field);
  state.visibleColumns = visible;
  render();
  // Re-render the open picker to reflect the toggle.
  const host = document.getElementById("cols-picker-host")!;
  if (host.classList.contains("open")) {
    host.replaceChildren(renderColumnsPicker(schema, state));
  }
}

async function mount(args: QueryArgs): Promise<void> {
  state = createState(args);

  // Pre-fetch path: if args.types uniquely names a type, fetch schema first
  // so the first render has the column model. Otherwise fetch query-nodes
  // first and derive lock from rows.
  const preLock = resolveTypeLock(state.currentArgs);
  if (preLock.kind === "locked") {
    await ensureSchema(preLock.type);
    await refresh(state, client);
  } else {
    await refresh(state, client);
    const postLock = resolveTypeLock(
      state.currentArgs,
      state.envelope?.ok ? state.envelope.data.nodes : undefined,
    );
    if (postLock.kind === "locked") {
      await ensureSchema(postLock.type);
    }
  }
  await recomputeLockAndRender();
}

app.onhostcontextchanged = (ctx: HostContext) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
};

app.ontoolinput = (params) => {
  const args = (params.arguments ?? {}) as QueryArgs;
  void mount(args);
};

// Always-fresh: ignore the host's pre-pushed result. We call query-nodes ourselves.
app.ontoolresult = () => { /* intentionally ignored */ };

app.ontoolcancelled = (params) => {
  console.info("[query-nodes-ui] Tool call cancelled:", params.reason);
};

document.body.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement | null;
  if (!target) return;

  if (target.id === "btn-refresh") { void refreshAndRender(); return; }
  if (target.id === "btn-columns") { toggleColumnsPicker(); return; }
  if (target.id === "ff-apply") { void applyFilterStrip(); return; }
  if (target.id === "ff-reset") { void resetFilterStrip(); return; }

  const colsToggle = target.getAttribute("data-cols-toggle");
  if (colsToggle) { onColumnsToggle(colsToggle); return; }

  const chipKind = target.getAttribute("data-chip");
  if (chipKind === "type-pick") {
    const t = target.getAttribute("data-type");
    if (t) void pickType(t);
    return;
  }
});

async function refreshAndRender(): Promise<void> {
  if (!state) return;
  await refresh(state, client);
  await recomputeLockAndRender();
}

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) app.onhostcontextchanged?.(ctx);
});
```

- [ ] **Step 3: Verify the bundle builds**

Run:

```bash
npm run build:ui
```

Expected: completes without error; `dist/mcp/ui/query-nodes/index.html` exists.

- [ ] **Step 4: Verify typecheck passes**

Run:

```bash
npm run typecheck
```

Expected: completes without error.

- [ ] **Step 5: Verify the existing pilot UI test still passes**

The pilot's UI test (`tests/mcp/query-nodes-ui.test.ts`) asserts:
1. The resource registers at `ui://vault-engine/query-nodes`.
2. The bundle body contains the sentinel comment `<!-- vault-engine query-nodes ui -->` (this is why Step 1 keeps it in the new HTML).
3. The MIME type is `text/html;profile=mcp-app`.
4. The `query-nodes` tool advertises `_meta.ui.resourceUri` pointing at the resource.

None of these depend on mount-point IDs, so no test changes are required if the sentinel comment is preserved. Run the suite to confirm:

```bash
npx vitest run tests/mcp/query-nodes-ui.test.ts
```

Expected: PASS — 4 passing.

- [ ] **Step 6: Run the full vitest suite**

Run:

```bash
npm test
```

Expected: every existing suite still passes; the four new pure-logic suites (`schema`, `state`, `client`, `errors`) pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/ui/query-nodes/index.html src/mcp/ui/query-nodes/app.ts
git commit -m "$(cat <<'EOF'
feat(ui-table-m1): app.ts mount sequence + index.html mount points

Wire the M1 mount sequence: connect → ontoolinput captures args →
always-fresh fetch of query-nodes (host result ignored) → resolve
type lock → fetch describe-schema → render header / filter-strip /
chip-strip / table. Event delegation drives Refresh, ⚙ Columns,
filter-strip Apply/Reset, and type-picker chip clicks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Build verification + manual demo gate

**Files:** none (verification + observation only)

- [ ] **Step 1: Full build**

Run:

```bash
npm run build
```

Expected: `tsc` + `typecheck` + `build:ui` all complete without error. `dist/mcp/ui/query-nodes/index.html` exists.

- [ ] **Step 2: Confirm the bundle is self-contained**

Run:

```bash
grep -E '<script src="https?://' dist/mcp/ui/query-nodes/index.html || echo "no external script tags"
```

Expected: prints `no external script tags`. (Vite's singlefile plugin should inline everything.)

- [ ] **Step 3: Restart the engine on the production deploy**

The user runs:

```bash
sudo systemctl restart vault-engine-new.service
journalctl -u vault-engine-new.service -n 50 --no-pager
```

Expected: clean startup, no errors about the UI bundle. The log should show the UI resource registered.

- [ ] **Step 4: Refresh the Claude connector**

In Claude, **remove and re-add** the vault-engine MCP connector (per the pilot postmortem — clients cache `tools/list` metadata). Without this step the iframe will fail to load with "unable to reach <server>" because Claude won't fetch the new metadata.

- [ ] **Step 5: Run the demo gate**

Ask Claude: *"Use the vault engine and call query-nodes with types: ['task'], limit: 25"*. Verify in order:

1. **Iframe renders.** Claude shows the bundle; you see the header bar, filter strip, chip strip with "type: task ▾", and a table with rows.
2. **Schema-driven columns.** The header columns are the task schema's claimed scalar fields (e.g., `status`, `due`, `priority`, `project`) — not a generic JSON dump. Long `textarea` fields (e.g., `notes` if it has `widget: textarea`) and `tags`-widget fields are hidden by default.
3. **⚙ Columns toggle.** Click ⚙ Columns; checkbox list of all claims appears; toggling a hidden column reveals it; toggling a shown column hides it.
4. **Refresh button.** Edit a task in Obsidian (e.g., change a status). Click ↻ Refresh in the iframe. The new value appears without a model turn.
5. **Filter strip Apply.** Type a `title_contains` value, click Apply. Table updates with the filtered rows. Reset restores the initial view.
6. **Type lock when args.types is empty.** Ask Claude: *"call query-nodes with no types filter, limit 5"*. The chip strip shows "Pick a type to enable the table" with a button per candidate. Click one — the table populates against that type.
7. **Codex graceful degradation.** Open Codex CLI, call `query-nodes` against the same engine. Output is byte-identical JSON envelope.

Each item must pass before declaring M1 complete.

- [ ] **Step 6: Commit the milestone tag (optional)**

If the demo gate passes:

```bash
git tag -a m1-query-nodes-table -m "M1 — read-only schema-driven query-nodes table"
git push origin m1-query-nodes-table  # only if user requests
```

---

## Self-review checklist

**Spec coverage:**

- [x] v1 capability #1 (live data on mount) → Task 11 always-fresh mount sequence + Refresh button
- [x] v1 capability #3 (all available fields as columns) → Task 9 `defaultVisibleColumns` + ⚙ Columns
- [x] Single-type lock resolution → Task 3 `resolveTypeLock` + Task 11 mount sequence
- [x] Always-fresh on mount → Task 11 `app.ontoolresult` ignored + bundle calls `query-nodes` itself
- [x] Slimmed generic filter strip → Task 7 `renderFilterStrip` (drops `types` input)
- [x] `Issue.field` per-cell error attachment → Task 5 `cellWarningsFor` (cell-level rendering ships in M3 with edit; banner rendering is wired in Task 11)
- [x] Column visibility defaults + toggle → Task 9
- [x] M2/M3/M4 stubs in place → Tasks 8 (chip-strip) + 10 (preview-pill / edit / expand)
- [x] Pure-logic unit tests for `schema`/`state`/`client`/`errors` → Tasks 2/3/4/5
- [x] Manual demo gate → Task 12

**Out-of-scope confirmed deferred:** M2 field chips (Task 8 only renders type-lock chip), M3 inline edit (cell-edit + edit flow + preview-pill + STALE_NODE), M4 parent-child expansion, body view, bulk select.

**Placeholder scan:** No "TBD"/"TODO"/"implement later" inside any step's code or commands.

**Type consistency:** `UiState` / `Schema` / `SchemaField` / `WidgetValue` / `Envelope<T>` / `Issue` / `NodeRow` / `QueryArgs` defined once in `types.ts` (Task 1) and imported by every downstream module. `TypeLock` defined in `state.ts` (Task 3) and consumed by `chip-strip.ts` (Task 8) + `app.ts` (Task 11). `Client` interface defined in `client.ts` (Task 4) and consumed by `flows/refresh.ts` (Task 10) + `app.ts` (Task 11).
