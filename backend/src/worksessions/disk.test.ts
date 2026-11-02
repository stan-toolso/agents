import { execFileSync } from 'node:child_process';
import { link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worksession } from './types.js';

// Pas de base : enregistrements, tâches et PR simulés ; git et du tournent pour de vrai dans un dossier temporaire
// (WORKSPACES_ROOT) : un « origin » nu, le checkout principal du projet « p », et ses dossiers dans p.worktrees/.
const root = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skipper-disk-')));
  process.env.WORKSPACES_ROOT = dir;
  return dir;
});
const m = vi.hoisted(() => ({
  records: [] as Worksession[],
  activity: new Map<string, { activeSessions: number; busySessions: number; terminals: number; lastActivityAt: Date | null }>(),
  prs: new Map<string, { status: string }>(),
  removed: [] as string[],
  created: [] as { name: string; branch: string }[],
}));
vi.mock('./repository.js', () => ({
  worksessionRepository: {
    listByProject: async () => m.records,
    activityByProject: async () => m.activity,
    findByBranch: async (_: string, branch: string) => m.records.find((w) => w.branch === branch && !w.archivedAt) ?? null,
    create: async (projectId: string, name: string, branch: string) => {
      m.created.push({ name, branch });
      return { id: 'new', projectId, name, branch, label: null, taskId: null, archivedAt: null, createdAt: new Date() };
    },
  },
}));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, slug: id, gitUrl: 'x', gitBranch: 'main' }) } }));
vi.mock('../settings/github.js', () => ({ githubService: { gitConfigArgs: async () => [] } }));
vi.mock('../tasks/repository.js', () => ({ taskRepository: { findByIds: async () => [], findForBranches: async () => new Map() } }));
vi.mock('../pullRequests/repository.js', () => ({ pullRequestRepository: { findForWorksessions: async () => m.prs } }));
vi.mock('../previews/service.js', () => ({ previewService: { liveWorksessions: async () => [], installRunning: async () => false }, previewStateDir: () => '/nonexistent' }));
vi.mock('../projects/cleanup.js', () => ({
  removeWorksessionKeepingSessions: async (id: string) => {
    const w = m.records.find((r) => r.id === id)!;
    git(main, 'worktree', 'remove', '--force', path.join(wsRoot, w.name));
    m.removed.push(w.name);
    return { archivedSessionIds: [] };
  },
}));

const { assessCleanup, worksessionDisk } = await import('./disk.js');

const origin = path.join(root, 'origin.git');
const main = path.join(root, 'p');
const wsRoot = path.join(root, 'p.worktrees');
const other = path.join(root, 'other');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const configure = (cwd: string) => {
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
};
const commit = async (cwd: string, file: string, message: string) => {
  await writeFile(path.join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
};
let seq = 0;
/** Dossier de travail sur une nouvelle branche depuis origin/main, enregistré (ou non) comme work session. */
const addWorksession = (name: string, opts: { registered?: boolean; archived?: boolean } = {}) => {
  const dir = path.join(wsRoot, name);
  git(main, 'worktree', 'add', '-q', '-b', name, dir, 'origin/main');
  configure(dir);
  if (opts.registered !== false) {
    m.records.push({ id: `ws-${++seq}`, projectId: 'p', name, branch: name, label: null, taskId: null, archivedAt: opts.archived ? new Date() : null, createdAt: new Date() });
  }
  return dir;
};
const entry = async (name: string) => (await worksessionDisk.report('p', { refresh: true })).entries.find((e) => e.name === name)!;

beforeEach(async () => {
  for (const d of [origin, main, wsRoot, other]) await rm(d, { recursive: true, force: true });
  Object.assign(m, { records: [], activity: new Map(), prs: new Map(), removed: [], created: [] });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, other);
  configure(other);
  await commit(other, 'a.txt', 'départ');
  git(other, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'clone', '-q', origin, main);
  configure(main);
  await mkdir(wsRoot, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('dossiers de travail sur disque', () => {
  it('autorise le nettoyage d’une branche fusionnée dans origin/main, pas d’une branche en avance', async () => {
    const merged = addWorksession('fusionnee', { archived: true });
    await commit(merged, 'f.txt', 'travail fusionné');
    git(merged, 'push', '-q', 'origin', 'fusionnee:main');
    const ahead = addWorksession('en-avance');
    await commit(ahead, 'g.txt', 'pas encore fusionné');

    const report = await worksessionDisk.report('p', { refresh: true });
    const byName = new Map(report.entries.map((e) => [e.name, e]));
    expect(byName.get('fusionnee')).toMatchObject({ merged: true, aheadCount: 0, changes: 0, cleanable: true, blocker: null });
    expect(byName.get('en-avance')).toMatchObject({ merged: false, aheadCount: 1, cleanable: false, blocker: '1 commit non fusionné' });
  });

  it('refuse un dossier aux modifications non commitées, ou où une session tourne', async () => {
    const dirty = addWorksession('sale', { archived: true });
    await writeFile(path.join(dirty, 'brouillon.txt'), 'x');
    addWorksession('occupee');
    m.activity.set(m.records[1].id, { activeSessions: 1, busySessions: 1, terminals: 0, lastActivityAt: null });
    expect((await entry('sale')).blocker).toBe('1 fichier modifié non commité');
    expect((await entry('occupee')).blocker).toBe('Une session y tourne');
  });

  it('garde le dossier vierge d’une session en cours, mais pas celui d’une PR fusionnée par squash dont tout est sur origin', async () => {
    addWorksession('vierge');
    m.activity.set(m.records[0].id, { activeSessions: 1, busySessions: 0, terminals: 0, lastActivityAt: null });
    expect((await entry('vierge')).blocker).toBe('Session en cours, rien de fusionné encore');

    const squashed = addWorksession('squash');
    await commit(squashed, 's.txt', 'travail squashé');
    m.prs.set(m.records[1].id, { status: 'merged' });
    expect((await entry('squash')).blocker).toBe('PR fusionnée, mais des commits locaux ne sont pas sur origin');
    git(squashed, 'push', '-q', 'origin', 'squash');
    expect(await entry('squash')).toMatchObject({ prMerged: true, merged: true, unpushedCount: 0, cleanable: true });
  });

  it('nettoie seulement les dossiers fusionnés', async () => {
    addWorksession('fusionnee', { archived: true });
    const ahead = addWorksession('en-avance');
    await commit(ahead, 'g.txt', 'à garder');
    const result = await worksessionDisk.cleanMerged('p', 'u1');
    expect(result.removed).toEqual(['fusionnee']);
    expect(m.removed).toEqual(['fusionnee']);
    // Un nom désigné mais non nettoyable est signalé avec sa raison.
    expect((await worksessionDisk.cleanMerged('p', 'u1', ['en-avance'])).skipped).toEqual([{ name: 'en-avance', reason: '1 commit non fusionné' }]);
  });

  it('repère les dossiers orphelins, les importe ou les supprime', async () => {
    addWorksession('a-la-main', { registered: false });
    await mkdir(path.join(wsRoot, 'dossier-perdu'));
    const report = await worksessionDisk.report('p', { refresh: true });
    expect(report.entries.find((e) => e.name === 'a-la-main')).toMatchObject({ worksession: null, gitWorktree: true, branch: 'a-la-main', cleanable: false });
    expect(report.entries.find((e) => e.name === 'dossier-perdu')).toMatchObject({ worksession: null, gitWorktree: false });

    await worksessionDisk.importOrphan('p', 'a-la-main');
    expect(m.created).toEqual([{ name: 'a-la-main', branch: 'a-la-main' }]);
    await expect(worksessionDisk.importOrphan('p', 'dossier-perdu')).rejects.toThrow(/pas un git worktree/);
    await expect(worksessionDisk.deleteOrphan('p', '../p')).rejects.toThrow(/invalide/);

    await worksessionDisk.deleteOrphan('p', 'dossier-perdu');
    await expect(stat(path.join(wsRoot, 'dossier-perdu'))).rejects.toThrow();
    m.records.push({ id: 'x', projectId: 'p', name: 'a-la-main', branch: 'a-la-main', label: null, taskId: null, archivedAt: null, createdAt: new Date() });
    await expect(worksessionDisk.deleteOrphan('p', 'a-la-main')).rejects.toThrow(/déjà celui d'une work session/);
  });

  it('compte une seule fois, à l’instantané, les dépendances liées par liens physiques', async () => {
    const dir = addWorksession('liee', { archived: true });
    const store = path.join(wsRoot, '.skipper-deps', 'abc', 'node_modules');
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, 'gros.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
    await mkdir(path.join(dir, 'node_modules'));
    await link(path.join(store, 'gros.bin'), path.join(dir, 'node_modules', 'gros.bin'));
    const report = await worksessionDisk.report('p', { refresh: true });
    expect(report.sharedBytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(report.entries.find((e) => e.name === 'liee')!.bytes).toBeLessThan(1024 * 1024);
  });
});

describe('règle de nettoyage', () => {
  const ws: Worksession = { id: 'w', projectId: 'p', name: 'n', branch: 'n', label: null, taskId: null, archivedAt: null, createdAt: new Date() };
  const base = { worksession: ws, exists: true, aheadCount: 0, unpushedCount: null, changes: 0, prMerged: false, taskStatus: null, activity: null };
  it('accepte un dossier sans commits propres ni session, ou dont la tâche est terminée', () => {
    expect(assessCleanup(base)).toBeNull();
    expect(assessCleanup({ ...base, activity: { activeSessions: 1, busySessions: 0, terminals: 0, lastActivityAt: null }, taskStatus: 'done' })).toBeNull();
  });
  it('refuse un orphelin, un dossier absent ou un terminal ouvert', () => {
    expect(assessCleanup({ ...base, worksession: null })).toBe('Dossier inconnu de Skipper');
    expect(assessCleanup({ ...base, exists: false })).toBe('Dossier absent du disque');
    expect(assessCleanup({ ...base, activity: { activeSessions: 0, busySessions: 0, terminals: 1, lastActivityAt: null } })).toBe('Un terminal y est ouvert');
  });
});
