// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getAllSchemas, getSchema } from '../schema/loader.js';
import { mergeSchemaFields } from '../schema/merger.js';
import { validateNode } from '../schema/validator.js';
import { evaluateComputed } from '../schema/computed.js';
import type { ComputedDefinition, ValidationWarning } from '../schema/types.js';
import type { FieldEntry, FieldValueType } from '../parser/types.js';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFile } from '../parser/index.js';
import { serializeNode, computeFieldOrder, generateFilePath, writeNodeFile, deleteNodeFile, sanitizeSegment } from '../serializer/index.js';
import { indexFile, deleteFile } from '../sync/indexer.js';
import { updateBodyReferences, updateFrontmatterReferences } from './rename-helpers.js';
import { resolveReferences } from '../sync/resolver.js';

export function createServer(db: Database.Database, vaultPath: string): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });

  // Shared helper: hydrate node rows with types and fields
  function hydrateNodes(
    nodeRows: Array<{ id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string }>,
    opts?: { includeContentMd?: boolean },
  ) {
    if (nodeRows.length === 0) return [];

    const nodeIds = nodeRows.map(r => r.id);
    const placeholders = nodeIds.map(() => '?').join(',');

    const typeRows = db.prepare(
      `SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`
    ).all(...nodeIds) as Array<{ node_id: string; schema_type: string }>;

    const fieldRows = db.prepare(
      `SELECT node_id, key, value_text FROM fields WHERE node_id IN (${placeholders})`
    ).all(...nodeIds) as Array<{ node_id: string; key: string; value_text: string }>;

    const typesMap = new Map<string, string[]>();
    for (const row of typeRows) {
      const arr = typesMap.get(row.node_id) ?? [];
      arr.push(row.schema_type);
      typesMap.set(row.node_id, arr);
    }

    const fieldsMap = new Map<string, Record<string, string>>();
    for (const row of fieldRows) {
      const rec = fieldsMap.get(row.node_id) ?? {};
      rec[row.key] = row.value_text;
      fieldsMap.set(row.node_id, rec);
    }

    return nodeRows.map(row => {
      const node: Record<string, unknown> = {
        id: row.id,
        file_path: row.file_path,
        node_type: row.node_type,
        types: typesMap.get(row.id) ?? [],
        fields: fieldsMap.get(row.id) ?? {},
        content_text: row.content_text,
        updated_at: row.updated_at,
      };
      if (opts?.includeContentMd) {
        node.content_md = row.content_md;
      }
      return node;
    });
  }

  function loadNodeForValidation(nodeId: string): { types: string[]; fields: FieldEntry[] } | null {
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId) as { id: string } | undefined;
    if (!node) return null;

    const typeRows = db.prepare(
      'SELECT schema_type FROM node_types WHERE node_id = ?'
    ).all(nodeId) as Array<{ schema_type: string }>;
    const types = typeRows.map(r => r.schema_type);

    const fieldRows = db.prepare(
      'SELECT key, value_text, value_type, value_number, value_date FROM fields WHERE node_id = ?'
    ).all(nodeId) as Array<{ key: string; value_text: string; value_type: string; value_number: number | null; value_date: string | null }>;

    const fields: FieldEntry[] = fieldRows.map(r => {
      let value: unknown = r.value_text;
      const valueType = r.value_type as FieldValueType;
      if (valueType === 'number' && r.value_number !== null) value = r.value_number;
      else if (valueType === 'date' && r.value_date) value = new Date(r.value_date);
      else if (valueType === 'boolean') value = r.value_text === 'true';
      else if (valueType === 'list' && r.value_text) {
        try { value = JSON.parse(r.value_text); } catch { /* keep as string */ }
      }
      return { key: r.key, value, valueType };
    });

    return { types, fields };
  }

  function inferFieldType(value: unknown): FieldValueType {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (value instanceof Date) return 'date';
    if (Array.isArray(value)) return 'list';
    if (typeof value === 'string' && /^\[\[.+\]\]$/.test(value)) return 'reference';
    return 'string';
  }

  function createNode(params: {
    title: string;
    types: string[];
    fields: Record<string, unknown>;
    body?: string;
    parent_path?: string;
    relationships: Array<{ target: string; rel_type: string }>;
  }) {
    const { title, types, body: inputBody, parent_path, relationships } = params;
    const fields = { ...params.fields };
    let body = inputBody ?? '';

    // Step 1: Validate against schemas (if any types have schemas)
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);
    let mergeResult = hasSchemas ? mergeSchemaFields(db, types) : null;
    let warnings: ValidationWarning[] = [];

    if (mergeResult) {
      const parsed = {
        filePath: 'pending',
        frontmatter: {},
        types,
        fields: Object.entries(fields).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        })),
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const validation = validateNode(parsed, mergeResult);
      warnings = validation.warnings;
    }

    // Step 2: Process relationships
    for (const rel of relationships) {
      const target = rel.target.startsWith('[[') ? rel.target : `[[${rel.target}]]`;

      // Check if rel_type is a schema field
      const mergedField = mergeResult?.fields[rel.rel_type];
      if (mergedField) {
        const isListType = mergedField.type.startsWith('list<');
        if (isListType) {
          const existing = fields[rel.rel_type];
          if (Array.isArray(existing)) {
            existing.push(target);
          } else {
            fields[rel.rel_type] = [target];
          }
        } else {
          fields[rel.rel_type] = target;
        }
      } else if (!hasSchemas && Array.isArray(fields[rel.rel_type])) {
        // Schema-less fallback: check if existing value is an array
        (fields[rel.rel_type] as unknown[]).push(target);
      } else if (!hasSchemas && rel.rel_type in fields) {
        // Schema-less scalar field
        fields[rel.rel_type] = target;
      } else {
        // No matching field — append to body
        body = body ? `${body}\n\n${target}` : target;
      }
    }

    // Step 3: Compute field order
    const fieldOrder = computeFieldOrder(types, db);

    // Step 4: Serialize
    const content = serializeNode({ title, types, fields, body: body || undefined, fieldOrder });

    // Step 5: Generate path
    let relativePath: string;
    if (parent_path) {
      const sanitized = sanitizeSegment(title);
      const prefix = parent_path.endsWith('/') ? parent_path : `${parent_path}/`;
      relativePath = `${prefix}${sanitized}.md`;
    } else {
      relativePath = generateFilePath(title, types, fields, db);
    }

    // Step 6: Check existence
    if (existsSync(join(vaultPath, relativePath))) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: File already exists at ${relativePath}. Use update-node to modify existing nodes or choose a different title.`,
        }],
        isError: true,
      };
    }

    // Step 7: Write
    writeNodeFile(vaultPath, relativePath, content);

    // Step 8: Stat for mtime
    const stat = statSync(join(vaultPath, relativePath));
    const mtime = stat.mtime.toISOString();

    // Step 9: Parse + index + resolve refs in transaction
    const parsed = parseFile(relativePath, content);
    db.transaction(() => {
      indexFile(db, parsed, relativePath, mtime, content);
      resolveReferences(db);
    })();

    // Step 10: Return hydrated node + warnings
    const row = db.prepare(`
      SELECT id, file_path, node_type, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(relativePath) as {
      id: string; file_path: string; node_type: string;
      content_text: string; content_md: string | null; updated_at: string;
    };

    const [node] = hydrateNodes([row]);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node, warnings }) }],
    };
  }

  function updateNode(params: {
    node_id: string;
    fields?: Record<string, unknown>;
    body?: string;
    append_body?: string;
  }) {
    const { node_id, fields: fieldUpdates, body: newBody, append_body } = params;

    // Param validation
    if (!fieldUpdates && newBody === undefined && append_body === undefined) {
      return {
        content: [{ type: 'text' as const, text: 'Error: No updates provided: at least one of fields, body, or append_body is required' }],
        isError: true,
      };
    }
    if (newBody !== undefined && append_body !== undefined) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Cannot provide both body and append_body — they are mutually exclusive' }],
        isError: true,
      };
    }

    // Check node exists in DB
    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id);
    if (!nodeRow) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${node_id}` }],
        isError: true,
      };
    }

    // Check file exists on disk
    const absPath = join(vaultPath, node_id);
    if (!existsSync(absPath)) {
      return {
        content: [{ type: 'text' as const, text: `Error: File not found on disk: ${node_id}. Database and filesystem are out of sync.` }],
        isError: true,
      };
    }

    // Read existing file
    const raw = readFileSync(absPath, 'utf-8');

    // Parse existing file
    const parsed = parseFile(node_id, raw);

    // Extract title and types (immutable in update-node)
    const title = typeof parsed.frontmatter.title === 'string'
      ? parsed.frontmatter.title
      : node_id.replace(/\.md$/, '').split('/').pop()!;
    const types = parsed.types;

    // Merge fields: existing (excluding meta-keys) + updates
    const mergedFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (key === 'title' || key === 'types') continue;
      mergedFields[key] = value;
    }
    if (fieldUpdates) {
      for (const [key, value] of Object.entries(fieldUpdates)) {
        if (key === 'title' || key === 'types') continue;
        if (value === null) {
          delete mergedFields[key];
        } else {
          mergedFields[key] = value;
        }
      }
    }

    // Resolve body
    let body: string;
    if (newBody !== undefined) {
      body = newBody;
    } else if (append_body !== undefined) {
      body = parsed.contentMd ? `${parsed.contentMd}\n\n${append_body}` : append_body;
    } else {
      body = parsed.contentMd;
    }

    // Validate against schemas
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);
    let warnings: ValidationWarning[] = [];

    if (hasSchemas) {
      const mergeResult = mergeSchemaFields(db, types);
      const forValidation = {
        filePath: node_id,
        frontmatter: {},
        types,
        fields: Object.entries(mergedFields).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        })),
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const validation = validateNode(forValidation, mergeResult);
      warnings = validation.warnings;
    }

    // Compute field order + serialize
    const fieldOrder = computeFieldOrder(types, db);
    const content = serializeNode({
      title,
      types,
      fields: mergedFields,
      body: body || undefined,
      fieldOrder,
    });

    // Write file (same path — update in place)
    writeNodeFile(vaultPath, node_id, content);

    // Stat for mtime
    const stat = statSync(absPath);
    const mtime = stat.mtime.toISOString();

    // Parse + index + resolve refs in transaction
    const reParsed = parseFile(node_id, content);
    db.transaction(() => {
      indexFile(db, reParsed, node_id, mtime, content);
      resolveReferences(db);
    })();

    // Return hydrated node + warnings
    const row = db.prepare(`
      SELECT id, file_path, node_type, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(node_id) as {
      id: string; file_path: string; node_type: string;
      content_text: string; content_md: string | null; updated_at: string;
    };

    const [node] = hydrateNodes([row]);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node, warnings }) }],
    };
  }

  function returnCurrentNode(nodeId: string) {
    const row = db.prepare(`
      SELECT id, file_path, node_type, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(nodeId) as {
      id: string; file_path: string; node_type: string;
      content_text: string; content_md: string | null; updated_at: string;
    } | undefined;
    if (!row) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${nodeId}` }],
        isError: true,
      };
    }
    const [node] = hydrateNodes([row]);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node, warnings: [] }) }],
    };
  }

  function addRelationship(params: {
    source_id: string;
    target: string;
    rel_type: string;
  }) {
    const { source_id, target: rawTarget, rel_type } = params;
    const target = rawTarget.startsWith('[[') ? rawTarget : `[[${rawTarget}]]`;

    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(source_id);
    if (!nodeRow) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${source_id}` }],
        isError: true,
      };
    }

    const absPath = join(vaultPath, source_id);
    if (!existsSync(absPath)) {
      return {
        content: [{ type: 'text' as const, text: `Error: File not found on disk: ${source_id}. Database and filesystem are out of sync.` }],
        isError: true,
      };
    }

    // Read + parse existing file
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseFile(source_id, raw);
    const types = parsed.types;

    // Extract inner target for comparison (strips [[ ]] and alias)
    const innerTarget = target.match(/^\[\[([^\]|]+)/)?.[1] ?? '';

    // Force body if rel_type is 'wiki-link'
    if (rel_type === 'wiki-link') {
      const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
      if (bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
        return returnCurrentNode(source_id);
      }
      return updateNode({ node_id: source_id, append_body: target });
    }

    // Check schemas
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);

    if (hasSchemas) {
      const mergeResult = mergeSchemaFields(db, types);
      const mergedField = mergeResult.fields[rel_type];

      if (mergedField) {
        const isListType = mergedField.type.startsWith('list<');
        if (isListType) {
          const existing = parsed.frontmatter[rel_type];
          const currentArray: unknown[] = Array.isArray(existing) ? existing : (existing != null ? [existing] : []);
          const alreadyExists = currentArray.some((item: unknown) => {
            if (typeof item !== 'string') return false;
            const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
            return inner != null && inner.toLowerCase() === innerTarget.toLowerCase();
          });
          if (alreadyExists) {
            return returnCurrentNode(source_id);
          }
          return updateNode({
            node_id: source_id,
            fields: { [rel_type]: [...currentArray, target] },
          });
        } else {
          // Scalar field
          return updateNode({
            node_id: source_id,
            fields: { [rel_type]: target },
          });
        }
      }
    }

    // Schema-less fallback: check existing frontmatter
    if (!hasSchemas && rel_type !== 'title' && rel_type !== 'types') {
      const existing = parsed.frontmatter[rel_type];
      if (Array.isArray(existing)) {
        const alreadyExists = existing.some((item: unknown) => {
          if (typeof item !== 'string') return false;
          const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
          return inner != null && inner.toLowerCase() === innerTarget.toLowerCase();
        });
        if (alreadyExists) {
          return returnCurrentNode(source_id);
        }
        return updateNode({
          node_id: source_id,
          fields: { [rel_type]: [...existing, target] },
        });
      } else if (rel_type in parsed.frontmatter) {
        return updateNode({
          node_id: source_id,
          fields: { [rel_type]: target },
        });
      }
    }

    // Body fallback
    const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
    if (bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
      return returnCurrentNode(source_id);
    }
    return updateNode({ node_id: source_id, append_body: target });
  }

  server.tool(
    'add-relationship',
    'Add a relationship from one node to another. Routes to frontmatter field or body wiki-link based on schema.',
    {
      source_id: z.string().describe('Vault-relative file path of the source node, e.g. "tasks/review.md"'),
      target: z.string().describe('Wiki-link target, e.g. "Alice" or "[[Alice]]"'),
      rel_type: z.string().describe('Relationship type — schema field name for frontmatter, or "wiki-link" for body'),
    },
    async (params) => {
      try {
        return addRelationship(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  function renameNode(params: {
    node_id: string;
    new_title: string;
    new_path?: string;
  }) {
    const { node_id, new_title, new_path: explicitNewPath } = params;

    // Check node exists in DB
    const nodeRow = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(node_id) as
      | { id: string; title: string }
      | undefined;
    if (!nodeRow) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${node_id}` }],
        isError: true,
      };
    }

    // Check file exists on disk
    const absPath = join(vaultPath, node_id);
    if (!existsSync(absPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: File not found on disk: ${node_id}. Database and filesystem are out of sync.`,
        }],
        isError: true,
      };
    }

    // Read + parse existing file
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseFile(node_id, raw);
    const oldTitle = typeof parsed.frontmatter.title === 'string'
      ? parsed.frontmatter.title
      : node_id.replace(/\.md$/, '').split('/').pop()!;
    const types = parsed.types;

    // No-op: same title, no explicit new path
    if (new_title === oldTitle && !explicitNewPath) {
      return returnCurrentNode(node_id);
    }

    // Extract existing fields (exclude meta-keys)
    const existingFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (key === 'title' || key === 'types') continue;
      existingFields[key] = value;
    }

    // Derive new path
    const newPath = explicitNewPath ?? generateFilePath(new_title, types, existingFields, db);

    // Check new path doesn't collide (unless same path)
    if (newPath !== node_id && existsSync(join(vaultPath, newPath))) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: File already exists at ${newPath}. Use a different title or provide an explicit new_path.`,
        }],
        isError: true,
      };
    }

    // TODO: implement rename pipeline (Tasks 4-5)
    return returnCurrentNode(node_id);
  }

  server.tool(
    'rename-node',
    'Rename a node and update all wiki-link references to it across the vault.',
    {
      node_id: z.string().describe('Vault-relative file path of the node to rename, e.g. "people/alice.md"'),
      new_title: z.string().describe('New title for the node'),
      new_path: z.string().optional()
        .describe('Explicit new file path. If omitted, derived from new_title via schema filename_template.'),
    },
    async (params) => {
      try {
        return renameNode(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'list-types',
    'List all node types found in the vault with their counts',
    {},
    async () => {
      const rows = db.prepare(`
        SELECT schema_type AS name, COUNT(*) AS count
        FROM node_types
        GROUP BY schema_type
        ORDER BY schema_type
      `).all() as Array<{ name: string; count: number }>;

      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    },
  );

  server.tool(
    'get-node',
    'Get full details of a specific node by its ID (vault-relative file path)',
    {
      node_id: z.string().describe('Vault-relative file path, e.g. "tasks/review.md"'),
      include_relationships: z.boolean().optional().default(false)
        .describe('Include incoming and outgoing relationships'),
      include_computed: z.boolean().optional().default(false)
        .describe('Include computed field values from schema definitions'),
    },
    async ({ node_id, include_relationships, include_computed }) => {
      const row = db.prepare(`
        SELECT id, file_path, node_type, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(node_id) as { id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return {
          content: [{ type: 'text', text: `Error: Node not found: ${node_id}` }],
          isError: true,
        };
      }

      const [node] = hydrateNodes([row], { includeContentMd: true });

      if (include_relationships) {
        const rels = db.prepare(`
          SELECT source_id, target_id, rel_type, context
          FROM relationships
          WHERE source_id = ? OR target_id = ?
        `).all(node_id, node_id) as Array<{ source_id: string; target_id: string; rel_type: string; context: string | null }>;

        (node as Record<string, unknown>).relationships = rels;
      }

      if (include_computed) {
        const nodeTypes = (node as Record<string, unknown>).types as string[];
        const allComputedDefs: Record<string, ComputedDefinition> = {};
        for (const typeName of nodeTypes) {
          const schema = getSchema(db, typeName);
          if (schema?.computed) {
            Object.assign(allComputedDefs, schema.computed);
          }
        }
        const computed = Object.keys(allComputedDefs).length > 0
          ? evaluateComputed(db, node_id, allComputedDefs)
          : {};
        (node as Record<string, unknown>).computed = computed;
      }

      return { content: [{ type: 'text', text: JSON.stringify(node) }] };
    },
  );

  server.tool(
    'get-recent',
    'Get recently created or modified nodes',
    {
      schema_type: z.string().optional()
        .describe('Filter by schema type, e.g. "task", "meeting"'),
      since: z.string().optional()
        .describe('ISO date — only return nodes updated after this time'),
      limit: z.number().optional().default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({ schema_type, since, limit }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let joinType = '';

      if (schema_type) {
        joinType = 'JOIN node_types nt ON nt.node_id = n.id';
        conditions.push('nt.schema_type = ?');
        params.push(schema_type);
      }

      if (since) {
        conditions.push('n.updated_at > ?');
        params.push(since);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      const rows = db.prepare(`
        SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at
        FROM nodes n
        ${joinType}
        ${where}
        ORDER BY n.updated_at DESC
        LIMIT ?
      `).all(...params) as Array<{ id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string }>;

      const nodes = hydrateNodes(rows);
      return { content: [{ type: 'text', text: JSON.stringify(nodes) }] };
    },
  );

  server.tool(
    'query-nodes',
    'Search for nodes by type, field values, and/or full text. At least one of schema_type, full_text, or filters is required.',
    {
      schema_type: z.string().optional()
        .describe('Schema type to filter by, e.g. "task", "project", "meeting"'),
      full_text: z.string().optional()
        .describe('Full-text search query (FTS5 syntax: supports "quoted phrases", prefix*, AND/OR)'),
      filters: z.array(z.object({
        field: z.string().describe('Field name, e.g. "status", "assignee"'),
        operator: z.enum(['eq']).describe('Comparison operator: eq (equals)'),
        value: z.string().describe('Value to compare against'),
      })).optional()
        .describe('Field equality filters'),
      limit: z.number().optional().default(20)
        .describe('Maximum number of results (default 20)'),
      order_by: z.string().optional()
        .describe('Sort field + direction, e.g. "updated_at DESC", "due_date ASC". Default: updated_at DESC (or FTS rank when full_text is used)'),
    },
    async ({ schema_type, full_text, filters, limit, order_by }) => {
      if (!schema_type && !full_text && (!filters || filters.length === 0)) {
        return {
          content: [{ type: 'text', text: 'Error: At least one of schema_type, full_text, or filters is required' }],
          isError: true,
        };
      }

      try {
        const joins: string[] = [];
        const conditions: string[] = [];
        const params: unknown[] = [];

        // FTS path
        let selectFrom: string;
        let defaultOrder: string;
        if (full_text) {
          selectFrom = `
            SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at, fts.rank
            FROM nodes_fts fts
            JOIN nodes n ON n.rowid = fts.rowid`;
          conditions.push('nodes_fts MATCH ?');
          params.push(full_text);
          defaultOrder = 'fts.rank';
        } else {
          selectFrom = `
            SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at
            FROM nodes n`;
          defaultOrder = 'n.updated_at DESC';
        }

        // Type filter
        if (schema_type) {
          joins.push('JOIN node_types nt ON nt.node_id = n.id');
          conditions.push('nt.schema_type = ?');
          params.push(schema_type);
        }

        // Field equality filters
        if (filters) {
          for (let i = 0; i < filters.length; i++) {
            const alias = `f${i}`;
            joins.push(`JOIN fields ${alias} ON ${alias}.node_id = n.id`);
            conditions.push(`${alias}.key = ? AND ${alias}.value_text = ?`);
            params.push(filters[i].field, filters[i].value);
          }
        }

        // Order by
        let orderClause: string;
        if (order_by && !full_text) {
          // Parse "field_name ASC" or "field_name DESC" or just "field_name"
          const parts = order_by.trim().split(/\s+/);
          const fieldName = parts[0];
          const direction = parts[1]?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

          if (fieldName === 'updated_at') {
            orderClause = `n.updated_at ${direction}`;
          } else {
            // Order by a field value — join fields table
            joins.push('LEFT JOIN fields f_order ON f_order.node_id = n.id AND f_order.key = ?');
            params.push(fieldName);
            orderClause = `f_order.value_text ${direction}`;
          }
        } else {
          orderClause = defaultOrder;
        }

        params.push(limit);

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `${selectFrom}\n${joins.join('\n')}\n${where}\nORDER BY ${orderClause}\nLIMIT ?`;

        const rows = db.prepare(sql).all(...params) as Array<{
          id: string; file_path: string; node_type: string;
          content_text: string; content_md: string | null; updated_at: string;
        }>;

        const nodes = hydrateNodes(rows);
        return { content: [{ type: 'text', text: JSON.stringify(nodes) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'list-schemas',
    'List all schema definitions loaded from YAML. Shows what structure is defined, as opposed to list-types which shows what types nodes actually have.',
    {},
    async () => {
      const schemas = getAllSchemas(db);
      const summaries = schemas.map(s => ({
        name: s.name,
        display_name: s.display_name ?? null,
        icon: s.icon ?? null,
        extends: s.extends ?? null,
        ancestors: s.ancestors,
        field_count: Object.keys(s.fields).length,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summaries) }] };
    },
  );

  server.tool(
    'describe-schema',
    'Get the full definition of a schema including inherited fields, field types, and constraints',
    {
      schema_name: z.string().describe('Schema name, e.g. "task", "work-task"'),
    },
    async ({ schema_name }) => {
      const schema = getSchema(db, schema_name);
      if (!schema) {
        return {
          content: [{ type: 'text', text: `Error: Schema not found: ${schema_name}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(schema) }] };
    },
  );

  server.tool(
    'validate-node',
    'Validate a node against its schemas. Provide node_id for an existing node, or types + fields for hypothetical validation.',
    {
      node_id: z.string().optional()
        .describe('Validate an existing node by its ID (vault-relative path)'),
      types: z.array(z.string()).optional()
        .describe('Schema types for hypothetical validation, e.g. ["task", "meeting"]'),
      fields: z.record(z.string(), z.unknown()).optional()
        .describe('Field values for hypothetical validation, e.g. { "status": "todo" }'),
    },
    async ({ node_id, types, fields: hypotheticalFields }) => {
      if (!node_id && !types) {
        return {
          content: [{ type: 'text', text: 'Error: Provide node_id or types (with optional fields)' }],
          isError: true,
        };
      }

      let nodeTypes: string[];
      let fieldEntries: FieldEntry[];

      if (node_id) {
        const loaded = loadNodeForValidation(node_id);
        if (!loaded) {
          return {
            content: [{ type: 'text', text: `Error: Node not found: ${node_id}` }],
            isError: true,
          };
        }
        nodeTypes = loaded.types;
        fieldEntries = loaded.fields;
      } else {
        nodeTypes = types!;
        fieldEntries = Object.entries(hypotheticalFields ?? {}).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        }));
      }

      // If no types have schemas, nothing to validate
      const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
      const hasKnownSchema = nodeTypes.some(t => schemaCheck.get(t) !== undefined);
      if (!hasKnownSchema) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ valid: true, warnings: [] }) }],
        };
      }

      const merge = mergeSchemaFields(db, nodeTypes);
      const parsed = {
        filePath: node_id ?? 'hypothetical',
        frontmatter: {},
        types: nodeTypes,
        fields: fieldEntries,
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const result = validateNode(parsed, merge);

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'create-node',
    'Create a new node as a markdown file with frontmatter. Validates against schemas, writes to disk, and indexes.',
    {
      title: z.string().describe('Node title (required)'),
      types: z.array(z.string()).optional().default([])
        .describe('Schema types, e.g. ["task"] or ["task", "meeting"]'),
      fields: z.record(z.string(), z.unknown()).optional().default({})
        .describe('Field values, e.g. { "status": "todo", "assignee": "[[Bob]]" }'),
      body: z.string().optional()
        .describe('Markdown body content'),
      parent_path: z.string().optional()
        .describe('Override path: file created at <parent_path>/<title>.md instead of schema template'),
      relationships: z.array(z.object({
        target: z.string().describe('Wiki-link target, e.g. "Bob" or "[[Bob]]"'),
        rel_type: z.string().describe('Relationship type — schema field name for frontmatter, or appended to body'),
      })).optional().default([])
        .describe('Relationships to create with the node'),
    },
    async (params) => {
      try {
        return createNode(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'update-node',
    'Update an existing node\'s fields and/or body content. Fields are merged (not replaced); set a field to null to remove it.',
    {
      node_id: z.string().describe('Vault-relative file path of the node to update, e.g. "tasks/review.md"'),
      fields: z.record(z.string(), z.unknown()).optional()
        .describe('Fields to update (merged with existing). Set a value to null to remove a field.'),
      body: z.string().optional()
        .describe('Replace the entire body content'),
      append_body: z.string().optional()
        .describe('Append to existing body content'),
    },
    async (params) => {
      try {
        return updateNode(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
