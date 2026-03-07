# Vault Engine: Architecture Sketch

## Working Name: `vault-engine`

A local-first, MCP-native knowledge graph engine that wraps clean markdown files with agentic knowledge management capabilities. Editor-agnostic — works with Obsidian, Typora, VS Code, iA Writer, or anything that reads markdown. The agent is the primary interface for everything except reading and writing prose.

---

## Design Principles

1. **Markdown is canonical, full stop.** Every piece of structural data — types, fields, relationships — lives in the markdown (frontmatter + wiki-links). The database is always a derived index, rebuildable from the files at any time. If the DB is deleted, nothing is lost.
2. **Every meaningful entity gets its own file.** Tasks, projects, people, meetings — each is a separate `.md` file with its own frontmatter. This keeps files focused, linkable, and independently valid.
3. **Editor-agnostic by charter.** The engine watches a folder of markdown files. It does not depend on Obsidian, VS Code, or any specific editor or plugin. Any editor that opens `.md` files works.
4. **The agent is the primary interface.** Creating nodes, querying, managing tasks, organizing knowledge — all agent-driven via MCP tools. The editor is a viewport for reading and writing prose, not the control surface.
5. **Multi-typed, composable nodes.** Any node can have multiple types via a `types` array in frontmatter (e.g., `types: [meeting, task]`). Types are additive — they contribute fields and behaviors without constraining identity. Inheritance (e.g., `work-task` extends `task`) is resolved by the engine at the schema level.
6. **Relationships are wiki-links.** Connections between nodes are expressed as `[[wiki-links]]` in frontmatter fields or body content. The engine indexes these as typed relationships but does not invent relationships that aren't in the markdown.
7. **Runs on cheap models.** Tool interfaces are explicit, well-documented, and low-ambiguity. A 120B-class open model (e.g., gpt-oss-120b) should be able to use every tool correctly without chain-of-thought scaffolding. This means: explicit enum values, required fields clearly marked, examples in descriptions, structured JSON responses.
8. **Incremental by default.** Every operation — indexing, querying, syncing — handles single-file changes without full rebuilds.
9. **Schema-aware, not schema-enforced.** Schemas guide the agent and enable queries, but a file that violates schema is still valid markdown. The engine warns; it doesn't reject.

---

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript | Consistent with MCP SDK, strong typing for schema validation, broad ecosystem |
| Database | SQLite (via `better-sqlite3`) | Single-file, no server, fast, WAL mode for concurrent reads, FTS5 for full-text search |
| Vector Store | sqlite-vss (preferred) or ChromaDB | sqlite-vss consolidates into one DB file, zero extra daemons; ChromaDB as fallback if richer vector ops needed |
| File Watching | `chokidar` | Mature, cross-platform, debounce-friendly |
| Markdown Parser | `unified` + `remark` + `mdast` | Produces a proper AST, extensible with plugins for wiki-links, frontmatter, block IDs |
| Frontmatter | `gray-matter` (or `remark-frontmatter` + `yaml`) | Standard YAML frontmatter parsing |
| MCP Server | `@modelcontextprotocol/sdk` | Protocol layer for agent communication |
| Embedding | Local model via `ollama` or API call | For vector indexing; pluggable. `nomic-embed-text` or similar for local |
| Process Model | Single long-running Node process | Watches files, serves MCP, manages DB |

### Why SQLite over Postgres/Mongo/etc.

- Zero deployment. It's a file.
- Runs embedded in the same process as the MCP server.
- WAL mode allows concurrent reads while the engine writes (no lock contention on the DB — file-level conflicts are a separate concern).
- FTS5 gives you full-text search without another dependency.
- sqlite-vss keeps vectors in the same file, eliminating the need for a separate vector DB daemon.

### Why `unified`/`remark` over regex or custom parsing

- Produces a standard MDAST (Markdown Abstract Syntax Tree) that you can walk, transform, and serialize back.
- Plugins exist for frontmatter, wiki-links, GFM tables, math, etc.
- Round-trip fidelity: `remark-stringify` can reproduce markdown from the AST with minimal drift.
- You'll need AST manipulation for block ID injection, content extraction, and safe mutations.

---

## Project Structure

```
vault-engine/
├── src/
│   ├── index.ts                  # Entry point: starts watcher, DB, MCP server
│   ├── config.ts                 # Loads vault config + schema definitions
│   │
│   ├── parser/
│   │   ├── markdown.ts           # unified/remark pipeline: md → MDAST
│   │   ├── frontmatter.ts        # YAML frontmatter extraction + validation
│   │   ├── block-ids.ts          # Block ID assignment + stability logic
│   │   ├── wiki-links.ts         # [[link]] and [[link|alias]] extraction
│   │   └── inline-fields.ts      # Dataview-style key:: value parsing
│   │
│   ├── db/
│   │   ├── schema.ts             # SQLite table definitions + migrations
│   │   ├── connection.ts         # better-sqlite3 setup, WAL mode, pragmas
│   │   ├── nodes.ts              # CRUD for nodes table
│   │   ├── fields.ts             # CRUD for typed fields
│   │   ├── relationships.ts      # CRUD for edges/links
│   │   ├── queries.ts            # Compound query builder (filter + join + FTS)
│   │   └── vectors.ts            # Vector store interface (ChromaDB or sqlite-vss)
│   │
│   ├── schema/
│   │   ├── loader.ts             # Reads .schemas/*.yaml from vault
│   │   ├── validator.ts          # Validates node data against schema definitions
│   │   ├── types.ts              # TypeScript types for schema system
│   │   └── defaults.ts           # Built-in schemas (note, daily-note, etc.)
│   │
│   ├── sync/
│   │   ├── watcher.ts            # chokidar file watcher with debounce
│   │   ├── indexer.ts            # File → parse → DB upsert pipeline
│   │   ├── reconciler.ts         # Handles conflicts, drift detection
│   │   └── rebuild.ts            # Full vault re-index from scratch
│   │
│   ├── serializer/
│   │   ├── markdown.ts           # MDAST → markdown string (remark-stringify)
│   │   ├── frontmatter.ts        # Structured fields → YAML frontmatter
│   │   ├── node-to-file.ts       # Full node → complete .md file
│   │   └── patch.ts              # Surgical file edits (update one block without rewriting whole file)
│   │
│   ├── mcp/
│   │   ├── server.ts             # MCP server setup + tool registration
│   │   ├── tools/
│   │   │   ├── query.ts          # search, filter, semantic-search, graph-traverse
│   │   │   ├── read.ts           # get-node, get-file, get-schema, get-recent
│   │   │   ├── mutate.ts         # create-node, update-fields, add-link, move-node
│   │   │   ├── schema.ts         # list-schemas, describe-schema, validate-node
│   │   │   └── workflow.ts       # Higher-level: create-meeting-notes, extract-action-items
│   │   └── resources/
│   │       ├── vault-stats.ts    # Resource: vault statistics
│   │       └── recent-changes.ts # Resource: recently modified nodes
│   │
│   └── utils/
│       ├── id.ts                 # Block ID generation (nanoid or similar)
│       ├── paths.ts              # Vault-relative path utilities
│       └── debounce.ts           # Debounce/throttle helpers
│
├── schemas/                      # Default schema definitions (shipped with engine)
│   ├── _base.yaml                # Common fields all nodes inherit
│   ├── project.yaml
│   ├── person.yaml
│   ├── meeting.yaml
│   └── action-item.yaml
│
├── tests/
│   ├── parser/                   # Unit tests for parsing pipeline
│   ├── db/                       # Tests for DB operations
│   ├── sync/                     # Integration tests for file ↔ DB sync
│   └── fixtures/                 # Sample markdown files for testing
│
├── vault-engine.config.yaml      # Per-vault configuration
└── package.json
```

---

## SQLite Schema

```sql
-- Core: every addressable block in the vault
CREATE TABLE nodes (
    id              TEXT PRIMARY KEY,        -- stable block ID (nanoid or file-path-derived)
    file_path       TEXT NOT NULL,           -- vault-relative path
    node_type       TEXT NOT NULL,           -- 'file', 'heading', 'block', 'list-item'
    parent_id       TEXT,                    -- parent node (file for headings, heading for blocks)
    position_start  INTEGER,                 -- byte offset in source file
    position_end    INTEGER,
    depth           INTEGER DEFAULT 0,       -- nesting level (heading level, list depth)
    content_text    TEXT,                    -- plain text content (for FTS)
    content_md      TEXT,                    -- original markdown content
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES nodes(id)
);

-- Multi-typing: a node can have multiple schema types
-- e.g., a node with types: [meeting, task] gets two rows here
CREATE TABLE node_types (
    node_id         TEXT NOT NULL,
    schema_type     TEXT NOT NULL,           -- e.g., 'meeting', 'task', 'work-task'
    PRIMARY KEY (node_id, schema_type),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Full-text search on content
CREATE VIRTUAL TABLE nodes_fts USING fts5(
    content_text,
    content='nodes',
    content_rowid='rowid'
);

-- Typed fields (frontmatter + inline fields)
CREATE TABLE fields (
    node_id         TEXT NOT NULL,
    key             TEXT NOT NULL,
    value_text      TEXT,                    -- string representation
    value_type      TEXT NOT NULL,           -- 'string', 'number', 'date', 'boolean', 'reference', 'enum'
    value_number    REAL,                    -- for numeric comparisons/sorting
    value_date      TEXT,                    -- ISO 8601 for date comparisons
    PRIMARY KEY (node_id, key),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Relationships between nodes
CREATE TABLE relationships (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id       TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    rel_type        TEXT NOT NULL,           -- 'wiki-link', 'contains', 'owns', 'assigned-to', etc.
    context         TEXT,                    -- surrounding text for wiki-links
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Schema definitions (cached from YAML files)
CREATE TABLE schemas (
    name            TEXT PRIMARY KEY,
    definition      TEXT NOT NULL,           -- JSON blob of the full schema
    file_path       TEXT,                    -- source .yaml file
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- File-level metadata for change detection
CREATE TABLE files (
    path            TEXT PRIMARY KEY,        -- vault-relative
    mtime           TEXT NOT NULL,           -- last modified time
    hash            TEXT NOT NULL,           -- content hash for drift detection
    indexed_at      TEXT DEFAULT (datetime('now'))
);

-- Indices
CREATE INDEX idx_nodes_file ON nodes(file_path);
CREATE INDEX idx_nodes_parent ON nodes(parent_id);
CREATE INDEX idx_node_types_schema ON node_types(schema_type);
CREATE INDEX idx_fields_key_value ON fields(key, value_text);
CREATE INDEX idx_fields_key_number ON fields(key, value_number);
CREATE INDEX idx_fields_key_date ON fields(key, value_date);
CREATE INDEX idx_rel_source ON relationships(source_id);
CREATE INDEX idx_rel_target ON relationships(target_id);
CREATE INDEX idx_rel_type ON relationships(rel_type);
```

---

## Schema Definition Format

Schemas live as YAML files in a `.schemas/` directory in the vault root (or a configurable location). Schemas are composable: a node can have multiple types, and types can extend other types.

### Multi-Typing in Frontmatter

A node's types are declared as an array in frontmatter. The engine merges fields from all applicable schemas:

```markdown
---
title: Q1 Planning Meeting
types: [meeting, task]
# fields from 'meeting' schema:
date: 2025-03-06
attendees: ["[[Alice Smith]]", "[[Bob Jones]]"]
# fields from 'task' schema:
status: todo
assignee: "[[Alice Smith]]"
due_date: 2025-03-05
---

Prep the deck and circulate agenda before the meeting.
```

The engine knows `date` and `attendees` come from the `meeting` schema, while `status`, `assignee`, and `due_date` come from the `task` schema. Validation merges field definitions from all types. If two types define the same field name with compatible types, they share it. If incompatible, the engine warns.

### Schema Inheritance

A schema can extend another schema, inheriting all its fields:

```yaml
# .schemas/task.yaml
name: task
display_name: Task
icon: ✅

fields:
  status:
    type: enum
    values: [todo, in-progress, blocked, done, cancelled]
    default: todo
    required: true
  assignee:
    type: reference
    target_schema: person
  due_date:
    type: date
  priority:
    type: enum
    values: [critical, high, medium, low]
    default: medium
  source:
    type: reference                   # What meeting/project spawned this

serialization:
  filename_template: "tasks/{{title}}.md"
  frontmatter_fields: [status, assignee, due_date, priority, source]
```

```yaml
# .schemas/work-task.yaml
name: work-task
display_name: Work Task
icon: 💼
extends: task                          # Inherits all fields from task

fields:
  # Additional fields specific to work tasks
  project:
    type: reference
    target_schema: project
  department:
    type: string
  billable:
    type: boolean
    default: false

serialization:
  filename_template: "tasks/work/{{title}}.md"
  frontmatter_fields: [status, assignee, due_date, priority, source, project, department, billable]
```

A file with `types: [work-task]` automatically gets all `task` fields plus `project`, `department`, and `billable`. The engine resolves the inheritance chain — the frontmatter doesn't need to say `types: [task, work-task]` (though it can).

### Relationship Model

Relationships between nodes are expressed entirely as wiki-links in markdown. The engine categorizes them:

- **Frontmatter references**: `assignee: "[[Alice Smith]]"` → typed relationship (`assignee` → person node)
- **Body wiki-links**: `[[Send budget spreadsheet]]` in the meeting body → contextual relationship (engine stores surrounding text)
- **Source backlinks**: `source: "[[Q1 Planning Meeting]]"` → explicit provenance

The engine indexes all wiki-links and resolves them to node IDs. The relationship type is inferred from context: frontmatter key name for frontmatter refs, or `wiki-link` for body links. No relationships exist in the DB that aren't derivable from the markdown.

### Core Schema Definitions

```yaml
# .schemas/project.yaml
name: project
display_name: Project
icon: 🎯

fields:
  status:
    type: enum
    values: [active, paused, completed, archived]
    default: active
    required: true
  owner:
    type: reference
    target_schema: person
    required: true
  stakeholders:
    type: list<reference>
    target_schema: person
  timeline_start:
    type: date
  timeline_end:
    type: date
  priority:
    type: enum
    values: [critical, high, medium, low]
    default: medium
  tags:
    type: list<string>

serialization:
  filename_template: "projects/{{title}}.md"
  frontmatter_fields: [status, owner, stakeholders, timeline_start, timeline_end, priority, tags]

computed:
  task_count:
    query: "COUNT nodes WHERE types INCLUDES 'task' AND source REFERENCES this"
  completion_pct:
    query: "COUNT(status='done') / COUNT(*) WHERE types INCLUDES 'task' AND source REFERENCES this"
```

```yaml
# .schemas/person.yaml
name: person
display_name: Person
icon: 👤

fields:
  role:
    type: string
  company:
    type: string
  email:
    type: string
  phone:
    type: string
  tags:
    type: list<string>

serialization:
  filename_template: "people/{{title}}.md"
  frontmatter_fields: [role, company, email, phone, tags]
```

```yaml
# .schemas/meeting.yaml
name: meeting
display_name: Meeting
icon: 📅

fields:
  date:
    type: date
    required: true
  attendees:
    type: list<reference>
    target_schema: person
  project:
    type: reference
    target_schema: project
  status:
    type: enum
    values: [scheduled, completed, cancelled]
    default: scheduled

serialization:
  filename_template: "meetings/{{date}}-{{title}}.md"
  frontmatter_fields: [date, attendees, project, status]
```

---

## Block ID Strategy

Block IDs let the engine address individual elements within a file — headings, bullets, paragraphs. Since every meaningful entity gets its own file, block IDs are a secondary concern: they enable sub-file references (e.g., linking to a specific bullet in a meeting note) but aren't required for the core workflow.

### Approach: Obsidian-Compatible `^block-id` Syntax

Following Obsidian's convention for maximum editor compatibility:

```markdown
## Discussion Points

- We need to finalize the budget by Friday ^budget-deadline
  - Alice will send the updated spreadsheet ^alice-spreadsheet
  - Bob to review vendor proposals ^bob-vendors
```

Obsidian renders these as invisible anchors and supports linking to them via `[[file#^block-id]]`. Other editors show them as plain text (harmless). The engine assigns IDs automatically on first index using short nanoids (e.g., `^ve-x1y2z` with a `ve-` prefix to distinguish engine-generated IDs from user-created ones).

### ID Rules

1. **Generated on first index** when the engine encounters a block without an ID.
2. **Persisted in the file** as trailing `^id` syntax per Obsidian convention.
3. **Stable across edits.** Moving a block preserves its ID. Engine detects moved blocks by content similarity.
4. **Short and namespaced.** Engine-generated IDs use `^ve-xxxxx` (5-char nanoid) to avoid collision with user-created block refs.
5. **Opt-in per vault.** Disable in config to fall back to position-based addressing (less stable but zero file modification).
6. **File-level nodes don't need block IDs.** File path is the stable identifier for file-level nodes.

### When Block IDs Matter

- Linking to a specific section from another file's frontmatter or body
- Agent referencing a specific bullet to update ("mark the third action item as done")
- Future: extracting a block into its own file while preserving incoming links

For v1, block IDs are nice-to-have. The "every entity is a file" principle means most addressable things have file paths as IDs.

---

## MCP Tool Definitions

Tool design principle: every tool should be usable by a 120B-class model without ambiguity. This means explicit parameter types, clear descriptions with examples, and structured responses. Prefer multiple focused tools over fewer multi-purpose tools.

### Query Tools

```typescript
// Structured search with schema-aware filtering
tool("query-nodes", {
  description: "Search for nodes by type, field values, and text. Examples: 'find all tasks where status is todo', 'find projects owned by Alice'. Returns a list of matching nodes with their fields.",
  params: {
    schema_type: z.string().optional()
      .describe("Schema type to filter by, e.g. 'task', 'project', 'meeting', 'person'. A node matches if it has this type in its types array (supports multi-typed nodes)."),
    filters: z.array(z.object({
      field: z.string().describe("Field name, e.g. 'status', 'assignee', 'due_date'"),
      operator: z.enum(["eq", "neq", "gt", "lt", "gte", "lte", "contains", "in"])
        .describe("eq: equals, neq: not equals, gt/lt/gte/lte: comparison, contains: substring, in: value in list"),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    })).optional(),
    full_text: z.string().optional().describe("Full-text search query against node content"),
    limit: z.number().default(20),
    order_by: z.string().optional().describe("Sort field and direction, e.g. 'due_date ASC', 'updated_at DESC'"),
  }
});

// Semantic search (vector similarity)
tool("semantic-search", {
  description: "Find nodes semantically similar to a natural language query",
  params: {
    query: z.string(),
    schema_type: z.string().optional(),
    filters: z.array(/* same as above */).optional(),
    limit: z.number().default(10),
  }
});

// Graph traversal
tool("traverse-graph", {
  description: "Find nodes connected to a given node within N hops",
  params: {
    node_id: z.string(),
    rel_types: z.array(z.string()).optional(),   // filter by relationship type
    direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
    max_depth: z.number().default(2),
    target_schema: z.string().optional(),
  }
});
```

### Read Tools

```typescript
tool("get-node", {
  description: "Get full details of a specific node by ID or file path",
  params: {
    node_id: z.string().optional(),
    file_path: z.string().optional(),
    include_children: z.boolean().default(false),
    include_relationships: z.boolean().default(false),
  }
});

tool("get-recent", {
  description: "Get recently created or modified nodes",
  params: {
    schema_type: z.string().optional(),
    since: z.string().optional(),              // ISO date
    limit: z.number().default(20),
  }
});
```

### Mutation Tools

```typescript
tool("create-node", {
  description: "Create a new node as a markdown file with frontmatter. The engine validates fields against the schema(s), writes the file, and indexes it. Example: create a task with title 'Review proposal', types ['task'], status 'todo', assignee '[[Bob]]'.",
  params: {
    title: z.string().describe("Node title, used as filename and H1 heading"),
    types: z.array(z.string()).describe("Schema types for this node, e.g. ['task'], ['meeting', 'task'], ['work-task']"),
    fields: z.record(z.any()).describe("Key-value pairs matching the combined schema fields, e.g. {status: 'todo', assignee: '[[Alice]]'}"),
    body: z.string().optional().describe("Markdown body content below the frontmatter"),
    parent_path: z.string().optional().describe("Directory to create file in; defaults to schema's filename_template"),
    relationships: z.array(z.object({
      target: z.string().describe("Target node: wiki-link title, file path, or node ID, e.g. '[[Alice Smith]]'"),
      rel_type: z.string().describe("Relationship type, e.g. 'source', 'related'"),
    })).optional(),
  }
});

tool("update-node", {
  description: "Update fields or content of an existing node",
  params: {
    node_id: z.string(),
    fields: z.record(z.any()).optional(),      // fields to update (merge, not replace)
    body: z.string().optional(),               // replace body content
    append_body: z.string().optional(),        // append to existing body
  }
});

tool("add-relationship", {
  description: "Create a typed relationship between two nodes",
  params: {
    source_id: z.string(),
    target_id: z.string(),
    rel_type: z.string(),
  }
});

tool("batch-mutate", {
  description: "Execute multiple mutations atomically",
  params: {
    operations: z.array(z.object({
      op: z.enum(["create", "update", "delete", "link", "unlink"]),
      params: z.record(z.any()),
    })),
  }
});
```

### Schema Introspection Tools

```typescript
tool("list-schemas", {
  description: "List all available schema definitions in the vault",
  params: {}
});

tool("describe-schema", {
  description: "Get the full definition of a schema including fields, types, and constraints",
  params: {
    schema_name: z.string(),
  }
});

tool("validate-node", {
  description: "Check if a node's data conforms to its schema",
  params: {
    node_id: z.string().optional(),
    data: z.object({                           // or validate hypothetical data
      schema_type: z.string(),
      fields: z.record(z.any()),
    }).optional(),
  }
});
```

### Workflow Tools (Higher-Level)

```typescript
tool("create-meeting-notes", {
  description: "Create a meeting note with attendees, link to project, and placeholder for action items",
  params: {
    title: z.string(),
    date: z.string(),
    attendees: z.array(z.string()),            // names — engine resolves to person nodes
    project: z.string().optional(),            // project name or ID
    agenda: z.string().optional(),
  }
});

tool("extract-action-items", {
  description: "Parse a node's content for action items and create linked action-item nodes",
  params: {
    source_node_id: z.string(),
    auto_assign: z.boolean().default(true),    // Try to match @mentions to person nodes
  }
});

tool("daily-summary", {
  description: "Generate a summary of today's changes, due items, and active projects",
  params: {
    date: z.string().optional(),               // defaults to today
  }
});
```

---

## The Sync Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                         VAULT (filesystem)                       │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │
│  │ note.md  │  │project.md│  │person.md │  │.schemas/*.yml│    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘    │
└──────────┬───────────────────────────────────────┬──────────────┘
           │ chokidar watches                      │
           ▼                                       │
┌──────────────────────┐                           │
│   File Watcher       │                           │
│   (debounced, 300ms) │                           │
└──────────┬───────────┘                           │
           │ file changed/created/deleted           │
           ▼                                       │
┌──────────────────────┐                           │
│   Parser/Indexer     │                           │
│   • frontmatter      │                           │
│   • MDAST            │                           │
│   • block IDs        │                           │
│   • wiki-links       │                           │
│   • inline fields    │                           │
└──────────┬───────────┘                           │
           │ structured data                        │
           ▼                                       │
┌──────────────────────────────────────┐           │
│   Database Layer                      │           │
│   ┌────────────┐  ┌───────────────┐  │           │
│   │  SQLite    │  │   ChromaDB /  │  │           │
│   │  (struct)  │  │  sqlite-vss   │  │           │
│   │            │  │  (vectors)    │  │           │
│   └────────────┘  └───────────────┘  │           │
└──────────┬───────────────────────────┘           │
           │                                       │
           ▼                                       │
┌──────────────────────┐                           │
│   MCP Server         │                           │
│   ┌────────┐         │                           │
│   │ Query  │◄── Claude asks: "find active        │
│   │ Tools  │    projects with Alice"              │
│   └────────┘                                     │
│   ┌────────┐         │                           │
│   │ Mutate │──── Claude says: "create a new  ────┤
│   │ Tools  │    project node"                │   │
│   └────────┘         │                       │   │
│   ┌────────┐         │                       ▼   │
│   │Workflow│         │              ┌─────────────────┐
│   │ Tools  │         │              │  Serializer     │
│   └────────┘         │              │  • frontmatter  │
└──────────────────────┘              │  • markdown     │
                                      │  • file write   │
                                      └────────┬────────┘
                                               │
                                               │ writes .md file
                                               ▼
                                      (vault filesystem — watcher
                                       picks up change, re-indexes,
                                       loop completes)
```

### Avoiding Infinite Loops

When the engine writes a file (via mutation), the watcher will pick it up. To avoid re-indexing what we just wrote:

1. **Write lock**: Engine sets a flag with the file path before writing. Watcher checks the flag and skips.
2. **Content hash check**: After writing, store the hash. When watcher fires, compare hash — if identical, skip.
3. **Both**: Belt and suspenders.

---

## Configuration

```yaml
# vault-engine.config.yaml (lives in vault root)

vault:
  path: ~/vault                       # or auto-detect from CWD
  schema_dir: .schemas                # where schema YAML lives
  ignore:                             # paths to skip during indexing
    - .obsidian/                      # ignore editor-specific dirs
    - .vscode/
    - .trash/
    - templates/
    - node_modules/

block_ids:
  enabled: true                       # inject ^ve-xxxxx block IDs into files
  prefix: "ve-"                       # prefix for engine-generated IDs
  length: 5                           # nanoid length

database:
  path: .vault-engine/vault.db        # SQLite file location
  wal_mode: true

vectors:
  provider: sqlite-vss                # 'sqlite-vss' or 'chromadb'
  chromadb_url: http://localhost:8000  # if using chromadb
  embedding_model: nomic-embed-text   # via ollama
  ollama_url: http://localhost:11434

mcp:
  transport: stdio                    # 'stdio' or 'sse'
  port: 3333                          # if using SSE

watcher:
  debounce_ms: 300
  ignore_patterns:
    - "**/.DS_Store"
    - "**/*.tmp"

logging:
  level: info                         # debug, info, warn, error
  file: .vault-engine/engine.log
```

---

## Implementation Phases

### Phase 1: Read-Only Foundation (Weeks 1–3)

**Goal:** Index a vault into SQLite, serve read queries via MCP.

- [ ] Markdown parser pipeline (unified/remark → MDAST)
- [ ] Frontmatter extraction with `types` array support
- [ ] Wiki-link extraction (frontmatter refs + body links)
- [ ] SQLite schema creation + node/node_types/field/relationship insertion
- [ ] File watcher with debounce
- [ ] Incremental indexing (only changed files)
- [ ] Full rebuild command
- [ ] MCP tools: `get-node`, `query-nodes`, `get-recent`, `list-schemas`
- [ ] Basic FTS5 search

**Milestone:** Agent can query the vault structurally: "find all nodes with types including task where status is todo" returns correct results.

### Phase 2: Schema System + Multi-Typing (Weeks 4–5)

**Goal:** Schema definitions with inheritance and multi-type support.

- [ ] YAML schema loader with `extends` support
- [ ] Multi-type field merging (union fields from all types on a node)
- [ ] Schema validation on index (warn, don't reject)
- [ ] Reference resolution (wiki-link title → node ID via title lookup table)
- [ ] Schema introspection MCP tools: `list-schemas`, `describe-schema`, `validate-node`
- [ ] Computed field stubs (count, basic aggregations)

**Milestone:** Agent can ask "describe the work-task schema" and see inherited + own fields. Queries filter by any type in the multi-type array.

### Phase 3: Write Path (Weeks 6–8)

**Goal:** Agent can create and modify nodes that serialize to clean markdown files.

- [ ] Markdown serializer (structured data → .md file with clean frontmatter + body)
- [ ] `create-node` tool with multi-type schema validation
- [ ] `update-node` tool (field updates, body append/replace)
- [ ] `add-relationship` tool (writes wiki-links into frontmatter or body)
- [ ] Write lock / hash check to prevent watcher loops
- [ ] Batch mutation support (`batch-mutate` tool)
- [ ] File path generation from schema `filename_template`

**Milestone:** "Create a work-task called 'Review vendor proposals' assigned to Bob, due Friday, linked to the CenterPoint project" produces a valid, well-formatted markdown file in the right directory with correct frontmatter.

### Phase 4: Vector Search Integration (Weeks 9–10)

**Goal:** Semantic search alongside structured queries.

- [ ] Embedding pipeline (chunk → embed → store)
- [ ] sqlite-vss integration (or ChromaDB fallback)
- [ ] `semantic-search` MCP tool
- [ ] Hybrid queries (semantic similarity + structured field filters)
- [ ] Incremental embedding updates on file change

**Milestone:** "Find notes related to infrastructure migration from Q4" returns semantically relevant results, filterable by type and field values.

### Phase 5: Graph Traversal + Block IDs (Weeks 11–12)

**Goal:** Relationship navigation and optional sub-file addressing.

- [ ] `traverse-graph` MCP tool (N-hop traversal with type/direction filters)
- [ ] Incoming/outgoing relationship queries
- [ ] Block ID injection (Obsidian-compatible `^ve-xxxxx` syntax, opt-in)
- [ ] Block-level node creation in DB
- [ ] Block-level reference and mutation support

**Milestone:** Agent can traverse the knowledge graph: "what's connected to the CenterPoint project within 2 hops?" returns people, meetings, tasks. Block-level addressing works for users who opt in.

### Phase 6: Task Management + Workflow Tools (Weeks 13–16)

**Goal:** Higher-level tools that compose primitives into productive workflows.

- [ ] `create-meeting-notes` — creates meeting file, links attendees and project
- [ ] `extract-tasks` — parses a node's content for action items, creates linked task files
- [ ] `daily-summary` — aggregates due items, recent changes, active projects
- [ ] `overdue-tasks` — finds tasks past due date
- [ ] `project-status` — summarizes a project's tasks by status, completion %, blockers
- [ ] Error handling, edge cases, conflict resolution hardening
- [ ] Performance tuning (index speed, query latency for vaults with 1000+ files)
- [ ] Documentation + setup guide

**Milestone:** Usable daily driver. Agent can orchestrate multi-step knowledge management: "Create notes for today's CenterPoint meeting with Alice and Bob, then extract the action items as tasks and assign them."

---

## Resolved Decisions

1. **Block IDs: Obsidian-compatible `^block-id` syntax.** With engine-generated `^ve-xxxxx` prefix. Opt-out available in config for position-based fallback.

2. **Vector store: sqlite-vss preferred.** Consolidates everything into one DB file, zero extra daemons. ChromaDB available as config switch if richer vector ops needed.

3. **Schema strictness: warn, don't reject.** Files that violate schema are still indexed (they're valid markdown). Engine flags them with `is_valid: false` in the DB so queries can filter if desired.

4. **Wiki-link resolution: by title match (Obsidian convention).** Shortest unique match wins. Engine maintains a title → node_id lookup table, rebuilt on index. Explicit paths also supported.

5. **Multi-vault: not in v1.** Single vault only. Multi-vault adds cross-vault linking complexity not worth solving yet.

6. **Editor interaction: none by design.** The engine is editor-agnostic. It doesn't integrate with any editor's plugin system. It watches files on disk. Editors are viewports.

7. **Data authority: markdown is canonical.** The DB is a rebuildable index. Blow it away, re-index, and nothing is lost. Structure (types, fields, relationships) lives in frontmatter and wiki-links.

8. **Embedding model: local via ollama, pluggable.** Default to `nomic-embed-text` for local. API option (OpenAI, etc.) available for users who want better embeddings.

---

## Open Questions

1. **Field name collisions in multi-typing.** If `meeting` defines `status` as `[scheduled, completed, cancelled]` and `task` defines `status` as `[todo, in-progress, done, cancelled]`, what happens when a node has `types: [meeting, task]`? Proposed: union the enum values and warn. But this needs real-world testing.

2. **Schema migration.** When a schema definition changes (e.g., you add a field to `task`), how do existing files get updated? Options: engine adds default values to existing files on next index, or leaves them alone and just validates going forward. Propose: leave alone + warn on missing required fields.

3. **Wiki-link target creation.** If the agent writes `assignee: "[[Alice Smith]]"` but no `Alice Smith.md` exists yet, should the engine auto-create a stub file? Or leave it as a dangling reference? Propose: agent explicitly creates person nodes; dangling refs are indexed but flagged.

4. **Concurrent editing.** User edits a file in their editor while the agent is writing to the same file via a mutation tool. Current approach: write lock + hash check. May need file-level locking or operational transform for robustness. Likely fine for v1 since conflicts should be rare.

---

## Future Capabilities (Post-v1)

These are acknowledged goals but explicitly deferred. They should not drive architectural decisions for the core engine. Each should be implementable as an additional MCP tool module that composes with the existing primitives.

### Task & Project Management Tools
- Kanban-style views (rendered as auto-generated markdown files or served via MCP resource)
- Sprint/cycle management (group tasks by time period)
- Dependency tracking between tasks (`blocked_by` field)
- Recurring task generation
- Dashboard/summary generation ("what's overdue? what's due this week?")
- These build on the core `task` and `project` schemas + query tools

### Web Clipper
- Clip web pages to markdown files with metadata (URL, title, date clipped, tags)
- Clean HTML → markdown conversion (readability extraction)
- Auto-type as a `clip` schema node
- Could be an MCP tool (`clip-url`) or a separate lightweight service/bookmarklet that writes to the vault

### YouTube & Audio Transcription
- Accept a YouTube URL or audio file, transcribe via whisper.cpp or Whisper API
- Save as a markdown file with `types: [transcript]` and metadata (source URL, duration, date)
- Optional: agent summarizes the transcript and extracts action items
- Dependency: whisper.cpp or API access (not part of core engine)

### Web Search
- Agent-accessible web search via SearXNG (self-hosted) or Tavily API
- Returns structured results the agent can use to enrich nodes, answer questions, or create clip nodes
- Dependency: search service (not part of core engine, accessed as external MCP tool or direct API call)
