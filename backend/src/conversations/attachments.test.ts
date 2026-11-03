import { describe, expect, it } from 'vitest';
import { describeMessageAttachments, pickShownImages } from './attachments.js';

const file = (id: string, mediaType: string, size: number) => ({ id, name: `${id}.bin`, mediaType, size });

describe('fichiers joints aux messages', () => {
  it('montre les images dans la limite du nombre et du poids, jamais un autre type ni une image trop lourde', () => {
    const files = [file('a', 'image/png', 1000), file('b', 'application/pdf', 10), file('c', 'image/jpeg', 6 * 1024 * 1024), file('d', 'image/webp', 1000), file('e', 'image/gif', 1000)];
    expect(pickShownImages(files).map((f) => f.id)).toEqual(['a', 'd', 'e']);
    expect(pickShownImages(files, 2).map((f) => f.id)).toEqual(['a', 'd']);
    expect(pickShownImages(files, 10, 1500).map((f) => f.id)).toEqual(['a']);
  });

  it('nomme les fichiers et dit comment ils parviennent à l’agent', () => {
    const files = [file('a', 'image/png', 2048), file('b', 'text/plain', 10)];
    expect(describeMessageAttachments([])).toEqual([]);
    expect(describeMessageAttachments(files, { kind: 'instruction', ids: new Set(['a']) })).toEqual(['Fichiers joints :', '- a.bin (image/png, 2 Ko) — joint à cette instruction', '- b.bin (text/plain, 10 o)']);
    expect(describeMessageAttachments(files, { kind: 'tool', shown: new Set(['a']) })[1]).toContain('— montré ci-dessous');
  });
});
