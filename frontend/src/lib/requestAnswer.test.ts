import { describe, expect, it } from 'vitest';
import { isSettledError, promptTakesKey, type PromptKeyContext } from './requestAnswer';

const key = (over: Partial<PromptKeyContext> = {}): PromptKeyContext => ({
  repeat: false,
  modifier: false,
  targetTag: 'BODY',
  targetValue: '',
  targetInPrompt: false,
  visible: true,
  first: true,
  locked: false,
  ...over,
});

describe('isSettledError', () => {
  it('reconnaît une demande déjà réglée ailleurs, au code ou à l’ancien message', () => {
    expect(isSettledError({ graphQLErrors: [{ extensions: { code: 'REQUEST_SETTLED' } }] })).toBe(true);
    expect(isSettledError({ message: "La demande n'est plus en attente (statut : answered)" })).toBe(true);
    expect(isSettledError({ message: 'Failed to fetch', graphQLErrors: [] })).toBe(false);
    expect(isSettledError(null)).toBe(false);
  });
});

describe('promptTakesKey', () => {
  it('prend la touche depuis la page, le prompt ou la zone de saisie vide', () => {
    expect(promptTakesKey(key())).toBe(true);
    expect(promptTakesKey(key({ targetTag: 'BUTTON', targetInPrompt: true }))).toBe(true);
    expect(promptTakesKey(key({ targetTag: 'TEXTAREA' }))).toBe(true);
  });

  it('ignore une touche maintenue, un prompt verrouillé, masqué ou qui n’est pas le premier', () => {
    expect(promptTakesKey(key({ repeat: true }))).toBe(false);
    expect(promptTakesKey(key({ locked: true }))).toBe(false);
    expect(promptTakesKey(key({ visible: false }))).toBe(false);
    expect(promptTakesKey(key({ first: false }))).toBe(false);
    expect(promptTakesKey(key({ modifier: true }))).toBe(false);
  });

  it('laisse leurs touches aux champs et aux autres contrôles de la page', () => {
    expect(promptTakesKey(key({ targetTag: 'INPUT', targetInPrompt: true }))).toBe(false);
    expect(promptTakesKey(key({ targetTag: 'TEXTAREA', targetValue: 'npm test' }))).toBe(false);
    expect(promptTakesKey(key({ targetTag: 'TEXTAREA', targetInPrompt: true }))).toBe(false);
    expect(promptTakesKey(key({ targetTag: 'BUTTON' }))).toBe(false);
  });
});
