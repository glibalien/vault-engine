import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseFile } from '../../src/parser/index.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('parseFile', () => {
  it('returns a complete ParsedFile for a task', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    expect(result.filePath).toBe('tasks/Review vendor proposals.md');
    expect(result.types).toEqual(['task']);
    expect(result.frontmatter.title).toBe('Review vendor proposals');
    expect(result.frontmatter.status).toBe('todo');
  });

  it('combines frontmatter and body wiki-links', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    const frontmatterLinks = result.wikiLinks.filter(l => l.source === 'frontmatter');
    const bodyLinks = result.wikiLinks.filter(l => l.source === 'body');

    // Frontmatter: assignee [[Bob Jones]], source [[Q1 Planning Meeting]]
    expect(frontmatterLinks.map(l => l.target)).toContain('Bob Jones');
    expect(frontmatterLinks.map(l => l.target)).toContain('Q1 Planning Meeting');

    // Body: [[Acme Corp Proposal]], [[Globex Proposal]], [[Alice Smith]]
    expect(bodyLinks.map(l => l.target)).toContain('Acme Corp Proposal');
    expect(bodyLinks.map(l => l.target)).toContain('Globex Proposal');
    expect(bodyLinks.map(l => l.target)).toContain('Alice Smith');
  });

  it('produces contentText without markdown syntax or [[ ]]', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    expect(result.contentText).toContain('Review the three vendor proposals');
    expect(result.contentText).toContain('Alice Smith');
    expect(result.contentText).not.toContain('[[');
    expect(result.contentText).not.toContain('title:');
  });

  it('produces contentMd as the body markdown', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    expect(result.contentMd).toContain('[[Acme Corp Proposal]]');
    expect(result.contentMd).not.toContain('title:');
  });

  it('handles multi-typed nodes', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-meeting.md'), 'utf-8');
    const result = parseFile('meetings/Q1 Planning Meeting.md', raw);

    expect(result.types).toEqual(['meeting', 'task']);
  });

  it('includes field entries excluding title and types', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-person.md'), 'utf-8');
    const result = parseFile('people/Alice Smith.md', raw);

    const keys = result.fields.map(f => f.key);
    expect(keys).toContain('role');
    expect(keys).toContain('company');
    expect(keys).toContain('email');
    expect(keys).toContain('tags');
    expect(keys).not.toContain('title');
    expect(keys).not.toContain('types');
  });

  it('has a valid MDAST with correct positions', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    expect(result.mdast.type).toBe('root');
    const yamlNode = result.mdast.children.find((n: any) => n.type === 'yaml');
    expect(yamlNode?.position?.start.line).toBe(1);
  });

  it('handles a file with no frontmatter', () => {
    const raw = 'Just a plain note with [[a link]].';
    const result = parseFile('notes/plain.md', raw);

    expect(result.types).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.wikiLinks).toHaveLength(1);
    expect(result.wikiLinks[0].target).toBe('a link');
    expect(result.contentText).toContain('a link');
  });
});
