# Schema Types + YAML Schema Loader — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build YAML schema loader that reads `.schemas/*.yaml` from vault, resolves `extends` inheritance, and stores resolved schemas in the `schemas` DB table.

**Architecture:** New `src/schema/` module with types, loader, and re-exports. The loader reads YAML files, resolves inheritance via topological sort, and stores results as JSON in the existing `schemas` table. Integration with entry point and watcher comes last.

**Tech Stack:** TypeScript ESM, `yaml` package (already in deps), `better-sqlite3`, `vitest`

---

### Task 1: Schema TypeScript Types

**Files:**
- Create: `src/schema/types.ts`

**Step 1: Create the types file**

```typescript
// src/schema/types.ts

export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'date'
  | 'boolean'
  | 'enum'
  | 'reference'
  | 'list<string>'
  | 'list<reference>';

export interface FieldDefinition {
  type: SchemaFieldType;
  required?: boolean;
  default?: unknown;
  values?: string[];
  target_schema?: string;
}

export interface SchemaDefinition {
  name: string;
  display_name?: string;
  icon?: string;
  extends?: string;
  fields: Record<string, FieldDefinition>;
  serialization?: {
    filename_template?: string;
    frontmatter_fields?: string[];
  };
  computed?: Record<string, { query: string }>;
}

export interface ResolvedSchema {
  name: string;
  display_name?: string;
  icon?: string;
  extends?: string;
  ancestors: string[];
  fields: Record<string, FieldDefinition>;
  serialization?: {
    filename_template?: string;
    frontmatter_fields?: string[];
  };
  computed?: Record<string, { query: string }>;
}
```

**Step 2: Create the barrel export**

Create `src/schema/index.ts`:

```typescript
export type {
  SchemaFieldType,
  FieldDefinition,
  SchemaDefinition,
  ResolvedSchema,
} from './types.js';
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/schema/types.ts src/schema/index.ts
git commit -m "add schema TypeScript types"
```

---

### Task 2: YAML Fixture Files

Create fixture YAML schemas used by all subsequent tests.

**Files:**
- Create: `tests/fixtures/schemas/task.yaml`
- Create: `tests/fixtures/schemas/work-task.yaml`
- Create: `tests/fixtures/schemas/person.yaml`
- Create: `tests/fixtures/schemas/meeting.yaml`

**Step 1: Create fixture directory and files**

`tests/fixtures/schemas/task.yaml`:
```yaml
name: task
display_name: Task
icon: check

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

serialization:
  filename_template: "tasks/{{title}}.md"
  frontmatter_fields: [status, assignee, due_date, priority]
```

`tests/fixtures/schemas/work-task.yaml`:
```yaml
name: work-task
display_name: Work Task
icon: briefcase
extends: task

fields:
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
  frontmatter_fields: [status, assignee, due_date, priority, project, department, billable]
```

`tests/fixtures/schemas/person.yaml`:
```yaml
name: person
display_name: Person
icon: user

fields:
  role:
    type: string
  company:
    type: string
  email:
    type: string
  tags:
    type: list<string>

serialization:
  filename_template: "people/{{title}}.md"
  frontmatter_fields: [role, company, email, tags]
```

`tests/fixtures/schemas/meeting.yaml`:
```yaml
name: meeting
display_name: Meeting
icon: calendar

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

computed:
  action_count:
    query: "COUNT nodes WHERE types INCLUDES 'task' AND source REFERENCES this"

serialization:
  filename_template: "meetings/{{date}}-{{title}}.md"
  frontmatter_fields: [date, attendees, project, status]
```

**Step 2: Commit**

```bash
git add tests/fixtures/schemas/
git commit -m "add schema YAML fixture files"
```

---

### Task 3: Parse Single Schema (YAML -> SchemaDefinition)

**Files:**
- Create: `tests/schema/loader.test.ts`
- Create: `src/schema/loader.ts`
- Modify: `src/schema/index.ts`

**Step 1: Write the failing test**

```typescript
// tests/schema/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas, getSchema, getAllSchemas } from '../../src/schema/index.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('loadSchemas', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('parses a single schema YAML file', () => {
    loadSchemas(db, fixturesDir);

    const person = getSchema(db, 'person');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('person');
    expect(person!.display_name).toBe('Person');
    expect(person!.icon).toBe('user');
    expect(person!.extends).toBeUndefined();
    expect(person!.ancestors).toEqual([]);
    expect(person!.fields.role).toEqual({ type: 'string' });
    expect(person!.fields.email).toEqual({ type: 'string' });
    expect(person!.fields.tags).toEqual({ type: 'list<string>' });
    expect(person!.serialization?.filename_template).toBe('people/{{title}}.md');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schema/loader.test.ts`
Expected: FAIL — `loadSchemas` not exported.

**Step 3: Implement the loader**

```typescript
// src/schema/loader.ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type Database from 'better-sqlite3';
import type { SchemaDefinition, ResolvedSchema } from './types.js';

function readSchemaFiles(schemasDir: string): SchemaDefinition[] {
  if (!existsSync(schemasDir)) return [];

  const files = readdirSync(schemasDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const schemas: SchemaDefinition[] = [];

  for (const file of files) {
    const absPath = join(schemasDir, file);
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseYaml(raw);

    if (!parsed || typeof parsed.name !== 'string') {
      throw new Error(`Schema file '${absPath}' is missing required 'name' field`);
    }

    schemas.push({
      name: parsed.name,
      display_name: parsed.display_name,
      icon: parsed.icon,
      extends: parsed.extends,
      fields: parsed.fields ?? {},
      serialization: parsed.serialization,
      computed: parsed.computed,
    });
  }

  return schemas;
}

function resolveInheritance(schemas: SchemaDefinition[]): ResolvedSchema[] {
  const byName = new Map<string, SchemaDefinition>();
  for (const s of schemas) {
    byName.set(s.name, s);
  }

  // Topological sort with cycle detection
  const resolved = new Map<string, ResolvedSchema>();
  const visiting = new Set<string>();

  function resolve(name: string, chain: string[]): ResolvedSchema {
    const existing = resolved.get(name);
    if (existing) return existing;

    if (visiting.has(name)) {
      throw new Error(`Schema inheritance cycle: ${[...chain, name].join(' -> ')}`);
    }

    const def = byName.get(name);
    if (!def) {
      throw new Error(`Schema '${chain[chain.length - 1]}' extends unknown schema '${name}'`);
    }

    visiting.add(name);

    let ancestors: string[] = [];
    let inheritedFields: Record<string, typeof def.fields[string]> = {};

    if (def.extends) {
      const parent = resolve(def.extends, [...chain, name]);
      ancestors = [...parent.ancestors, parent.name];
      inheritedFields = { ...parent.fields };
    }

    const result: ResolvedSchema = {
      name: def.name,
      display_name: def.display_name,
      icon: def.icon,
      extends: def.extends,
      ancestors,
      fields: { ...inheritedFields, ...def.fields },
      serialization: def.serialization,
      computed: def.computed,
    };

    visiting.delete(name);
    resolved.set(name, result);
    return result;
  }

  for (const name of byName.keys()) {
    resolve(name, []);
  }

  return [...resolved.values()];
}

export function loadSchemas(db: Database.Database, vaultPath: string): void {
  const schemasDir = join(vaultPath, '.schemas');
  const definitions = readSchemaFiles(schemasDir);
  const resolvedSchemas = resolveInheritance(definitions);

  const run = db.transaction(() => {
    db.prepare('DELETE FROM schemas').run();

    const insert = db.prepare(
      'INSERT INTO schemas (name, definition, file_path) VALUES (?, ?, ?)'
    );
    for (const schema of resolvedSchemas) {
      insert.run(
        schema.name,
        JSON.stringify(schema),
        join('.schemas', `${schema.name}.yaml`),
      );
    }
  });

  run();
}

export function getSchema(db: Database.Database, name: string): ResolvedSchema | null {
  const row = db.prepare('SELECT definition FROM schemas WHERE name = ?').get(name) as
    | { definition: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.definition) as ResolvedSchema;
}

export function getAllSchemas(db: Database.Database): ResolvedSchema[] {
  const rows = db.prepare('SELECT definition FROM schemas ORDER BY name').all() as
    Array<{ definition: string }>;
  return rows.map(r => JSON.parse(r.definition) as ResolvedSchema);
}
```

**Step 4: Update barrel export**

Update `src/schema/index.ts`:

```typescript
export type {
  SchemaFieldType,
  FieldDefinition,
  SchemaDefinition,
  ResolvedSchema,
} from './types.js';

export { loadSchemas, getSchema, getAllSchemas } from './loader.js';
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/schema/loader.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/schema/loader.ts src/schema/index.ts tests/schema/loader.test.ts
git commit -m "add schema YAML loader with single-schema parsing"
```

---

### Task 4: Inheritance Resolution Tests

**Files:**
- Modify: `tests/schema/loader.test.ts`

**Step 1: Write the inheritance test**

Add to the `loadSchemas` describe block in `tests/schema/loader.test.ts`:

```typescript
  it('resolves single-level inheritance', () => {
    loadSchemas(db, fixturesDir);

    const workTask = getSchema(db, 'work-task');
    expect(workTask).not.toBeNull();
    expect(workTask!.extends).toBe('task');
    expect(workTask!.ancestors).toEqual(['task']);

    // Inherited fields from task
    expect(workTask!.fields.status).toEqual({
      type: 'enum',
      values: ['todo', 'in-progress', 'blocked', 'done', 'cancelled'],
      default: 'todo',
      required: true,
    });
    expect(workTask!.fields.assignee).toEqual({
      type: 'reference',
      target_schema: 'person',
    });

    // Own fields
    expect(workTask!.fields.project).toEqual({
      type: 'reference',
      target_schema: 'project',
    });
    expect(workTask!.fields.billable).toEqual({
      type: 'boolean',
      default: false,
    });
  });
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/schema/loader.test.ts`
Expected: PASS (inheritance resolution is already implemented in Task 3).

**Step 3: Write deep inheritance test**

Create additional fixture files for this test. The test will use a temporary directory with custom YAML files to avoid polluting the shared fixtures.

Add to `tests/schema/loader.test.ts`:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('inheritance resolution', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-schema-'));
    mkdirSync(join(tmpDir, '.schemas'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves deep inheritance (A extends B extends C)', () => {
    writeFileSync(join(tmpDir, '.schemas', 'base.yaml'), `
name: base
fields:
  created_by:
    type: string
  tags:
    type: list<string>
`);
    writeFileSync(join(tmpDir, '.schemas', 'task.yaml'), `
name: task
extends: base
fields:
  status:
    type: enum
    values: [todo, done]
  assignee:
    type: reference
`);
    writeFileSync(join(tmpDir, '.schemas', 'work-task.yaml'), `
name: work-task
extends: task
fields:
  project:
    type: reference
  billable:
    type: boolean
`);

    loadSchemas(db, tmpDir);
    const wt = getSchema(db, 'work-task');

    expect(wt!.ancestors).toEqual(['base', 'task']);
    // Has fields from all three levels
    expect(wt!.fields.created_by).toEqual({ type: 'string' });
    expect(wt!.fields.tags).toEqual({ type: 'list<string>' });
    expect(wt!.fields.status).toEqual({ type: 'enum', values: ['todo', 'done'] });
    expect(wt!.fields.assignee).toEqual({ type: 'reference' });
    expect(wt!.fields.project).toEqual({ type: 'reference' });
    expect(wt!.fields.billable).toEqual({ type: 'boolean' });
  });

  it('child field overrides parent field of same name', () => {
    writeFileSync(join(tmpDir, '.schemas', 'parent.yaml'), `
name: parent
fields:
  status:
    type: enum
    values: [open, closed]
    default: open
`);
    writeFileSync(join(tmpDir, '.schemas', 'child.yaml'), `
name: child
extends: parent
fields:
  status:
    type: enum
    values: [draft, review, published]
    default: draft
`);

    loadSchemas(db, tmpDir);
    const child = getSchema(db, 'child');

    expect(child!.fields.status).toEqual({
      type: 'enum',
      values: ['draft', 'review', 'published'],
      default: 'draft',
    });
  });
});
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/schema/loader.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/schema/loader.test.ts
git commit -m "add inheritance resolution tests"
```

---

### Task 5: Error Handling Tests

**Files:**
- Modify: `tests/schema/loader.test.ts`

**Step 1: Write cycle detection test**

Add to the `inheritance resolution` describe block:

```typescript
  it('detects inheritance cycle', () => {
    writeFileSync(join(tmpDir, '.schemas', 'a.yaml'), `
name: a
extends: b
fields:
  x:
    type: string
`);
    writeFileSync(join(tmpDir, '.schemas', 'b.yaml'), `
name: b
extends: a
fields:
  y:
    type: string
`);

    expect(() => loadSchemas(db, tmpDir)).toThrow(/inheritance cycle/i);
  });

  it('errors on dangling extends reference', () => {
    writeFileSync(join(tmpDir, '.schemas', 'orphan.yaml'), `
name: orphan
extends: nonexistent
fields:
  x:
    type: string
`);

    expect(() => loadSchemas(db, tmpDir)).toThrow(/extends unknown schema 'nonexistent'/);
  });

  it('errors on missing name field', () => {
    writeFileSync(join(tmpDir, '.schemas', 'bad.yaml'), `
display_name: Bad Schema
fields:
  x:
    type: string
`);

    expect(() => loadSchemas(db, tmpDir)).toThrow(/missing required 'name' field/);
  });
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/schema/loader.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/schema/loader.test.ts
git commit -m "add schema error handling tests"
```

---

### Task 6: DB Storage and Reload Tests

**Files:**
- Modify: `tests/schema/loader.test.ts`

**Step 1: Write DB storage tests**

Add to the `loadSchemas` describe block (the one using `fixturesDir`):

```typescript
  it('stores all schemas in DB and retrieves via getAllSchemas', () => {
    loadSchemas(db, fixturesDir);

    const all = getAllSchemas(db);
    const names = all.map(s => s.name).sort();
    expect(names).toEqual(['meeting', 'person', 'task', 'work-task']);
  });

  it('returns null for non-existent schema', () => {
    loadSchemas(db, fixturesDir);

    expect(getSchema(db, 'nonexistent')).toBeNull();
  });

  it('stores computed fields in schema definition', () => {
    loadSchemas(db, fixturesDir);

    const meeting = getSchema(db, 'meeting');
    expect(meeting!.computed).toBeDefined();
    expect(meeting!.computed!.action_count.query).toContain('COUNT');
  });
```

**Step 2: Write full reload test**

Add to the `inheritance resolution` describe block (the one with `tmpDir`):

```typescript
  it('full reload replaces previous schemas', () => {
    writeFileSync(join(tmpDir, '.schemas', 'alpha.yaml'), `
name: alpha
fields:
  x:
    type: string
`);
    writeFileSync(join(tmpDir, '.schemas', 'beta.yaml'), `
name: beta
fields:
  y:
    type: number
`);

    loadSchemas(db, tmpDir);
    expect(getAllSchemas(db)).toHaveLength(2);
    expect(getSchema(db, 'alpha')).not.toBeNull();

    // Remove alpha, add gamma
    rmSync(join(tmpDir, '.schemas', 'alpha.yaml'));
    writeFileSync(join(tmpDir, '.schemas', 'gamma.yaml'), `
name: gamma
fields:
  z:
    type: boolean
`);

    loadSchemas(db, tmpDir);
    const all = getAllSchemas(db);
    const names = all.map(s => s.name).sort();
    expect(names).toEqual(['beta', 'gamma']);
    expect(getSchema(db, 'alpha')).toBeNull();
  });
```

**Step 3: Write empty/missing directory tests**

Add to the `inheritance resolution` describe block:

```typescript
  it('handles empty .schemas directory', () => {
    // tmpDir already has an empty .schemas/ dir from beforeEach
    loadSchemas(db, tmpDir);
    expect(getAllSchemas(db)).toEqual([]);
  });

  it('handles missing .schemas directory', () => {
    rmSync(join(tmpDir, '.schemas'), { recursive: true, force: true });
    loadSchemas(db, tmpDir);
    expect(getAllSchemas(db)).toEqual([]);
  });
```

**Step 4: Run all tests**

Run: `npx vitest run tests/schema/loader.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add tests/schema/loader.test.ts
git commit -m "add schema DB storage and reload tests"
```

---

### Task 7: Integration — Entry Point and Watcher

**Files:**
- Modify: `src/index.ts`
- Modify: `src/sync/watcher.ts`

**Step 1: Add schema loading to entry point**

Update `src/index.ts` to call `loadSchemas` at startup. The vault path is derived from the DB path (DB lives at `<vault>/.vault-engine/vault.db`, so vault is two dirs up). If `.schemas/` doesn't exist, `loadSchemas` is a no-op.

```typescript
// src/index.ts
import { resolve, dirname } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, createSchema } from './db/index.js';
import { createServer } from './mcp/server.js';
import { loadSchemas } from './schema/index.js';

const dbPath = process.argv[2] ?? resolve(process.cwd(), '.vault-engine', 'vault.db');
const vaultPath = process.argv[3] ?? resolve(dirname(dbPath), '..');

const db = openDatabase(dbPath);
createSchema(db);
loadSchemas(db, vaultPath);

const server = createServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 2: Add `.schemas/` watching to watcher**

Update `src/sync/watcher.ts` to accept an `onSchemaChange` callback in `WatcherOptions` and set up a second watcher for `.schemas/*.yaml`:

In `src/sync/watcher.ts`, add to `WatcherOptions`:

```typescript
export interface WatcherOptions {
  debounceMs?: number;
  ignorePaths?: string[];
  onSchemaChange?: () => void;
}
```

In `watchVault`, after the main watcher setup and before the `return`, add schema watching:

```typescript
  let schemaWatcher: FSWatcher | undefined;
  if (opts?.onSchemaChange) {
    const schemasDir = join(vaultPath, '.schemas');
    const onSchemaChange = opts.onSchemaChange;

    schemaWatcher = watch(schemasDir, {
      ignoreInitial: true,
      ignored: (path: string, stats?: import('node:fs').Stats) => {
        if (!stats || stats.isDirectory()) return false;
        return !path.endsWith('.yaml') && !path.endsWith('.yml');
      },
    });

    let schemaTimer: ReturnType<typeof setTimeout> | undefined;
    const schemaDebounce = () => {
      if (schemaTimer) clearTimeout(schemaTimer);
      schemaTimer = setTimeout(() => {
        schemaTimer = undefined;
        onSchemaChange();
      }, debounceMs);
    };

    schemaWatcher.on('add', schemaDebounce);
    schemaWatcher.on('change', schemaDebounce);
    schemaWatcher.on('unlink', schemaDebounce);
  }
```

Update the `close` method to also close the schema watcher:

```typescript
  return {
    ready,
    close: async () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await watcher.close();
      if (schemaWatcher) await schemaWatcher.close();
    },
  };
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS (existing tests unchanged, new tests pass).

**Step 5: Commit**

```bash
git add src/index.ts src/sync/watcher.ts
git commit -m "integrate schema loader with entry point and watcher"
```

---

### Task 8: Final Verification

**Step 1: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS.

**Step 3: Commit any remaining changes**

If any fixups were needed, commit them.
