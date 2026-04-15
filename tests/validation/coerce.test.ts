import { describe, it, expect } from 'vitest';
import { coerceValue, type CoercionResult, type CoercionFailure } from '../../src/validation/coerce.js';

function expectSuccess(result: CoercionResult, value: unknown, changed: boolean) {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual(value);
    expect(result.changed).toBe(changed);
  }
}

function expectFailure(result: CoercionResult) {
  expect(result.ok).toBe(false);
  return result as CoercionFailure;
}

// ── null / undefined passthrough ──────────────────────────────────────

describe('null / undefined passthrough', () => {
  it('null passes through unchanged', () => {
    expectSuccess(coerceValue(null, 'string'), null, false);
  });

  it('undefined passes through unchanged', () => {
    expectSuccess(coerceValue(undefined, 'number'), null, false);
  });
});

// ── identity coercions ────────────────────────────────────────────────

describe('identity coercions', () => {
  it('string → string unchanged', () => {
    expectSuccess(coerceValue('hello', 'string'), 'hello', false);
  });

  it('number → number unchanged', () => {
    expectSuccess(coerceValue(42, 'number'), 42, false);
  });

  it('boolean → boolean unchanged', () => {
    expectSuccess(coerceValue(true, 'boolean'), true, false);
  });

  it('array → list unchanged', () => {
    expectSuccess(coerceValue(['a', 'b'], 'list'), ['a', 'b'], false);
  });

  it('number identity rejects Infinity', () => {
    expectFailure(coerceValue(Infinity, 'number'));
  });

  it('number identity rejects -Infinity', () => {
    expectFailure(coerceValue(-Infinity, 'number'));
  });

  it('number identity rejects NaN', () => {
    expectFailure(coerceValue(NaN, 'number'));
  });
});

// ── string → number ──────────────────────────────────────────────────

describe('string → number', () => {
  it('clean integer', () => {
    expectSuccess(coerceValue('42', 'number'), 42, true);
  });

  it('float', () => {
    expectSuccess(coerceValue('3.14', 'number'), 3.14, true);
  });

  it('negative', () => {
    expectSuccess(coerceValue('-7', 'number'), -7, true);
  });

  it('trailing junk rejects', () => {
    expectFailure(coerceValue('42 dollars', 'number'));
  });

  it('Infinity string rejects', () => {
    expectFailure(coerceValue('Infinity', 'number'));
  });

  it('-Infinity string rejects', () => {
    expectFailure(coerceValue('-Infinity', 'number'));
  });

  it('empty string rejects', () => {
    expectFailure(coerceValue('', 'number'));
  });

  it('NaN string rejects', () => {
    expectFailure(coerceValue('NaN', 'number'));
  });
});

// ── string → date ────────────────────────────────────────────────────

describe('string → date', () => {
  it('date-only', () => {
    expectSuccess(coerceValue('2026-04-11', 'date'), '2026-04-11', true);
  });

  it('date-time', () => {
    expectSuccess(coerceValue('2026-04-11T14:30:00', 'date'), '2026-04-11T14:30:00', true);
  });

  it('date-time with timezone', () => {
    expectSuccess(coerceValue('2026-04-11T14:30:00Z', 'date'), '2026-04-11T14:30:00Z', true);
  });

  it('date-time with offset', () => {
    expectSuccess(coerceValue('2026-04-11T14:30:00+05:30', 'date'), '2026-04-11T14:30:00+05:30', true);
  });

  it('invalid format rejects', () => {
    expectFailure(coerceValue('not-a-date', 'date'));
  });

  it('impossible date rejects (month 13)', () => {
    expectFailure(coerceValue('2026-13-01', 'date'));
  });

  it('impossible date rejects (day 32)', () => {
    expectFailure(coerceValue('2026-01-32', 'date'));
  });

  it('impossible date rejects (Feb 30)', () => {
    expectFailure(coerceValue('2026-02-30', 'date'));
  });
});

// ── string → boolean ────────────────────────────────────────────────

describe('string → boolean', () => {
  it.each(['true', 'True', 'TRUE'])('%s → true', (v) => {
    expectSuccess(coerceValue(v, 'boolean'), true, true);
  });

  it.each(['false', 'False', 'FALSE'])('%s → false', (v) => {
    expectSuccess(coerceValue(v, 'boolean'), false, true);
  });

  it.each(['yes', 'Yes', 'YES'])('%s → true', (v) => {
    expectSuccess(coerceValue(v, 'boolean'), true, true);
  });

  it.each(['no', 'No', 'NO'])('%s → false', (v) => {
    expectSuccess(coerceValue(v, 'boolean'), false, true);
  });

  it('rejects "1"', () => {
    expectFailure(coerceValue('1', 'boolean'));
  });

  it('rejects "0"', () => {
    expectFailure(coerceValue('0', 'boolean'));
  });

  it('rejects "maybe"', () => {
    expectFailure(coerceValue('maybe', 'boolean'));
  });
});

// ── string → enum ───────────────────────────────────────────────────

describe('string → enum', () => {
  const opts = { enum_values: ['Active', 'Inactive', 'Archived'] };

  it('exact match', () => {
    expectSuccess(coerceValue('Active', 'enum', opts), 'Active', false);
  });

  it('case-insensitive match', () => {
    expectSuccess(coerceValue('active', 'enum', opts), 'Active', true);
  });

  it('whitespace trimmed', () => {
    expectSuccess(coerceValue('  Active  ', 'enum', opts), 'Active', true);
  });

  it('non-string coerced via String()', () => {
    // enum_values contains a stringified number scenario
    const numOpts = { enum_values: ['1', '2', '3'] };
    expectSuccess(coerceValue(2, 'enum', numOpts), '2', true);
  });

  it('non-matching includes closest_matches', () => {
    const result = expectFailure(coerceValue('Actve', 'enum', opts));
    expect(result.closest_matches).toBeDefined();
    expect(result.closest_matches!.length).toBeGreaterThan(0);
    expect(result.closest_matches).toContain('Active');
  });

  it('completely non-matching — no closest_matches when distance too high', () => {
    const result = expectFailure(coerceValue('zzzzz', 'enum', opts));
    expect(result.closest_matches).toBeUndefined();
  });
});

// ── string → reference ──────────────────────────────────────────────

describe('string → reference', () => {
  it('bare value passes through as canonical target', () => {
    expectSuccess(coerceValue('Alice', 'reference'), 'Alice', false);
  });

  it('wrapped value strips [[brackets]]', () => {
    expectSuccess(coerceValue('[[Alice]]', 'reference'), 'Alice', true);
  });

  it('alias stripped: [[target|alias]] → target', () => {
    expectSuccess(coerceValue('[[Alice|nickname]]', 'reference'), 'Alice', true);
  });
});

// ── number → string ─────────────────────────────────────────────────

describe('number → string', () => {
  it('basic conversion', () => {
    expectSuccess(coerceValue(42, 'string'), '42', true);
  });

  it('float conversion', () => {
    expectSuccess(coerceValue(3.14, 'string'), '3.14', true);
  });
});

// ── Date → string ───────────────────────────────────────────────────

describe('Date → string', () => {
  it('Date object converts to ISO string', () => {
    const d = new Date('2026-04-11T00:00:00Z');
    const result = coerceValue(d, 'string');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value).toBe('string');
      expect(result.changed).toBe(true);
    }
  });
});

// ── single value → list ─────────────────────────────────────────────

describe('single value → list', () => {
  it('string wraps to list<string>', () => {
    expectSuccess(
      coerceValue('hello', 'list', { list_item_type: 'string' }),
      ['hello'],
      true,
    );
  });

  it('number wraps to list<number>', () => {
    expectSuccess(
      coerceValue(42, 'list', { list_item_type: 'number' }),
      [42],
      true,
    );
  });

  it('single value rejects when item type mismatch and coercion fails', () => {
    // boolean can't coerce to number
    expectFailure(coerceValue(true, 'list', { list_item_type: 'number' }));
  });
});

// ── list element coercion ───────────────────────────────────────────

describe('list element coercion', () => {
  it('all elements coerce', () => {
    expectSuccess(
      coerceValue(['1', '2', '3'], 'list', { list_item_type: 'number' }),
      [1, 2, 3],
      true,
    );
  });

  it('element failure produces element_errors', () => {
    const result = expectFailure(
      coerceValue(['1', 'bad', '3'], 'list', { list_item_type: 'number' }),
    );
    expect(result.element_errors).toBeDefined();
    expect(result.element_errors!.length).toBe(1);
    expect(result.element_errors![0].index).toBe(1);
    expect(result.element_errors![0].value).toBe('bad');
  });

  it('multiple element failures', () => {
    const result = expectFailure(
      coerceValue(['bad1', '2', 'bad3'], 'list', { list_item_type: 'number' }),
    );
    expect(result.element_errors!.length).toBe(2);
    expect(result.element_errors![0].index).toBe(0);
    expect(result.element_errors![1].index).toBe(2);
  });
});

// ── list<enum> coercion ────────────────────────────────────────────

describe('list<enum> coercion', () => {
  const opts = { list_item_type: 'enum' as const, enum_values: ['work', 'personal'] };

  it('valid values pass through', () => {
    expectSuccess(coerceValue(['work'], 'list', opts), ['work'], false);
  });

  it('multiple valid values pass through', () => {
    expectSuccess(coerceValue(['work', 'personal'], 'list', opts), ['work', 'personal'], false);
  });

  it('case-insensitive coercion on elements', () => {
    const result = coerceValue(['WORK', 'Personal'], 'list', opts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['work', 'personal']);
      expect(result.changed).toBe(true);
      expect(result.code).toBe('LIST_ELEMENT_COERCION');
    }
  });

  it('invalid element reports enum error, not "No enum_values provided"', () => {
    const result = expectFailure(coerceValue(['foo'], 'list', opts));
    expect(result.element_errors).toBeDefined();
    expect(result.element_errors!.length).toBe(1);
    expect(result.element_errors![0].index).toBe(0);
    expect(result.element_errors![0].reason).not.toContain('No enum_values provided');
    expect(result.element_errors![0].reason).toContain('not a valid enum value');
  });

  it('scalar string coerces to single-element list then validates enum', () => {
    const result = coerceValue('work', 'list', opts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['work']);
      expect(result.changed).toBe(true);
      expect(result.code).toBe('SINGLE_TO_LIST');
    }
  });

  it('scalar string with case coercion wraps and normalizes', () => {
    const result = coerceValue('PERSONAL', 'list', opts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['personal']);
      expect(result.changed).toBe(true);
    }
  });

  it('scalar invalid enum rejects with meaningful error', () => {
    const result = expectFailure(coerceValue('nope', 'list', opts));
    expect(result.reason).toContain('Cannot wrap value into list');
  });
});

// ── list<reference> coercion ───────────────────────────────────────

describe('list<reference> coercion', () => {
  const opts = { list_item_type: 'reference' as const };

  it('valid references pass through', () => {
    expectSuccess(coerceValue(['Alice', 'Bob'], 'list', opts), ['Alice', 'Bob'], false);
  });

  it('bracketed references are stripped', () => {
    const result = coerceValue(['[[Alice]]', '[[Bob]]'], 'list', opts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['Alice', 'Bob']);
      expect(result.changed).toBe(true);
    }
  });

  it('scalar reference coerces to single-element list', () => {
    const result = coerceValue('Alice', 'list', opts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['Alice']);
      expect(result.changed).toBe(true);
      expect(result.code).toBe('SINGLE_TO_LIST');
    }
  });

  it('scalar bracketed reference coerces and strips', () => {
    const result = coerceValue('[[Alice]]', 'list', opts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['Alice']);
      expect(result.changed).toBe(true);
    }
  });
});

// ── unsupported coercions ───────────────────────────────────────────

describe('unsupported coercions', () => {
  it('boolean → number fails', () => {
    expectFailure(coerceValue(true, 'number'));
  });

  it('boolean → date fails', () => {
    expectFailure(coerceValue(true, 'date'));
  });

  it('object → string fails', () => {
    expectFailure(coerceValue({ a: 1 }, 'string'));
  });
});
