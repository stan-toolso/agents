import { describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationChange, Message, MessageReaction } from './types.js';

// La remise aux sessions importe le fil des tâches (deliverFeed) et les déclencheurs des agents : simulés.
vi.mock('../tasks/sessionFeed.js', () => ({ deliverFeed: async () => undefined }));
vi.mock('../agents/triggers.js', () => ({ agentConversationFeedTargets: async () => new Set<string>() }));
vi.mock('./service.js', async () => {
  const actual = await vi.importActual<typeof import('./service.js')>('./service.js');
  return { ...actual, conversationService: {} };
});
const { feedsFor } = await import('./feed.js');

const conversation: Conversation = { id: 'c1', projectId: 'p1', kind: 'channel', taskId: null, slug: 'general', name: 'général', topic: '', createdById: null, lastMessageAt: null, createdAt: new Date(), updatedAt: new Date(), archivedAt: null };
const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  conversationId: 'c1',
  parentId: null,
  authorType: 'human',
  authorUserId: 'u1',
  authorSessionId: null,
  authorName: 'Alice',
  body: 'On livre ce soir ?\nDétails…',
  mentions: [],
  createdAt: new Date('2026-11-02T10:00:00Z'),
  updatedAt: new Date('2026-11-02T10:00:00Z'),
  ...over,
});

describe('feedsFor (canaux)', () => {
  it("adresse un message aux sessions mentionnées (relance) et le note aux autres sessions reliées", () => {
    const root = message();
    const reply = message({ id: 'm2', parentId: 'm1', body: 'Oui @session:s2', mentions: [{ kind: 'session', id: 's2', label: 'Ben · général', text: '@session:s2' }] });
    const feeds = feedsFor({ kind: 'posted', conversation, message: reply, root, parent: root, attachments: [] }, ['s1', 's3']);
    expect(feeds.map((f) => [f.sessionId, f.restart, f.quiet])).toEqual([
      ['s1', false, true],
      ['s3', false, true],
      ['s2', true, false],
    ]);
    const addressed = feeds.find((f) => f.sessionId === 's2')!;
    expect(addressed.text).toContain('[Message dans un canal]');
    expect(addressed.text).toContain('« On livre ce soir ? » du canal #general (fil m1)');
    expect(addressed.text).toContain('qui mentionne cette session');
    expect(addressed.text).toContain('reply_to m1');
    expect(feeds[0].text).toContain('Pour information');
  });

  it("adresse le message aux sessions désignées par les agents (alsoAddressed) et jamais à son autrice", () => {
    const root = message({ authorType: 'agent', authorUserId: null, authorSessionId: 's1', authorName: 'Ben' });
    const feeds = feedsFor({ kind: 'posted', conversation, message: root, root, parent: null, attachments: [] }, ['s1', 's2'], new Set(['s2']));
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ sessionId: 's2', restart: true, quiet: false });
  });

  it("signale une réaction à la seule session autrice du message, en note", () => {
    const target = message({ authorType: 'agent', authorUserId: null, authorSessionId: 's1', authorName: 'Ben' });
    const reaction: MessageReaction = { id: 'r1', conversationId: 'c1', messageId: 'm1', emoji: '👍', actorType: 'human', userId: 'u1', sessionId: null, actorName: 'Alice', createdAt: new Date() };
    const change: ConversationChange = { kind: 'reacted', conversation, message: target, reaction, added: true };
    const feeds = feedsFor(change, ['s1', 's2']);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ sessionId: 's1', quiet: true, restart: false });
    expect(feeds[0].text).toContain('a réagi 👍');
    expect(feedsFor({ ...change, message: message() }, ['s1'])).toEqual([]);
  });

  it('joint les fichiers du message aux sessions à qui il est adressé, et les nomme seulement dans une note', () => {
    const root = message({ body: '' });
    const attachments = [{ id: 'f1', conversationId: 'c1', messageId: 'm1', name: 'capture.png', mediaType: 'image/png', size: 2048, createdAt: new Date() }];
    const feeds = feedsFor({ kind: 'posted', conversation, message: root, root, parent: null, attachments }, ['s1', 's2'], new Set(['s2']));
    const addressed = feeds.find((f) => f.sessionId === 's2')!;
    expect(addressed.withFiles).toBe(true);
    expect(addressed.text).toContain('(pas de texte)');
    expect(addressed.text).toContain('- capture.png (image/png, 2 Ko) — joint à cette instruction');
    const note = feeds.find((f) => f.sessionId === 's1')!;
    expect(note.withFiles).toBe(false);
    expect(note.text).toContain('- capture.png (image/png, 2 Ko)');
    expect(note.text).not.toContain('joint à cette instruction');
  });
});
