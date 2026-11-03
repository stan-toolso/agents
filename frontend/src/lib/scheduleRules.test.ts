import { describe, expect, it } from 'vitest';
import { parseRule, ruleCovered, ruleLabel } from './scheduleRules';

describe('scheduleRules', () => {
  it('lit une règle', () => {
    expect(parseRule('Bash(git log *)')).toEqual({ toolName: 'Bash', content: 'git log *' });
    expect(parseRule('mcp__vault')).toEqual({ toolName: 'mcp__vault', content: null });
    expect(parseRule('Bash(oops')).toBeNull();
    expect(parseRule('deux mots')).toBeNull();
  });

  it('reconnaît une règle couverte', () => {
    expect(ruleCovered(['mcp__vault__sql_query(Production)'], 'mcp__vault__sql_query(production)')).toBe(true);
    expect(ruleCovered(['mcp__vault'], 'mcp__vault__sql_query(production)')).toBe(true);
    expect(ruleCovered(['Bash(git *)'], 'Bash(git log *)')).toBe(true);
    expect(ruleCovered(['Bash(git log *)'], 'Bash(git push *)')).toBe(false);
    expect(ruleCovered([], 'WebFetch')).toBe(false);
  });

  it('donne un libellé lisible', () => {
    expect(ruleLabel('mcp__vault__sql_query(production)')).toBe('Coffre · sql_query sur « production »');
    expect(ruleLabel('Bash(git log *)')).toBe('Commande git log …');
    expect(ruleLabel('WebFetch')).toBe('WebFetch');
  });
});
