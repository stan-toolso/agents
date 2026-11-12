import { describe, expect, it } from 'vitest';
import { WIDGETS, catalogFor } from './catalog.js';
import { defaultLayout } from './defaults.js';
import { LAYOUT_LIMITS, applyOps, diffLayouts, parseLayout, parseParams } from './layout.js';
import { parseScope } from './scope.js';
import { REGIONS } from './types.js';

const P = '11111111-2222-4333-8444-555555555555';

describe('catalogue', () => {
  it('a des clés uniques, des régions valides et la région par défaut admise', () => {
    const keys = new Set<string>();
    for (const w of WIDGETS) {
      expect(keys.has(w.key)).toBe(false);
      keys.add(w.key);
      expect(w.regions).toContain(w.region);
      for (const r of w.regions) expect(REGIONS).toContain(r);
      for (const p of w.params) expect(p.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
    }
  });

  it('les agencements par défaut sont valides pour leur portée', () => {
    expect(parseLayout(defaultLayout({ kind: 'home' }), 'home').blocks.length).toBeGreaterThan(5);
    expect(parseLayout(defaultLayout({ kind: 'project' }), 'project').blocks.some((b) => b.kind === 'builtin' && b.widget === 'channel')).toBe(true);
    expect(parseLayout(defaultLayout({ kind: 'project' }, { personal: true }), 'project').blocks.some((b) => b.kind === 'builtin' && b.widget === 'channel')).toBe(false);
    expect(catalogFor('home').some((w) => w.key === 'projects.table')).toBe(true);
    expect(catalogFor('project').some((w) => w.key === 'projects.table')).toBe(false);
    expect(parseLayout(defaultLayout({ kind: 'tasks' }), 'tasks').blocks.some((b) => b.kind === 'builtin' && b.widget === 'pilot.burnup')).toBe(true);
    expect(parseLayout(defaultLayout({ kind: 'agent' }), 'agent').blocks).toHaveLength(6);
    // Les blocs du tableau de bord n'ont pas de données dans le pilotage, et réciproquement.
    expect(catalogFor('tasks').some((w) => w.key === 'tile.requests')).toBe(false);
    expect(catalogFor('project').some((w) => w.key === 'pilot.burnup')).toBe(false);
    expect(catalogFor('tasks').some((w) => w.key === 'text')).toBe(true);
  });
});

describe('parseScope', () => {
  it('reconnaît les portées composables', () => {
    expect(parseScope('home')).toMatchObject({ kind: 'home', key: 'home', projectId: null });
    expect(parseScope(`Project:${P}`)).toMatchObject({ kind: 'project', key: `project:${P}`, projectId: P });
  });
  it('reconnaît le pilotage, la fiche d’agent et le défaut de la cellule', () => {
    expect(parseScope(`project:${P}:tasks`)).toMatchObject({ kind: 'tasks', projectId: P });
    expect(parseScope(`agent:${P}`)).toMatchObject({ kind: 'agent', agentId: P, projectId: null });
    expect(parseScope('home:default')).toMatchObject({ kind: 'home', cell: true });
    expect(parseScope('home').cell).toBeUndefined();
  });
  it('refuse les portées réservées et inconnues', () => {
    expect(() => parseScope(`project:${P}:page:reporting`)).toThrow(/pas encore composable/);
    expect(() => parseScope('agent:not-a-uuid')).toThrow(/Portée inconnue/);
    expect(() => parseScope('')).toThrow(/Portée inconnue/);
  });
});

describe('parseLayout', () => {
  it('normalise un agencement : identifiants générés, paramètres bornés, inconnus retirés', () => {
    const l = parseLayout({ blocks: [{ kind: 'builtin', widget: 'list.attention_tasks', params: { limit: '999', tags: 'infra, Infra , back', bogus: 1 } }] }, 'home');
    expect(l.v).toBe(1);
    expect(l.blocks[0].id).toMatch(/^b[0-9a-f]{8}$/);
    expect(l.blocks[0].region).toBe('main');
    expect(l.blocks[0].kind === 'builtin' && l.blocks[0].params).toEqual({ limit: 30, tags: ['infra', 'back'] });
  });

  it('refuse un bloc inconnu, hors portée, hors région, en double ou un singleton répété', () => {
    expect(() => parseLayout({ blocks: [{ kind: 'builtin', widget: 'nope' }] }, 'home')).toThrow(/inconnu/);
    expect(() => parseLayout({ blocks: [{ kind: 'builtin', widget: 'projects.table' }] }, 'project')).toThrow(/pas de sens/);
    expect(() => parseLayout({ blocks: [{ kind: 'builtin', widget: 'tile.tasks', region: 'main' }] }, 'home')).toThrow(/région/);
    expect(() => parseLayout({ blocks: [{ id: 'x', kind: 'builtin', widget: 'text' }, { id: 'x', kind: 'builtin', widget: 'text' }] }, 'home')).toThrow(/double/);
    expect(() => parseLayout({ blocks: [{ kind: 'builtin', widget: 'list.todo' }, { kind: 'builtin', widget: 'list.todo' }] }, 'home')).toThrow(/qu'une fois/);
    expect(() => parseLayout({ blocks: Array.from({ length: LAYOUT_LIMITS.maxBlocks + 1 }, () => ({ kind: 'builtin', widget: 'text' })) }, 'home')).toThrow(/Au plus/);
  });

  it('accepte un bloc artefact hors des tuiles, avec hauteur et sondage bornés', () => {
    const l = parseLayout({ blocks: [{ kind: 'artifact', artifact: P.toUpperCase(), region: 'side', height: 10, pollSeconds: 1, params: { a: 1 }, title: ' CA ' }] }, 'project');
    expect(l.blocks[0]).toMatchObject({ kind: 'artifact', artifact: P, region: 'side', height: LAYOUT_LIMITS.minHeight, pollSeconds: LAYOUT_LIMITS.minPollSeconds, params: { a: 1 }, title: 'CA' });
    expect(() => parseLayout({ blocks: [{ kind: 'artifact', artifact: P, region: 'tiles' }] }, 'project')).toThrow(/tuiles/);
    expect(() => parseLayout({ blocks: [{ kind: 'artifact', artifact: 'x', region: 'main' }] }, 'project')).toThrow(/artefact invalide/);
  });

  it('valide les paramètres d’après leur type', () => {
    const text = WIDGETS.find((w) => w.key === 'text')!;
    expect(parseParams(text, { markdown: 'a'.repeat(LAYOUT_LIMITS.maxMarkdown + 10) }, 'b')).toEqual({ markdown: 'a'.repeat(LAYOUT_LIMITS.maxMarkdown) });
    const team = WIDGETS.find((w) => w.key === 'list.team')!;
    expect(parseParams(team, { onlyAgents: 'true' }, 'b')).toEqual({ onlyAgents: true });
    expect(() => parseParams(team, { onlyAgents: 'oui' }, 'b')).toThrow(/vrai ou faux/);
    expect(() => parseParams(text, 'x', 'b')).toThrow(/objet/);
  });
});

describe('applyOps', () => {
  const base = defaultLayout({ kind: 'home' });
  it('ajoute à la fin d’une région ou à une position, retire, déplace et règle', () => {
    const l = applyOps(base, [
      { op: 'add', block: { kind: 'builtin', widget: 'text', params: { markdown: 'Bonjour' } }, index: 0 },
      { op: 'remove', id: 'd-projects-table' },
      { op: 'move', id: 'd-usage-card', region: 'main', index: 0 },
      { op: 'set', id: 'd-list-attention-tasks', title: 'Urgent', params: { limit: 3 } },
    ], 'home');
    const main = l.blocks.filter((b) => b.region === 'main');
    expect(main[0]).toMatchObject({ widget: 'usage.card' });
    expect(main[1]).toMatchObject({ widget: 'text', params: { markdown: 'Bonjour' } });
    expect(l.blocks.some((b) => b.id === 'd-projects-table')).toBe(false);
    expect(l.blocks.find((b) => b.id === 'd-list-attention-tasks')).toMatchObject({ title: 'Urgent', params: { limit: 3 } });
    // L'original n'est pas modifié.
    expect(base.blocks.some((b) => b.id === 'd-projects-table')).toBe(true);
  });
  it('refuse un identifiant inconnu, une opération inconnue, une liste vide', () => {
    expect(() => applyOps(base, [{ op: 'remove', id: 'zz' }], 'home')).toThrow(/Aucun bloc/);
    expect(() => applyOps(base, [{ op: 'explode' }], 'home')).toThrow(/op inconnue/);
    expect(() => applyOps(base, [], 'home')).toThrow(/non vide/);
  });
  it('décrit la différence', () => {
    const after = applyOps(base, [{ op: 'remove', id: 'd-projects-table' }, { op: 'set', id: 'd-list-todo', title: 'À faire' }], 'home');
    const d = diffLayouts(base, after);
    expect(d.removed.map((b) => b.id)).toEqual(['d-projects-table']);
    expect(d.changed.map((b) => b.id)).toEqual(['d-list-todo']);
    expect(d.added).toEqual([]);
  });
});
