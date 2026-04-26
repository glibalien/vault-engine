import { describe, it, expect } from 'vitest';
import { ok, fail, adaptIssue } from '../../src/mcp/tools/errors.js';
import type { ValidationIssue } from '../../src/validation/types.js';
import type { ToolIssue } from '../../src/mcp/tools/title-warnings.js';

function parseEnvelope(result: { content: Array<{ type: 'text'; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('ok()', () => {
  it('wraps data with empty warnings by default', () => {
    const env = parseEnvelope(ok({ foo: 1 }));
    expect(env).toEqual({ ok: true, data: { foo: 1 }, warnings: [] });
  });

  it('includes provided warnings', () => {
    const warnings = [{ code: 'DEPRECATED_PARAM' as const, message: 'm', severity: 'warning' as const }];
    const env = parseEnvelope(ok({ foo: 1 }, warnings));
    expect(env).toEqual({ ok: true, data: { foo: 1 }, warnings });
  });

  it('handles array data (read-only bare-array tools)', () => {
    const env = parseEnvelope(ok([1, 2, 3]));
    expect(env).toEqual({ ok: true, data: [1, 2, 3], warnings: [] });
  });
});

describe('fail()', () => {
  it('wraps error code + message with empty warnings and no details', () => {
    const env = parseEnvelope(fail('NOT_FOUND', 'missing'));
    expect(env).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'missing' },
      warnings: [],
    });
  });

  it('includes details when provided', () => {
    const env = parseEnvelope(fail('UNKNOWN_TYPE', 'bad type', {
      details: { unknown_types: ['X'], available_schemas: ['A', 'B'] },
    }));
    expect(env.error.details).toEqual({ unknown_types: ['X'], available_schemas: ['A', 'B'] });
  });

  it('includes warnings when provided', () => {
    const warnings = [{ code: 'DEPRECATED_PARAM' as const, message: 'm', severity: 'warning' as const }];
    const env = parseEnvelope(fail('INVALID_PARAMS', 'bad', { warnings }));
    expect(env.warnings).toEqual(warnings);
  });

  it('omits details key when not provided', () => {
    const env = parseEnvelope(fail('NOT_FOUND', 'x'));
    expect('details' in env.error).toBe(false);
  });
});

describe('adaptIssue()', () => {
  it('passes ValidationIssue through, preserving severity and details', () => {
    const vi: ValidationIssue = {
      field: 'status',
      severity: 'error',
      code: 'TYPE_MISMATCH',
      message: 'expected number',
      details: { expected: 'number', got: 'string' },
    };
    expect(adaptIssue(vi)).toEqual({
      field: 'status',
      severity: 'error',
      code: 'TYPE_MISMATCH',
      message: 'expected number',
      details: { expected: 'number', got: 'string' },
    });
  });

  it('converts ToolIssue with characters into warning with details.characters', () => {
    const ti: ToolIssue = {
      code: 'TITLE_WIKILINK_UNSAFE',
      message: 'bad chars',
      characters: ['[', ']'],
    };
    expect(adaptIssue(ti)).toEqual({
      code: 'TITLE_WIKILINK_UNSAFE',
      message: 'bad chars',
      severity: 'warning',
      details: { characters: ['[', ']'] },
    });
  });

  it('converts ToolIssue without characters into warning with no details', () => {
    const ti: ToolIssue = { code: 'FRONTMATTER_IN_BODY', message: 'm' };
    const out = adaptIssue(ti);
    expect(out).toEqual({ code: 'FRONTMATTER_IN_BODY', message: 'm', severity: 'warning' });
    expect('details' in out).toBe(false);
  });
});
