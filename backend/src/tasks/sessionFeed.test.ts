import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskComment, TaskReaction } from './types.js';

// Le fil des sessions importe le service des sessions et le registre des providers : inutiles ici.
vi.mock('../sessions/service.js', () => ({ sessionService: {} }));
vi.mock('../sessions/providers/registry.js', () => ({ getProvider: () => ({ describe: () => ({ interactive: true }) }) }));
// Les déclencheurs des agents (sessions d'agent qui suivent le fil) importent les services des PR et des agents : simulés.
vi.mock('../agents/triggers.js', () => ({ agentFeedTargets: async () => new Set<string>() }));
const { feedFor, feedsFor } = await import('./sessionFeed.js');

const task: Task = {
  id: 't1',
  projectId: 'p1',
  title: 'Corriger le bug',
  description: '',
  status: 'in_progress',
  priority: 'medium',
  sessionId: 's1',
  sessionIds: ['s1'],
  dependsOnIds: [],
  blockedByIds: [],
  dependentIds: [],
  autoStartWhenUnblocked: false,
  autoStartById: null,
  branch: null,
  createdByType: 'user',
  createdBySessionId: null,
  dueDate: null,
  customFields: [],
  statusTag: null,
  tags: [],
  assignee: null,
  reporter: null,
} as unknown as Task;

const comment = (over: Partial<TaskComment> = {}): TaskComment => ({
  id: 'c1',
  taskId: 't1',
  parentId: null,
  authorType: 'human',
  authorUserId: 'u1',
  authorSessionId: null,
  authorName: 'Alice',
  body: 'Peux-tu aussi vérifier le panier ?\nMerci.',
  mentions: [],
  createdAt: new Date('2026-10-10T09:30:00Z'),
  updatedAt: new Date('2026-10-10T09:30:00Z'),
  ...over,
});

const alice = { type: 'user', userId: 'u1', name: 'Alice', sessionId: null } as never;

describe('feedsFor (plusieurs sessions en charge)', () => {
  const shared: Task = { ...task, sessionId: 's2', sessionIds: ['s2', 's1'] };
  it('un message est transmis à chaque session en charge, sauf à son auteur, et les relance', () => {
    const feeds = feedsFor({ kind: 'commented', attachments: [], parent: null, task: shared, comment: comment() });
    expect(feeds.map((f) => [f.sessionId, f.restart])).toEqual([
      ['s2', true],
      ['s1', true],
    ]);
    expect(feeds[0].text).toContain('dont cette session est en charge');
    expect(feedsFor({ kind: 'commented', attachments: [], parent: null, task: shared, comment: comment({ authorType: 'agent', authorSessionId: 's2' }) }).map((f) => f.sessionId)).toEqual(['s1']);
  });
  it('une modification est décrite aux sessions déjà en charge, pas à celle qui vient de prendre la charge ni à son auteur', () => {
    const before: Task = { ...task, sessionId: 's1', sessionIds: ['s1'], status: 'todo' };
    const feeds = feedsFor({ kind: 'updated', addedAttachments: [], before, task: shared, actor: { type: 'agent', userId: null, name: 'Session 2', sessionId: 's2' } as never });
    expect(feeds.map((f) => f.sessionId)).toEqual(['s1']);
    expect(feeds[0].text).toContain("la session d'agent « Session 2 »");
    expect(feedsFor({ kind: 'updated', addedAttachments: [], before, task: shared, actor: alice }).map((f) => f.sessionId)).toEqual(['s1']);
  });
});

describe('feedFor', () => {
  it('rien sans session en charge', () => {
    expect(feedFor({ kind: 'commented', attachments: [], parent: null, task: { ...task, sessionId: null, sessionIds: [] }, comment: comment() })).toBeNull();
    expect(feedsFor({ kind: 'commented', attachments: [], parent: null, task: { ...task, sessionId: null, sessionIds: [] }, comment: comment() })).toEqual([]);
  });
  it('un commentaire d’une personne est transmis à la session en charge, et la relance au besoin', () => {
    const feed = feedFor({ kind: 'commented', attachments: [], parent: null, task, comment: comment() });
    expect(feed).not.toBeNull();
    expect(feed!.sessionId).toBe('s1');
    expect(feed!.restart).toBe(true);
    expect(feed!.quiet).toBe(false);
    expect(feed!.text).toContain('[Commentaire sur la tâche]');
    expect(feed!.text).toContain('dont cette session est en charge');
    expect(feed!.text).toContain('- Alice, 2026-10-10 09:30 UTC (message c1) :');
    expect(feed!.text).toContain('  Peux-tu aussi vérifier le panier ?\n  Merci.');
    expect(feed!.text).toContain('reply_to : c1');
  });
  it('le commentaire de la session elle-même ne lui est pas renvoyé', () => {
    expect(feedFor({ kind: 'commented', attachments: [], parent: null, task, comment: comment({ authorType: 'agent', authorSessionId: 's1' }) })).toBeNull();
  });
  it('une modification par quelqu’un d’autre est décrite à la session, sans relance', () => {
    const feed = feedFor({ kind: 'updated', addedAttachments: [], before: { ...task, status: 'todo' }, task, actor: alice });
    expect(feed).not.toBeNull();
    expect(feed!.restart).toBe(false);
    expect(feed!.text).toContain('[Mise à jour de la tâche]');
    expect(feed!.text).toContain('modifiée par Alice');
    expect(feed!.text).toContain('- Statut : à faire → en cours');
  });
  it('rien pour une passation, une modification par la session elle-même, ou sans changement visible', () => {
    expect(feedFor({ kind: 'updated', addedAttachments: [], before: { ...task, sessionId: 's0', sessionIds: ['s0'] }, task, actor: alice })).toBeNull();
    expect(feedFor({ kind: 'updated', addedAttachments: [], before: { ...task, status: 'todo' }, task, actor: { type: 'agent', userId: null, name: 'Session', sessionId: 's1' } as never })).toBeNull();
    expect(feedFor({ kind: 'updated', addedAttachments: [], before: task, task: { ...task }, actor: alice })).toBeNull();
    expect(feedFor({ kind: 'updated', addedAttachments: [], before: { ...task, status: 'todo' }, task, actor: null })).toBeNull();
  });
});

describe('feedsFor (sessions reliées)', () => {
  it('un message est transmis à toutes les sessions reliées ; seule la session en charge est relancée', () => {
    const feeds = feedsFor({ kind: 'commented', attachments: [], parent: null, task, comment: comment() }, ['s2', 's3']);
    expect(feeds.map((f) => [f.sessionId, f.restart, f.quiet]).sort()).toEqual([
      ['s1', true, false],
      ['s2', false, true],
      ['s3', false, true],
    ]);
    const linked = feeds.find((f) => f.sessionId === 's2')!.text;
    expect(linked).toContain('à laquelle cette session est reliée');
    // Note discrète : l'agent n'est pas invité à répondre.
    expect(linked).toContain('Pour information');
    expect(linked).not.toContain('reply_to');
  });
  it('une session mentionnée reçoit le message et est relancée, même si elle n’était pas reliée', () => {
    const c = comment({ body: 'Regarde ça @session:aaaaaaaa', mentions: [{ kind: 'session', id: 'aaaaaaaa-0000', label: 'Autre', text: '@session:aaaaaaaa' }] });
    const feeds = feedsFor({ kind: 'commented', attachments: [], parent: null, task, comment: c }, []);
    const mentioned = feeds.find((f) => f.sessionId === 'aaaaaaaa-0000');
    expect(mentioned).toBeDefined();
    expect(mentioned!.restart).toBe(true);
    expect(mentioned!.quiet).toBe(false);
    expect(mentioned!.text).toContain('qui mentionne cette session');
    expect(mentioned!.text).toContain('(mentionne la session « Autre » (aaaaaaaa-0000))');
  });
  it('une session d’agent qui suit le fil (alsoAddressed) reçoit le message comme une instruction et est relancée', () => {
    const feeds = feedsFor({ kind: 'commented', attachments: [], parent: null, task, comment: comment() }, ['s2', 's3'], new Set(['s3', 's4']));
    expect(feeds.map((f) => [f.sessionId, f.restart, f.quiet]).sort()).toEqual([
      ['s1', true, false],
      ['s2', false, true],
      ['s3', true, false],
      ['s4', true, false],
    ]);
    expect(feeds.find((f) => f.sessionId === 's3')!.text).toContain('reply_to');
  });
  it('une réponse rappelle le message auquel elle répond et propose de rester dans son fil', () => {
    const parent = comment({ id: 'c0', authorName: 'Bob', authorUserId: 'u2' });
    const feeds = feedsFor({ kind: 'commented', attachments: [], parent, task, comment: comment({ parentId: 'c0' }) });
    expect(feeds[0].text).toContain('en réponse à Bob');
    expect(feeds[0].text).toContain('reply_to : c0');
  });
  it('l’auteur du message (session) ne le reçoit pas, les autres sessions reliées si', () => {
    const feeds = feedsFor({ kind: 'commented', attachments: [], parent: null, task, comment: comment({ authorType: 'agent', authorSessionId: 's2', authorName: 'Session 2' }) }, ['s2']);
    expect(feeds.map((f) => f.sessionId)).toEqual(['s1']);
  });
  it('une modification est décrite à toutes les sessions reliées, sauf à son auteur', () => {
    const feeds = feedsFor({ kind: 'updated', addedAttachments: [], before: { ...task, status: 'todo' }, task, actor: { type: 'agent', userId: null, name: 'S2', sessionId: 's2' } as never }, ['s2', 's3']);
    expect(feeds.map((f) => f.sessionId).sort()).toEqual(['s1', 's3']);
    expect(feeds.every((f) => !f.restart)).toBe(true);
    // Faite par une autre session d'agent : une note, même pour la session en charge.
    expect(feeds.every((f) => f.quiet && f.text.includes('Pour information'))).toBe(true);
  });
  it('une modification par une personne est un message pour la session en charge, une note pour les sessions reliées', () => {
    const feeds = feedsFor({ kind: 'updated', addedAttachments: [], before: { ...task, status: 'todo' }, task, actor: alice }, ['s3']);
    expect(feeds.map((f) => [f.sessionId, f.quiet]).sort()).toEqual([
      ['s1', false],
      ['s3', true],
    ]);
    expect(feeds.find((f) => f.sessionId === 's1')!.text).toContain('Tiens-en compte dans ton travail');
  });
  it('une tâche fermée par une personne n’ouvre pas de tour : la session en charge (qui va se terminer) en reçoit une note', () => {
    for (const status of ['done', 'cancelled'] as const) {
      const feeds = feedsFor({ kind: 'updated', addedAttachments: [], before: task, task: { ...task, status }, actor: alice });
      expect(feeds.map((f) => [f.sessionId, f.quiet, f.restart])).toEqual([['s1', true, false]]);
    }
  });
  it('une réaction n’est signalée qu’à la session autrice du message, sans relance', () => {
    const reaction: TaskReaction = { id: 'r1', taskId: 't1', commentId: 'c1', emoji: '👍', actorType: 'human', userId: 'u1', sessionId: null, actorName: 'Alice', createdAt: new Date() };
    const target = comment({ authorType: 'agent', authorSessionId: 's2', authorName: 'Session 2', body: 'Fait.' });
    const feeds = feedsFor({ kind: 'reacted', task, reaction, comment: target, added: true }, ['s2', 's3']);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ sessionId: 's2', restart: false, quiet: true });
    expect(feeds[0].text).toContain('[Réaction sur la tâche] Alice a réagi 👍 à ton message c1');
    // Sur la tâche elle-même, ou sur le message d'une personne : rien à dire à une session.
    expect(feedsFor({ kind: 'reacted', task, reaction: { ...reaction, commentId: null }, comment: null, added: true }, ['s2'])).toEqual([]);
    expect(feedsFor({ kind: 'reacted', task, reaction, comment: comment(), added: true }, ['s2'])).toEqual([]);
  });
});
