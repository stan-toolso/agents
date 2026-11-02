import { describe, expect, it } from 'vitest';
import { describeTaskFeed } from './taskFeed';

describe('describeTaskFeed', () => {
  it('ignore une instruction ordinaire', () => {
    expect(describeTaskFeed('Corrige le bug')).toBeNull();
  });
  it('résume une modification (titre avec guillemets, identifiant de session retiré)', () => {
    const text = [
      "[Mise à jour de la tâche] La tâche 19dab8e3-7fa6-4bde-b42b-19f8151d406a (« File de validation unifiée : page « À traiter » tous projets ») à laquelle cette session est reliée a été modifiée par la session d'agent « File « À traiter » » (832ae029-d969-41b2-8bad-15918597391f) :",
      '- Statut : à faire → en cours',
      '',
      'Pour information : poursuis sans en parler.',
    ].join('\n');
    expect(describeTaskFeed(text)).toEqual({
      kind: 'update',
      taskId: '19dab8e3-7fa6-4bde-b42b-19f8151d406a',
      title: 'File de validation unifiée : page « À traiter » tous projets',
      summary: "Tâche « File de validation unifiée : page « À traiter » tous projets » modifiée par la session d'agent « File « À traiter » » · Statut : à faire → en cours",
    });
  });
  it('résume un message du fil par son auteur et sa première ligne', () => {
    const text = [
      '[Commentaire sur la tâche] Nouveau message dans le fil de la tâche t1 (« Corriger le bug ») dont cette session est en charge :',
      '- Alice, 2026-10-10 09:30 UTC (message c1) :',
      '  Peux-tu aussi vérifier le panier ?',
      '  Merci.',
      '',
      'Réponds-y…',
    ].join('\n');
    expect(describeTaskFeed(text)).toMatchObject({ kind: 'comment', taskId: 't1', summary: 'Alice dans la tâche « Corriger le bug » : Peux-tu aussi vérifier le panier ?' });
  });
  it('résume une réaction', () => {
    const text = '[Réaction sur la tâche] Alice a réagi 👍 à ton message c1 de la tâche t1 (« Corriger le bug ») : « Fait. ». Rien à faire.';
    expect(describeTaskFeed(text)).toMatchObject({ kind: 'reaction', taskId: 't1', summary: 'Alice a réagi 👍 à ton message c1 · tâche « Corriger le bug »' });
  });
});

describe('describeTaskFeed (canaux de conversation)', () => {
  it('résume un message d’un canal par son auteur, le canal, le fil et sa première ligne', () => {
    const text = [
      '[Message dans un canal] Nouveau message dans le fil « On livre ce soir ? » du canal #general (fil m1) que cette session suit, et qui mentionne cette session :',
      '- Alice, 2026-11-02 10:00 UTC (message m2, en réponse à Alice) :',
      '  Oui @session:s2',
      '',
      'Réponds-y avec l’outil `conversations.post`…',
    ].join('\n');
    expect(describeTaskFeed(text)).toEqual({ kind: 'comment', taskId: null, title: 'On livre ce soir ?', summary: 'Alice dans #general (fil « On livre ce soir ? ») : Oui @session:s2' });
  });
  it('résume une réaction reçue dans un canal', () => {
    const text = '[Réaction dans un canal] Alice a réagi 👍 à ton message m1 dans #general : « Point du matin ». Rien à faire, sauf si cela appelle une suite.';
    expect(describeTaskFeed(text)).toEqual({ kind: 'reaction', taskId: null, title: null, summary: 'Alice a réagi 👍 à ton message m1 dans #general : « Point du matin »' });
  });
});
