const WIKILINK_UNSAFE = ['(', ')', '[', ']', '|', '#', '^'];

export interface ToolIssue {
  code: string;
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

export function checkBodyFrontmatter(body: string): ToolIssue[] {
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    return [{
      code: 'FRONTMATTER_IN_BODY',
      message: 'Body appears to start with a YAML frontmatter block. Structured fields should be passed via the fields parameter, not embedded in body.',
    }];
  }
  return [];
}
