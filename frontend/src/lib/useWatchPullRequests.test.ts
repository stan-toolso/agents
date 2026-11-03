import { describe, expect, it } from 'vitest';
import { watchSignature } from './useWatchPullRequests';

describe('watchSignature', () => {
  it('ne dépend pas de l’ordre et change quand une PR change d’étape, apparaît ou disparaît', () => {
    const a = watchSignature([{ id: '1', stage: 'TO_MERGE' }, { id: '2', stage: 'PENDING' }]);
    expect(watchSignature([{ id: '2', stage: 'PENDING' }, { id: '1', stage: 'TO_MERGE' }])).toBe(a);
    expect(watchSignature([{ id: '1', stage: 'MERGED' }, { id: '2', stage: 'PENDING' }])).not.toBe(a);
    expect(watchSignature([{ id: '1', stage: 'TO_MERGE' }])).not.toBe(a);
  });
});
