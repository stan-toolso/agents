import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn(async () => undefined);
const lookupTarget = vi.fn(async () => null as { projectId: string | null; label: string | null } | null);
vi.mock('./service.js', () => ({ auditService: { record: (...a: unknown[]) => (record as (...x: unknown[]) => Promise<void>)(...a) } }));
vi.mock('./lookups.js', () => ({ lookupTarget: (...a: unknown[]) => (lookupTarget as (...x: unknown[]) => Promise<unknown>)(...a) }));

const { AUDITED, AUDITED_BY_SERVICE, NOT_AUDITED, entryFor, requestAnswerDetails, withAudit } = await import('./mutations.js');
const { ACTION_LABELS, TARGET_LABELS } = await import('./labels.js');

const schema = buildSchema(readFileSync(new URL('../graphql/schema.graphql', import.meta.url), 'utf8'));
const mutationNames = Object.keys(schema.getMutationType()!.getFields());

type Mutations = Record<string, (...a: unknown[]) => Promise<unknown>>;
const wrap = (o: Record<string, (...a: never[]) => unknown>) => withAudit(o as never) as Mutations;

const ctx = { user: { id: 'u1', name: 'Alice', email: 'alice@example.com' }, roles: new Map() };

beforeEach(() => {
  record.mockClear();
  lookupTarget.mockReset();
  lookupTarget.mockResolvedValue(null);
});

describe('classement des mutations', () => {
  it('chaque mutation du schéma est tracée, tracée par son service, ou exemptée explicitement', () => {
    const classified = (name: string) => [name in AUDITED, AUDITED_BY_SERVICE.has(name), NOT_AUDITED.has(name)].filter(Boolean).length;
    expect(mutationNames.filter((n) => classified(n) === 0), 'mutations à classer dans audit/mutations.ts').toEqual([]);
    expect(mutationNames.filter((n) => classified(n) > 1), 'mutations classées deux fois').toEqual([]);
  });

  it("ne cite aucune mutation absente du schéma", () => {
    const all = [...Object.keys(AUDITED), ...AUDITED_BY_SERVICE, ...NOT_AUDITED];
    expect(all.filter((n) => !mutationNames.includes(n))).toEqual([]);
  });

  it('chaque action et chaque type de cible a son libellé', () => {
    for (const spec of Object.values(AUDITED)) {
      expect(ACTION_LABELS[spec.action], spec.action).toBeTruthy();
      expect(TARGET_LABELS[spec.target ?? spec.action.split('.')[0]], spec.action).toBeTruthy();
    }
    for (const a of ['task.create', 'task.status', 'context.instruction_move']) expect(ACTION_LABELS[a]).toBeTruthy();
  });
});

describe('entryFor', () => {
  it('prend le projet en argument, puis la cible lue, puis le résultat', () => {
    expect(entryFor({ action: 'git.push', project: 'projectId' }, { projectId: 'p1' }, {}, null)).toMatchObject({ projectId: 'p1' });
    expect(entryFor({ action: 'session.stop', lookup: ['session', 'id'] }, { id: 's1' }, {}, { projectId: 'p2', label: 'Ma session' })).toEqual({ projectId: 'p2', targetId: 's1', targetLabel: 'Ma session' });
    expect(entryFor({ action: 'x.y' }, { id: 'a' }, { id: 'b', projectId: 'p3', name: 'Nom' }, null)).toEqual({ projectId: 'p3', targetId: 'b', targetLabel: 'Nom' });
    expect(entryFor({ action: 'session.create', project: 'input.projectId' }, { input: { projectId: 'p4' } }, { id: 's9' }, null)).toMatchObject({ projectId: 'p4', targetId: 's9' });
  });

  it("n'inscrit rien sans projet, sauf pour une action de l'application", () => {
    expect(entryFor({ action: 'vault.delete', lookup: ['vault_item', 'id'] }, { id: 'v1' }, true, { projectId: null, label: 'perso' })).toBeNull();
    expect(entryFor({ action: 'user.delete', app: true, lookup: ['user', 'userId'] }, { userId: 'u2' }, true, { projectId: null, label: 'bob@example.com' })).toEqual({ projectId: null, targetId: 'u2', targetLabel: 'bob@example.com' });
  });

  it('garde hors projet la suppression du projet (sinon partie avec lui)', () => {
    expect(entryFor(AUDITED.deleteProject, { id: 'p1' }, true, { projectId: 'p1', label: 'Projet' })).toEqual({ projectId: null, targetId: 'p1', targetLabel: 'Projet' });
  });
});

describe('withAudit', () => {
  it('inscrit une mutation réussie, avec la cible lue avant', async () => {
    lookupTarget.mockResolvedValue({ projectId: 'p1', label: 'Session A' });
    const stopSession = vi.fn(async () => ({ id: 's1', projectId: 'p1' }));
    const m = wrap({ stopSession });
    await m.stopSession(null, { id: 's1' }, ctx, null);
    expect(lookupTarget).toHaveBeenCalledWith('session', 's1');
    expect(lookupTarget.mock.invocationCallOrder[0]).toBeLessThan(stopSession.mock.invocationCallOrder[0]);
    expect(record).toHaveBeenCalledWith({ projectId: 'p1', targetId: 's1', targetLabel: 'Session A', actor: { userId: 'u1', label: 'Alice' }, action: 'session.stop', targetType: 'session', details: undefined });
  });

  it("n'inscrit rien quand la mutation échoue, et laisse passer l'erreur", async () => {
    const m = wrap({ gitPush: async () => Promise.reject(new Error('refusé')) });
    await expect(m.gitPush(null, { projectId: 'p1' }, ctx, null)).rejects.toThrow('refusé');
    expect(record).not.toHaveBeenCalled();
  });

  it('ne touche pas aux mutations non tracées', async () => {
    const postMessage = async () => 'ok';
    expect(wrap({ postMessage }).postMessage).toBe(postMessage);
  });

  it('dit qui a autorisé quoi en répondant à une demande', async () => {
    lookupTarget.mockResolvedValue({ projectId: 'p1', label: 'Autoriser Bash ?' });
    const m = wrap({ answerRequest: async () => ({ id: 'r1', type: 'permission', sessionId: 's1' }) });
    await m.answerRequest(null, { id: 'r1', response: { decision: 'allow', always: true, scope: 'project', rules: ['Bash(git status *)'], updatedInput: { big: 'x' } } }, ctx, null);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'request.answer', targetLabel: 'Autoriser Bash ?', details: { type: 'permission', sessionId: 's1', decision: 'allow', always: true, scope: 'project', rules: ['Bash(git status *)'], message: undefined } }));
  });

  it('ne recopie jamais les secrets du coffre', async () => {
    const m = wrap({ createVaultItem: async () => ({ id: 'v1', projectId: 'p1', name: 'base' }) });
    await m.createVaultItem(null, { projectId: 'p1', input: { name: 'base', kind: 'POSTGRES', password: 's3cret' } }, ctx, null);
    expect(JSON.stringify((record.mock.calls[0] as unknown[])[0])).not.toContain('s3cret');
    const u = wrap({ updateVaultItem: async () => ({ id: 'v1' }) });
    lookupTarget.mockResolvedValue({ projectId: 'p1', label: 'base' });
    await u.updateVaultItem(null, { id: 'v1', input: { password: 's3cret' } }, ctx, null);
    expect((record.mock.calls[1] as unknown[])[0]).toMatchObject({ details: { fields: ['password'] } });
    expect(JSON.stringify((record.mock.calls[1] as unknown[])[0])).not.toContain('s3cret');
  });
});

describe('requestAnswerDetails', () => {
  it('garde la décision ou les réponses', () => {
    expect(requestAnswerDetails({ answers: { 'Quelle base ?': 'prod' } })).toEqual({ answers: { 'Quelle base ?': 'prod' } });
    expect(requestAnswerDetails({ decision: 'deny', message: 'non' })).toMatchObject({ decision: 'deny', message: 'non' });
    expect(requestAnswerDetails(null)).toEqual({});
  });
});
