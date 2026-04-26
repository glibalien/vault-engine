const WIKILINK_UNSAFE = ['(', ')', '[', ']', '|', '#', '^'];

export type ToolIssueCode =
  | 'TITLE_WIKILINK_UNSAFE'
  | 'FRONTMATTER_IN_BODY'
  | 'TYPE_OP_CONFLICT'
  | 'TITLE_FILENAME_SANITIZED';

export interface ToolIssue {
  code: ToolIssueCode;
  message: string;
  characters?: string[];
}

export function checkTitleSafety(title: string): ToolIssue[] {
  const found = WIKILINK_UNSAFE.filter(ch => title.includes(ch));
  if (found.length === 0) return [];
  return [{
    code: 'TITLE_WIKILINK_UNSAFE',
    message: `Title contains characters that may break Obsidian wiki-links: ${found.join(' ')}`,
    characters: found,
  }];
}

const FILENAME_UNSAFE = ['/', '\\'];

export interface SanitizeResult {
  filename: string;
  sanitized: boolean;
  characters: string[];
}

export function sanitizeFilename(name: string): SanitizeResult {
  const found = FILENAME_UNSAFE.filter(ch => name.includes(ch));
  if (found.length === 0) {
    return { filename: name, sanitized: false, characters: [] };
  }
  let out = name;
  for (const ch of FILENAME_UNSAFE) {
    out = out.split(ch).join('-');
  }
  return { filename: out, sanitized: true, characters: found };
}

export function checkBodyFrontmatter(body: string): ToolIssue[] {
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    return [{
      code: 'FRONTMATTER_IN_BODY',
      message: 'Body appears to start with a YAML frontmatter block. Structured fields should be passed via the fields parameter, not embedded in body.',
    }];
  }
  return [];
}
