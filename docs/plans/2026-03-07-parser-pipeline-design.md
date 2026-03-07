# Parser Pipeline Design

## Decision

**Approach A:** unified/remark for full-file MDAST (with `remarkFrontmatter`) + gray-matter for YAML parsing + custom regex for wiki-link extraction in both frontmatter and body.

### Why Approach A

- Correct MDAST positions relative to source file (needed for `position_start`/`position_end` in DB)
- Full-file round-trip via remark-stringify available for future phases
- No redundancy: remark recognizes frontmatter exists, gray-matter interprets the YAML content
- Wiki-links via custom regex (one code path) rather than a low-activity npm plugin

## Data Flow

```
raw .md file
    │
    ├──► unified/remark pipeline (remarkParse + remarkFrontmatter)
    │        → MDAST with correct positions
    │
    ├──► gray-matter(raw)
    │        → { data: {title, types, status, ...}, content: "body" }
    │
    ├──► extractWikiLinks(data) → frontmatter wiki-links with field context
    │        e.g. { target: "Bob Jones", field: "assignee" }
    │
    ├──► extractWikiLinks(mdast) → body wiki-links with surrounding text
    │        e.g. { target: "Acme Corp Proposal", context: "Read proposal from..." }
    │
    └──► combined into ParsedFile
```

## Output Types

```typescript
interface ParsedFile {
  filePath: string;
  frontmatter: Record<string, unknown>;
  types: string[];
  fields: FieldEntry[];
  wikiLinks: WikiLink[];
  mdast: Root;
  contentText: string;  // plain text for FTS (body only)
  contentMd: string;    // raw markdown of body
}

interface WikiLink {
  target: string;
  alias?: string;
  source: 'frontmatter' | 'body';
  field?: string;
  context?: string;
  position?: Position;
}

interface FieldEntry {
  key: string;
  value: unknown;
  valueType: 'string' | 'number' | 'date' | 'boolean' | 'reference' | 'list';
}
```

## Module Structure

- `src/parser/markdown.ts` — `parseMarkdown(raw: string): Root` — unified pipeline
- `src/parser/frontmatter.ts` — `parseFrontmatter(raw: string)` — gray-matter wrapper, type inference, FieldEntry construction
- `src/parser/wiki-links.ts` — `extractWikiLinks()` — regex extraction from frontmatter values and MDAST text nodes
- `src/parser/index.ts` — `parseFile(filePath, raw): ParsedFile` — orchestrates above

## Field Type Inference

| YAML value | Inferred valueType |
|---|---|
| `"[[Bob Jones]]"` | `reference` |
| `["[[Alice]]", "[[Bob]]"]` | `list` |
| `2025-03-10` (date pattern) | `date` |
| `42` or `3.14` | `number` |
| `true` / `false` | `boolean` |
| anything else | `string` |

## Wiki-Link Regex

Single pattern for both frontmatter and body: `\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`

- Captures target and optional alias from `[[target]]` and `[[target|alias]]`
- Applied to YAML string values (frontmatter) and MDAST text nodes (body)

## Plain Text Extraction

Walk MDAST, concatenate text node values, strip `[[`/`]]` from wiki-links. Used for FTS indexing.
